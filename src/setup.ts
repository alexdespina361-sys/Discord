import {
  DiscordApi,
  DiscordError,
  FLAG_GATEWAY_GUILD_MEMBERS,
  FLAG_GATEWAY_GUILD_MEMBERS_LIMITED,
  inviteUrl,
  portalUrl,
  userInstallUrl,
  type DiscordApplication,
  type DiscordCommand,
  type DiscordGuild,
} from "./discord";
import { bureauName, cfg, missingConfig, type Env } from "./env";
import type { GatewayStatus } from "./gateway";
import { renderTestDm } from "./messages";
import { WHAT_CHOICES, WHEN_CHOICES } from "./quick";
import type { Session } from "./session";
import { bureauStub, gatewayStub } from "./stub";

export type CheckState = "ok" | "todo" | "error" | "skip" | "info";

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail?: string;
  action?: { id: SetupAction; label: string };
  link?: { label: string; url: string };
  copy?: string;
}

export type SetupAction = "interactions" | "intent" | "commands" | "test-dm" | "user-install" | "relay-on" | "relay-off";

export const SETUP_ACTIONS: SetupAction[] = ["interactions", "intent", "commands", "test-dm", "user-install", "relay-on", "relay-off"];

export interface SetupReport {
  checks: Check[];
  ready: boolean;
  botName: string | null;
  guilds: DiscordGuild[];
  inviteUrl: string | null;
}

/** Commands work in servers and the bot's DM; with user installs enabled, also in anyone's DMs. */
export function commandDefinitions(userInstall: boolean): DiscordCommand[] {
  const integration_types = userInstall ? [0, 1] : [0];
  const contexts = userInstall ? [0, 1, 2] : [0, 1];
  return [
    {
      name: "bureau",
      description: "Your unanswered summonses, plus a link to issue new ones",
      type: 1,
      integration_types,
      contexts,
    },
    {
      name: "summon",
      description: "Issue an official summons right here",
      type: 1,
      integration_types,
      contexts,
      options: [
        { type: 6, name: "who", description: "Who to summon (leave empty for whoever you picked on the website)", required: false },
        { type: 3, name: "what", description: "What it's about (leave empty to post the one you prepared on the website)", required: false, choices: WHAT_CHOICES },
        { type: 3, name: "when", description: "When it starts (default: right now)", required: false, choices: WHEN_CHOICES },
        { type: 3, name: "title", description: "Your own title, e.g. Operation Pizza", required: false, max_length: 100 },
        { type: 3, name: "note", description: "Extra details for the objective", required: false, max_length: 300 },
      ],
    },
  ];
}

/** The parts of a command Discord stores that we care about, in a stable shape for comparing. */
function commandShape(c: DiscordCommand) {
  return {
    name: c.name,
    description: c.description,
    integration_types: [...(c.integration_types ?? [0])].sort(),
    contexts: [...(c.contexts ?? [])].sort(),
    options: (c.options ?? []).map((o) => ({
      type: o.type,
      name: o.name,
      description: o.description,
      required: Boolean(o.required),
      max_length: o.max_length ?? null,
      choices: (o.choices ?? []).map((ch) => `${ch.name}=${ch.value}`),
    })),
  };
}

/** Whether what's registered on Discord matches what this version of the code expects. */
export function commandsMatch(registered: DiscordCommand[], wanted: DiscordCommand[]): boolean {
  return wanted.every((w) => {
    const r = registered.find((c) => c.name === w.name);
    return r !== undefined && JSON.stringify(commandShape(r)) === JSON.stringify(commandShape(w));
  });
}

/** Changes whenever the command definitions in the code change (i.e. after a deploy that touched them). */
export async function commandsDigest(): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([commandDefinitions(false), commandDefinitions(true)]));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * After a deploy changes the commands, re-register them so people don't have to tap "Update" on the setup page.
 * Only touches commands someone already registered.
 */
export async function syncCommands(env: Env): Promise<void> {
  const bureau = bureauStub(env);
  const digest = await commandsDigest();
  if ((await bureau.commandsDigest()) === digest) return;
  const api = DiscordApi.bot(env);
  const app = await api.application();
  const registered = await api.commands(app.id);
  const wanted = commandDefinitions(userInstallEnabled(app));
  if (registered.length && !commandsMatch(registered, wanted)) await api.putCommands(app.id, wanted);
  await bureau.setCommandsDigest(digest);
}

export function userInstallEnabled(app: DiscordApplication): boolean {
  return Boolean(app.integration_types_config && "1" in app.integration_types_config);
}

const MEMBERS_INTENT = FLAG_GATEWAY_GUILD_MEMBERS | FLAG_GATEWAY_GUILD_MEMBERS_LIMITED;

export function interactionsUrl(origin: string): string {
  return `${origin}/interactions`;
}

export function redirectUrl(origin: string): string {
  return `${origin}/auth/callback`;
}

function describe(e: unknown): string {
  if (e instanceof DiscordError) return `${e.message} (HTTP ${e.status}${e.code ? `, code ${e.code}` : ""})`;
  return e instanceof Error ? e.message : String(e);
}

export async function runChecks(env: Env, origin: string, session: Session | null): Promise<SetupReport> {
  const checks: Check[] = [];
  const missing = missingConfig(env);
  const report: SetupReport = { checks, ready: false, botName: null, guilds: [], inviteUrl: null };

  checks.push(
    missing.length
      ? {
          id: "secrets",
          label: "Discord credentials added to Cloudflare",
          state: "todo",
          detail: `Missing: ${missing.join(", ")}. Add them as secrets on your Worker (Settings → Variables and Secrets).`,
          link: { label: "Open Discord Developer Portal", url: portalUrl(env) },
        }
      : { id: "secrets", label: "Discord credentials added to Cloudflare", state: "ok" },
  );
  if (!cfg(env, "DISCORD_BOT_TOKEN")) return report;

  const api = DiscordApi.bot(env);
  let app: DiscordApplication;
  try {
    const bot = await api.me();
    report.botName = bot.username;
    checks.push({ id: "token", label: "Bot token works", state: "ok", detail: `Signed in as ${bot.username}` });
    app = await api.application();
  } catch (e) {
    checks.push({
      id: "token",
      label: "Bot token works",
      state: "error",
      detail: `Discord rejected the bot token: ${describe(e)}. Reset it on the Bot page and paste the new one into DISCORD_BOT_TOKEN.`,
      link: { label: "Open Bot page", url: portalUrl(env, "bot") },
    });
    return report;
  }

  const appId = cfg(env, "DISCORD_APPLICATION_ID");
  const publicKey = cfg(env, "DISCORD_PUBLIC_KEY");
  const mismatches: string[] = [];
  if (appId && app.id !== appId) mismatches.push(`DISCORD_APPLICATION_ID should be ${app.id}`);
  if (publicKey && app.verify_key.toLowerCase() !== publicKey.toLowerCase()) {
    mismatches.push(`DISCORD_PUBLIC_KEY should be ${app.verify_key}`);
  }
  checks.push(
    mismatches.length
      ? {
          id: "app",
          label: "Application ID and public key match the bot",
          state: "error",
          detail: `${mismatches.join(". ")}.`,
          link: { label: "Open General Information", url: `https://discord.com/developers/applications/${app.id}/information` },
        }
      : { id: "app", label: "Application ID and public key match the bot", state: "ok", detail: app.name },
  );

  const wantInteractions = interactionsUrl(origin);
  checks.push(
    app.interactions_endpoint_url === wantInteractions
      ? { id: "interactions", label: "Discord sends button clicks here", state: "ok" }
      : {
          id: "interactions",
          label: "Discord sends button clicks here",
          state: "todo",
          detail: app.interactions_endpoint_url
            ? `Interactions Endpoint URL is currently ${app.interactions_endpoint_url}.`
            : "Interactions Endpoint URL is not set yet.",
          action: { id: "interactions", label: "Set it for me" },
          copy: wantInteractions,
        },
  );

  const wantRedirect = redirectUrl(origin);
  if (Array.isArray(app.redirect_uris)) {
    checks.push(
      app.redirect_uris.includes(wantRedirect)
        ? { id: "redirect", label: "“Log in with Discord” redirect registered", state: "ok" }
        : {
            id: "redirect",
            label: "“Log in with Discord” redirect registered",
            state: "todo",
            detail: "On the OAuth2 page, click “Add Redirect”, paste this URL and save.",
            copy: wantRedirect,
            link: { label: "Open OAuth2 page", url: `https://discord.com/developers/applications/${app.id}/oauth2` },
          },
    );
  } else {
    checks.push({
      id: "redirect",
      label: "“Log in with Discord” redirect registered",
      state: session ? "ok" : "skip",
      detail: session ? undefined : "Can't be checked automatically. Make sure this URL is listed under Redirects on the OAuth2 page.",
      copy: session ? undefined : wantRedirect,
      link: session ? undefined : { label: "Open OAuth2 page", url: `https://discord.com/developers/applications/${app.id}/oauth2` },
    });
  }

  checks.push(
    (app.flags ?? 0) & MEMBERS_INTENT
      ? { id: "intent", label: "Server Members Intent enabled (to list your friends)", state: "ok" }
      : {
          id: "intent",
          label: "Server Members Intent enabled (to list your friends)",
          state: "todo",
          detail: "Without it you'll have to search for people by name instead of picking from a list.",
          action: { id: "intent", label: "Enable it for me" },
          link: { label: "Open Bot page", url: `https://discord.com/developers/applications/${app.id}/bot` },
        },
  );

  report.inviteUrl = inviteUrl(env);
  try {
    report.guilds = await api.myGuilds();
  } catch (e) {
    checks.push({ id: "guild", label: "Bot added to your server", state: "error", detail: describe(e) });
  }
  if (!checks.some((c) => c.id === "guild")) {
    const names = session ? `: ${report.guilds.map((g) => g.name).join(", ")}` : "";
    checks.push(
      report.guilds.length
        ? {
            id: "guild",
            label: "Bot added to your server",
            state: "ok",
            detail: `In ${report.guilds.length} ${report.guilds.length === 1 ? "server" : "servers"}${names}`,
            link: { label: "Add to another server", url: report.inviteUrl },
          }
        : {
            id: "guild",
            label: "Bot added to your server",
            state: "todo",
            detail: "Add the bot to a server you share with your friends. It can only DM people it shares a server with.",
            link: { label: "Add bot to a server", url: report.inviteUrl },
          },
    );
  }

  const userInstall = userInstallEnabled(app);
  checks.push(
    userInstall
      ? { id: "user-install", label: "/summon allowed in personal DMs", state: "ok" }
      : {
          id: "user-install",
          label: "/summon allowed in personal DMs",
          state: "todo",
          detail: "Lets people add the Bureau to their own Discord account and use /summon in any DM.",
          action: { id: "user-install", label: "Enable it for me" },
          link: { label: "Open Installation page", url: `https://discord.com/developers/applications/${app.id}/installation` },
        },
  );

  try {
    const commands = await api.commands(app.id);
    const summon = commands.find((c) => c.name === "summon");
    const current = commandsMatch(commands, commandDefinitions(userInstall));
    checks.push(
      current
        ? { id: "commands", label: "/summon and /bureau commands registered", state: "ok" }
        : {
            id: "commands",
            label: "/summon and /bureau commands registered",
            state: "todo",
            detail: summon ? "They're from an older version of the Bureau. Update them." : "Lets people summon someone straight from Discord.",
            action: { id: "commands", label: summon ? "Update them" : "Register them" },
          },
    );
  } catch (e) {
    checks.push({ id: "commands", label: "/summon and /bureau commands registered", state: "error", detail: describe(e) });
  }

  if (userInstall) {
    checks.push({
      id: "add-to-account",
      label: "Add the Bureau to your own Discord account",
      state: "info",
      detail: "Each person who wants to use /summon in their DMs opens this link once and presses Authorize. The people being summoned don't need it.",
      link: { label: "Add to my account", url: userInstallUrl(env) },
    });
  }

  let relay: GatewayStatus | null = null;
  try {
    const gateway = gatewayStub(env);
    relay = await gateway.ensure();
    // A fresh connection is usually up within a second; wait briefly so the page shows the real state.
    for (let i = 0; i < 8 && relay.enabled && (relay.state === "connecting" || relay.state === "reconnecting"); i++) {
      await new Promise((r) => setTimeout(r, 250));
      relay = await gateway.status();
    }
  } catch (e) {
    checks.push({ id: "relay", label: "DM forwarding", state: "error", detail: describe(e) });
  }
  if (relay) {
    const since = relay.since ? ` since ${new Date(relay.since).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
    checks.push(
      !relay.enabled
        ? {
            id: "relay",
            label: "DM forwarding is off",
            state: "skip",
            detail: "Turn it on to pass whatever people type to the bot on to whoever summoned them.",
            action: { id: "relay-on", label: "Turn on" },
          }
        : relay.state === "connected"
          ? {
              id: "relay",
              label: "DM forwarding is live",
              state: "ok",
              detail: `Connected to Discord${since}. Replies people type to the bot are forwarded to whoever summoned them. Keeping this connection open uses most of Cloudflare's free daily allowance for always-on objects.`,
              action: { id: "relay-off", label: "Turn off" },
            }
          : relay.state === "error"
            ? {
                id: "relay",
                label: "DM forwarding can't connect",
                state: "error",
                detail: relay.error ?? "Unknown error",
                action: { id: "relay-on", label: "Try again" },
              }
            : {
                id: "relay",
                label: "DM forwarding is connecting…",
                state: "todo",
                detail: relay.error ? `Last problem: ${relay.error}. Reload in a few seconds.` : "Reload in a few seconds.",
                action: { id: "relay-off", label: "Turn off" },
              },
    );
  }

  checks.push(
    session
      ? {
          id: "login",
          label: "You're logged in",
          state: "ok",
          detail: `as ${session.name}. Send yourself a test DM to confirm the bot can reach you.`,
          action: { id: "test-dm", label: "Send me a test DM" },
        }
      : {
          id: "login",
          label: "You're logged in",
          state: "todo",
          detail: "Log in to send yourself a test DM.",
          link: { label: "Log in with Discord", url: "/auth/login?next=/setup" },
        },
  );

  const required = ["secrets", "token", "app", "interactions", "redirect", "guild"];
  report.ready = required.every((id) => {
    const c = checks.find((x) => x.id === id);
    return c && (c.state === "ok" || c.state === "skip");
  });
  return report;
}

export async function runAction(
  action: SetupAction,
  env: Env,
  origin: string,
  session: Session | null,
): Promise<{ ok: boolean; message: string }> {
  if (missingConfig(env).length) return { ok: false, message: "Add the Discord credentials first." };
  const api = DiscordApi.bot(env);
  try {
    switch (action) {
      case "interactions": {
        const url = interactionsUrl(origin);
        const app = await api.application();
        if (app.interactions_endpoint_url === url) return { ok: true, message: "Already set." };
        await api.editApplication({ interactions_endpoint_url: url });
        return { ok: true, message: "Discord verified this site and will send button clicks here." };
      }
      case "intent": {
        const app = await api.application();
        const flags = app.flags ?? 0;
        if (flags & MEMBERS_INTENT) return { ok: true, message: "Already enabled." };
        await api.editApplication({ flags: flags | FLAG_GATEWAY_GUILD_MEMBERS_LIMITED });
        return { ok: true, message: "Server Members Intent enabled." };
      }
      case "commands": {
        const app = await api.application();
        await api.putCommands(app.id, commandDefinitions(userInstallEnabled(app)));
        return { ok: true, message: "/summon and /bureau are registered. They can take a minute to show up in Discord." };
      }
      case "user-install": {
        const app = await api.application();
        if (!userInstallEnabled(app)) {
          const config = app.integration_types_config ?? {};
          await api.editApplication({ integration_types_config: { ...config, "0": config["0"] ?? {}, "1": config["1"] ?? {} } });
        }
        await api.putCommands(app.id, commandDefinitions(true));
        return { ok: true, message: "Done. Now open “Add to my account” on this page to use /summon in your DMs." };
      }
      case "relay-on":
      case "relay-off": {
        const on = action === "relay-on";
        await bureauStub(env).setRelay(on);
        const status = await gatewayStub(env).setEnabled(on);
        if (!on) return { ok: true, message: "DM forwarding is off." };
        return status.state === "error"
          ? { ok: false, message: status.error ?? "Couldn't connect to Discord." }
          : { ok: true, message: "DM forwarding is on. It takes a few seconds to connect." };
      }
      case "test-dm": {
        if (!session) return { ok: false, message: "Log in first." };
        await api.sendDm(session.uid, renderTestDm(bureauName(env)));
        return { ok: true, message: "Sent! Check your Discord DMs." };
      }
    }
  } catch (e) {
    let hint = "";
    if (e instanceof DiscordError && e.cannotDm) {
      hint = " The bot can only DM people it shares a server with, and your privacy settings for that server must allow DMs.";
    } else if (action === "interactions") {
      hint = " Make sure DISCORD_PUBLIC_KEY is right — Discord checks it before accepting the URL.";
    }
    return { ok: false, message: `${describe(e)}.${hint}` };
  }
}

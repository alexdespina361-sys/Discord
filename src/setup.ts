import {
  DiscordApi,
  DiscordError,
  FLAG_GATEWAY_GUILD_MEMBERS,
  FLAG_GATEWAY_GUILD_MEMBERS_LIMITED,
  inviteUrl,
  portalUrl,
  type DiscordApplication,
  type DiscordCommand,
  type DiscordGuild,
} from "./discord";
import { bureauName, cfg, missingConfig, type Env } from "./env";
import { renderTestDm } from "./messages";
import type { Session } from "./session";

export type CheckState = "ok" | "todo" | "error" | "skip";

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail?: string;
  action?: { id: SetupAction; label: string };
  link?: { label: string; url: string };
  copy?: string;
}

export type SetupAction = "interactions" | "intent" | "commands" | "test-dm";

export interface SetupReport {
  checks: Check[];
  ready: boolean;
  botName: string | null;
  guilds: DiscordGuild[];
  inviteUrl: string | null;
}

export const COMMANDS: DiscordCommand[] = [
  {
    name: "bureau",
    description: "Your unanswered summonses, plus a link to issue new ones",
    type: 1,
    integration_types: [0],
    contexts: [0, 1],
  },
];

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

  try {
    const commands = await api.commands(app.id);
    checks.push(
      commands.some((c) => c.name === "bureau")
        ? { id: "commands", label: "/bureau command registered", state: "ok" }
        : {
            id: "commands",
            label: "/bureau command registered",
            state: "todo",
            detail: "Optional. Lets people type /bureau in Discord to see unanswered summonses.",
            action: { id: "commands", label: "Register it" },
          },
    );
  } catch (e) {
    checks.push({ id: "commands", label: "/bureau command registered", state: "error", detail: describe(e) });
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
        await api.putCommands(cfg(env, "DISCORD_APPLICATION_ID"), COMMANDS);
        return { ok: true, message: "/bureau is registered. It can take a minute to show up in Discord." };
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

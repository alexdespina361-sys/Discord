import { verifyDiscordSignature } from "./crypto";
import { allowedOrganizers, bureauName, cfg, type Env } from "./env";
import { NEEDS_NOTE, RESPONSE_KINDS, type Invite, type Person, type ResponseKind, type Summons, type Verdict } from "./model";
import { EPHEMERAL, clip, renderModal, renderResponseNotice, renderSummons, ts, type MessagePayload } from "./messages";
import { DiscordApi, avatarUrl, messageLink } from "./discord";
import type { RespondFailure } from "./bureau";
import { quickDraft } from "./quick";
import { bureauStub } from "./stub";

const enum InteractionType {
  Ping = 1,
  ApplicationCommand = 2,
  MessageComponent = 3,
  ModalSubmit = 5,
}

const enum Callback {
  Pong = 1,
  ChannelMessage = 4,
  DeferredChannelMessage = 5,
  UpdateMessage = 7,
  Modal = 9,
}

/** Where a command was used: a server, the bot's own DM, or any other DM / group DM. */
const enum Context {
  Guild = 0,
  BotDm = 1,
  PrivateChannel = 2,
}

interface InteractionUser {
  id: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

interface CommandOption {
  name: string;
  value?: string | number | boolean;
}

interface Interaction {
  type: number;
  token: string;
  application_id?: string;
  context?: number;
  data?: {
    name?: string;
    custom_id?: string;
    components?: unknown[];
    options?: CommandOption[];
    resolved?: { users?: Record<string, InteractionUser> };
  };
  user?: InteractionUser;
  member?: { user?: InteractionUser };
  message?: { id: string; channel_id?: string };
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
}

function reply(body: unknown): Response {
  return Response.json(body);
}

function ephemeral(content: string, extra: Partial<MessagePayload> = {}): Response {
  return reply({ type: Callback.ChannelMessage, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra } });
}

function update(message: MessagePayload): Response {
  return reply({ type: Callback.UpdateMessage, data: message });
}

const FAILURE_TEXT: Record<RespondFailure, string> = {
  not_found: "🗂️ This summons could not be located in the Bureau's archives.",
  not_recipient: "🚫 This summons is not addressed to you. Unauthorized interference has been logged.",
  inactive: "📁 This file is closed. The Bureau is no longer accepting responses to this summons.",
  option_disabled: "❓ That response option is not available for this summons.",
};

/** Pulls a text input's value out of a modal submission (Label-wrapped or legacy Action Row). */
export function findInputValue(components: unknown, customId: string): string | null {
  if (!components || typeof components !== "object") return null;
  if (Array.isArray(components)) {
    for (const c of components) {
      const v = findInputValue(c, customId);
      if (v !== null) return v;
    }
    return null;
  }
  const c = components as { custom_id?: string; value?: unknown; component?: unknown; components?: unknown };
  if (c.custom_id === customId && typeof c.value === "string") return c.value;
  return findInputValue(c.component, customId) ?? findInputValue(c.components, customId);
}

function addresseesFor(invites: Invite[], messageId: string | undefined, fallback: Invite): Invite[] {
  const on = messageId ? invites.filter((i) => i.messageId === messageId) : [];
  return on.length ? on : [fallback];
}

export async function handleInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  const valid = await verifyDiscordSignature(
    cfg(env, "DISCORD_PUBLIC_KEY"),
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    body,
  );
  if (!valid) return new Response("invalid request signature", { status: 401 });

  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === InteractionType.Ping) return reply({ type: Callback.Pong });

  const origin = new URL(request.url).origin;
  try {
    switch (interaction.type) {
      case InteractionType.ApplicationCommand:
        return await handleCommand(interaction, env, origin, ctx);
      case InteractionType.MessageComponent:
        return await handleComponent(interaction, env);
      case InteractionType.ModalSubmit:
        return await handleModal(interaction, env);
      default:
        return ephemeral("This kind of request is not handled by the Bureau.");
    }
  } catch (e) {
    console.error("interaction failed", e);
    return ephemeral(`⚠️ The Bureau's filing system jammed: ${clip(e instanceof Error ? e.message : String(e), 200)}`);
  }
}

function actor(interaction: Interaction): InteractionUser {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) throw new Error("Interaction without a user");
  return user;
}

function person(user: InteractionUser): Person {
  return { id: user.id, name: user.global_name || user.username || "Unknown", avatar: avatarUrl({ id: user.id, avatar: user.avatar ?? null }) };
}

/** The interaction's token lets us edit this message and post in this chat for the next 15 minutes. */
function viaOf(interaction: Interaction) {
  return { messageId: interaction.message?.id ?? null, token: interaction.token };
}

/** A click on a summons that's no longer active: show its final state instead of stale buttons. */
function closedView(summons: Summons, invites: Invite[], interaction: Interaction, userId: string, env: Env): Response {
  const mine = invites.find((i) => i.recipient.id === userId) ?? invites[0]!;
  return update(renderSummons(summons, invites, addresseesFor(invites, interaction.message?.id, mine), bureauName(env)));
}

async function handleComponent(interaction: Interaction, env: Env): Promise<Response> {
  const [prefix, id, arg] = (interaction.data?.custom_id ?? "").split(":");
  const user = actor(interaction);
  const bureau = bureauStub(env);
  const stale = ephemeral("This button is out of date.");
  if (!id) return stale;

  if (prefix === "r") {
    const kind = arg as ResponseKind;
    if (!RESPONSE_KINDS.includes(kind)) return stale;

    if (NEEDS_NOTE[kind]) {
      const dossier = await bureau.get(id);
      if (!dossier) return ephemeral(FAILURE_TEXT.not_found);
      const invite = dossier.invites.find((i) => i.recipient.id === user.id);
      if (!invite) return ephemeral(FAILURE_TEXT.not_recipient);
      if (dossier.summons.status !== "active") return closedView(dossier.summons, dossier.invites, interaction, user.id, env);
      const modal = renderModal(dossier.summons, kind as "excuse" | "extend");
      // Pre-fill what they wrote last time if they're amending the same kind of response.
      if (invite.status === kind && invite.note) {
        const input = (modal.components[1] as { component: { value?: string } }).component;
        input.value = invite.note;
      }
      return reply({ type: Callback.Modal, data: modal });
    }

    const result = await bureau.respond(id, user.id, kind, null, viaOf(interaction));
    if (!result.ok) {
      if (result.reason === "inactive" && result.summons && result.invites) return closedView(result.summons, result.invites, interaction, user.id, env);
      return ephemeral(FAILURE_TEXT[result.reason]);
    }
    const addressees = addresseesFor(result.invites, interaction.message?.id, result.invite);
    return update(renderSummons(result.summons, result.invites, addressees, bureauName(env), Date.now(), { relay: result.relay }));
  }

  if (prefix === "n") {
    const result = await bureau.ringBell(id, user.id, viaOf(interaction));
    if (!result.ok) {
      if (result.reason === "inactive" && result.summons && result.invites) return closedView(result.summons, result.invites, interaction, user.id, env);
      const text = {
        not_found: FAILURE_TEXT.not_found,
        not_organizer: "🔔 Only the issuing officer can ring the bell. Nice try.",
        inactive: FAILURE_TEXT.inactive,
        answered: `✅ ${result.invite?.recipient.name ?? "They"} already answered. No bell required.`,
        cooldown: "🔔 The bell is still ringing. Give it a minute.",
      }[result.reason];
      return ephemeral(text);
    }
    return update(renderSummons(result.summons, result.invites, [result.invite], bureauName(env)));
  }

  if (prefix === "x" || prefix === "xs") {
    const verdict = arg as Verdict;
    if (verdict !== "granted" && verdict !== "denied") return stale;
    const result = await bureau.verdict(id, user.id, verdict, prefix === "xs" ? viaOf(interaction) : null);
    if (!result.ok) {
      const text = {
        not_found: FAILURE_TEXT.not_found,
        not_organizer: "🚫 Only the issuing officer may rule on extension requests.",
        not_pending: "📁 This extension request is no longer pending — they have since changed their response.",
      }[result.reason];
      return ephemeral(text);
    }
    // "xs" buttons sit on the summons itself (in a shared chat); "x" ones on the issuer's notice DM.
    if (prefix === "xs") return update(renderSummons(result.summons, result.invites, [result.invite], bureauName(env)));
    return update(
      renderResponseNotice(result.summons, result.invites, result.invite, result.invite.status, bureauName(env), { relay: result.relay }),
    );
  }

  return stale;
}

async function handleModal(interaction: Interaction, env: Env): Promise<Response> {
  const [prefix, id, kind] = (interaction.data?.custom_id ?? "").split(":");
  if (prefix !== "m" || !id || (kind !== "excuse" && kind !== "extend")) return ephemeral("This form is out of date.");
  const user = actor(interaction);
  const note = findInputValue(interaction.data?.components, "note");
  if (!note?.trim()) return ephemeral("The Committee does not accept blank forms.");

  const result = await bureauStub(env).respond(id, user.id, kind, note, viaOf(interaction));
  if (!result.ok) {
    if (result.reason === "inactive" && result.summons && result.invites && interaction.message) {
      return closedView(result.summons, result.invites, interaction, user.id, env);
    }
    return ephemeral(FAILURE_TEXT[result.reason]);
  }
  if (!interaction.message) return ephemeral("📝 Your statement has been filed with the Committee.");
  const addressees = addresseesFor(result.invites, interaction.message.id, result.invite);
  return update(renderSummons(result.summons, result.invites, addressees, bureauName(env), Date.now(), { relay: result.relay }));
}

async function handleCommand(interaction: Interaction, env: Env, origin: string, ctx: ExecutionContext): Promise<Response> {
  switch (interaction.data?.name) {
    case "bureau":
      return handleBureau(interaction, env, origin);
    case "summon":
      return handleSummon(interaction, env, origin, ctx);
    default:
      return ephemeral("Unknown command.");
  }
}

async function handleBureau(interaction: Interaction, env: Env, origin: string): Promise<Response> {
  const user = actor(interaction);
  const pending = await bureauStub(env).pendingFor(user.id);
  const bureau = bureauName(env);

  const lines = pending.map(({ summons, invites }) => {
    const invite = invites.find((i) => i.recipient.id === user.id);
    const inGuild = invite?.deliveredVia === "channel" || (invite?.deliveredVia === "interaction" && Boolean(summons.guildId));
    const where =
      invite?.channelId && invite.messageId
        ? ` · [open](${messageLink(inGuild ? summons.guildId : null, invite.channelId, invite.messageId)})`
        : "";
    return `• **${summons.ref}** — ${clip(summons.title, 80)} · ${ts(summons.startsAt, "R")}${where}`;
  });

  return ephemeral(
    pending.length
      ? `🏛️ **${bureau}**\n\n📭 You have **${pending.length}** unanswered ${pending.length === 1 ? "summons" : "summonses"}:\n${lines.join("\n")}`
      : `🏛️ **${bureau}**\n\nYour record is clean: no unanswered summonses. Issue one to someone else instead.`,
    {
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 5, label: "Issue a summons", emoji: { name: "📨" }, url: `${origin}/new` },
            { type: 2, style: 5, label: "My dossiers", emoji: { name: "🗂️" }, url: `${origin}/` },
          ],
        },
      ],
    },
  );
}

function optionValues(options: CommandOption[] | undefined): Record<string, string> {
  return Object.fromEntries((options ?? []).map((o) => [o.name, o.value === undefined ? "" : String(o.value)]));
}

/** /summon: post an official summons right here, in whatever chat it was used in. */
async function handleSummon(interaction: Interaction, env: Env, origin: string, ctx: ExecutionContext): Promise<Response> {
  const issuer = actor(interaction);
  const allowed = allowedOrganizers(env);
  if (allowed && !allowed.has(issuer.id)) return ephemeral("🚫 You're not on the list of officers allowed to issue summonses.");

  const options = optionValues(interaction.data?.options);
  const target = interaction.data?.resolved?.users?.[options.who ?? ""];
  if (!target) return ephemeral("Pick someone to summon.");
  if (target.bot) return ephemeral("🤖 Bots cannot be summoned. They're always available anyway.");

  const draft = quickDraft(
    {
      what: options.what ?? "custom",
      minutes: Number(options.when ?? 0),
      title: options.title,
      note: options.note,
      guildId: interaction.guild_id ?? "",
      recipients: [target.id],
    },
    Date.now(),
  );
  const organizer = person(issuer);
  const recipient = person(target);
  const bureau = bureauStub(env);

  if (interaction.context === Context.BotDm) {
    // Nobody else can see the bot's own DM with you, so deliver it to them by the bot's DM instead.
    ctx.waitUntil(
      (async () => {
        let content: string;
        try {
          const result = await bureau.issue({ ...draft, delivery: "dm" }, { organizer, guildName: "", recipients: [recipient], origin });
          const d = result.deliveries[0];
          content =
            d?.deliveredVia === "dm"
              ? `📨 Summons **${result.summons.ref}** delivered to **${recipient.name}** by DM. [Open the dossier](${origin}/s/${result.summons.id})`
              : `⚠️ Couldn't DM **${recipient.name}** (${d?.error ?? "unknown error"}). The bot can only DM people it shares a server with — try /summon in your own DM with them.`;
        } catch (e) {
          content = `⚠️ ${e instanceof Error ? e.message : String(e)}`;
        }
        await DiscordApi.webhooks(env)
          .editOriginal(cfg(env, "DISCORD_APPLICATION_ID"), interaction.token, { content, allowed_mentions: { parse: [] } })
          .catch((e) => console.error("couldn't report /summon result", e));
      })(),
    );
    return reply({ type: Callback.DeferredChannelMessage, data: { flags: EPHEMERAL } });
  }

  const channelId = interaction.channel_id ?? interaction.channel?.id;
  if (!channelId) return ephemeral("Discord didn't say which chat this is. Try again.");
  try {
    const { summons, invites } = await bureau.issueHere(
      { ...draft, delivery: "interaction", channelId },
      { organizer, guildName: "", recipients: [recipient], origin, channelId, guildId: interaction.guild_id ?? null, token: interaction.token },
    );
    return reply({ type: Callback.ChannelMessage, data: renderSummons(summons, invites, invites, bureauName(env)) });
  } catch (e) {
    return ephemeral(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
  }
}

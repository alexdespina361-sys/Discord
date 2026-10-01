import { verifyDiscordSignature } from "./crypto";
import { bureauName, cfg, type Env } from "./env";
import { NEEDS_NOTE, RESPONSE_KINDS, type Invite, type ResponseKind, type Verdict } from "./model";
import { EPHEMERAL, clip, renderModal, renderResponseNotice, renderSummons, ts, type MessagePayload } from "./messages";
import { messageLink } from "./discord";
import type { RespondFailure } from "./bureau";
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
  UpdateMessage = 7,
  Modal = 9,
}

interface InteractionUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

interface Interaction {
  type: number;
  data?: {
    name?: string;
    custom_id?: string;
    components?: unknown[];
  };
  user?: InteractionUser;
  member?: { user?: InteractionUser };
  message?: { id: string; channel_id?: string };
  guild_id?: string;
}

function reply(body: unknown): Response {
  return Response.json(body);
}

function ephemeral(content: string, extra: Partial<MessagePayload> = {}): Response {
  return reply({ type: Callback.ChannelMessage, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra } });
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

export async function handleInteraction(request: Request, env: Env): Promise<Response> {
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
        return await handleCommand(interaction, env, origin);
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

async function handleComponent(interaction: Interaction, env: Env): Promise<Response> {
  const [prefix, id, arg] = (interaction.data?.custom_id ?? "").split(":");
  const user = actor(interaction);
  const bureau = bureauStub(env);
  if (!id || !arg) return ephemeral("This button is out of date.");

  if (prefix === "r") {
    const kind = arg as ResponseKind;
    if (!RESPONSE_KINDS.includes(kind)) return ephemeral("This button is out of date.");

    if (NEEDS_NOTE[kind]) {
      const dossier = await bureau.get(id);
      if (!dossier) return ephemeral(FAILURE_TEXT.not_found);
      const invite = dossier.invites.find((i) => i.recipient.id === user.id);
      if (!invite) return ephemeral(FAILURE_TEXT.not_recipient);
      if (dossier.summons.status !== "active") return ephemeral(FAILURE_TEXT.inactive);
      const modal = renderModal(dossier.summons, kind as "excuse" | "extend");
      // Pre-fill what they wrote last time if they're amending the same kind of response.
      if (invite.status === kind && invite.note) {
        const input = (modal.components[1] as { component: { value?: string } }).component;
        input.value = invite.note;
      }
      return reply({ type: Callback.Modal, data: modal });
    }

    const result = await bureau.respond(id, user.id, kind, null, interaction.message?.id ?? null);
    if (!result.ok) return ephemeral(FAILURE_TEXT[result.reason]);
    const addressees = addresseesFor(result.invites, interaction.message?.id, result.invite);
    return reply({
      type: Callback.UpdateMessage,
      data: renderSummons(result.summons, result.invites, addressees, bureauName(env)),
    });
  }

  if (prefix === "x") {
    const verdict = arg as Verdict;
    if (verdict !== "granted" && verdict !== "denied") return ephemeral("This button is out of date.");
    const result = await bureau.verdict(id, user.id, verdict);
    if (!result.ok) {
      const text = {
        not_found: FAILURE_TEXT.not_found,
        not_organizer: "🚫 Only the issuing officer may rule on extension requests.",
        not_pending: "📁 This extension request is no longer pending — they have since changed their response.",
      }[result.reason];
      return ephemeral(text);
    }
    return reply({
      type: Callback.UpdateMessage,
      data: renderResponseNotice(result.summons, result.invites, result.invite, result.invite.status, bureauName(env)),
    });
  }

  return ephemeral("This button is out of date.");
}

async function handleModal(interaction: Interaction, env: Env): Promise<Response> {
  const [prefix, id, kind] = (interaction.data?.custom_id ?? "").split(":");
  if (prefix !== "m" || !id || (kind !== "excuse" && kind !== "extend")) return ephemeral("This form is out of date.");
  const user = actor(interaction);
  const note = findInputValue(interaction.data?.components, "note");
  if (!note?.trim()) return ephemeral("The Committee does not accept blank forms.");

  const result = await bureauStub(env).respond(id, user.id, kind, note, interaction.message?.id ?? null);
  if (!result.ok) return ephemeral(FAILURE_TEXT[result.reason]);
  if (!interaction.message) return ephemeral("📝 Your statement has been filed with the Committee.");
  const addressees = addresseesFor(result.invites, interaction.message.id, result.invite);
  return reply({
    type: Callback.UpdateMessage,
    data: renderSummons(result.summons, result.invites, addressees, bureauName(env)),
  });
}

async function handleCommand(interaction: Interaction, env: Env, origin: string): Promise<Response> {
  if (interaction.data?.name !== "bureau") return ephemeral("Unknown command.");
  const user = actor(interaction);
  const pending = await bureauStub(env).pendingFor(user.id);
  const bureau = bureauName(env);

  const lines = pending.map(({ summons, invites }) => {
    const invite = invites.find((i) => i.recipient.id === user.id);
    const where =
      invite?.channelId && invite.messageId
        ? ` · [open](${messageLink(invite.deliveredVia === "channel" ? summons.guildId : null, invite.channelId, invite.messageId)})`
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

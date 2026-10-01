import {
  CHANNEL_TYPE_GUILD_ANNOUNCEMENT,
  CHANNEL_TYPE_GUILD_TEXT,
  DiscordApi,
  DiscordError,
  ERR_MISSING_ACCESS,
  ERR_UNKNOWN_MEMBER,
  avatarUrl,
  displayName,
  type DiscordMember,
} from "../discord";
import { allowedOrganizers, bureauName, type Env } from "../env";
import {
  DEFAULT_OPTIONS,
  PRIORITIES,
  RESPONSE_KINDS,
  ValidationError,
  validateDraft,
  type Invite,
  type Person,
  type ResponseKind,
  type ResponseOption,
  type Summons,
} from "../model";
import { clip, renderSummons, renderSummonsText } from "../messages";
import type { Session } from "../session";
import { bureauStub } from "../stub";

export interface DirectoryMember {
  id: string;
  name: string;
  username: string;
  avatar: string;
}

export function jsonError(status: number, error: string, field?: string): Response {
  return Response.json({ error, field }, { status });
}

/** Guilds the bot is in that the user is also a member of. */
export async function sharedGuilds(env: Env, userId: string) {
  const api = DiscordApi.bot(env);
  const guilds = (await api.myGuilds()).slice(0, 10);
  const checks = await Promise.all(
    guilds.map(async (g) => {
      try {
        await api.member(g.id, userId);
        return g;
      } catch (e) {
        if (e instanceof DiscordError && (e.code === ERR_UNKNOWN_MEMBER || e.status === 404)) return null;
        throw e;
      }
    }),
  );
  return checks.filter((g): g is NonNullable<typeof g> => g !== null).map((g) => ({ id: g.id, name: g.name }));
}

function toDirectoryMember(m: DiscordMember): DirectoryMember | null {
  if (!m.user || m.user.bot) return null;
  return { id: m.user.id, name: displayName(m.user, m), username: m.user.username, avatar: avatarUrl(m.user) };
}

async function requireMember(api: DiscordApi, guildId: string, userId: string): Promise<DiscordMember | null> {
  try {
    return await api.member(guildId, userId);
  } catch (e) {
    if (e instanceof DiscordError && (e.code === ERR_UNKNOWN_MEMBER || e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

export async function directory(env: Env, session: Session, guildId: string): Promise<Response> {
  const api = DiscordApi.bot(env);
  if (!(await requireMember(api, guildId, session.uid))) return jsonError(403, "You're not a member of that server.");

  let mode: "list" | "search" = "list";
  let members: DirectoryMember[] = [];
  try {
    members = (await api.listMembers(guildId)).map(toDirectoryMember).filter((m): m is DirectoryMember => m !== null);
  } catch (e) {
    if (!(e instanceof DiscordError && (e.code === ERR_MISSING_ACCESS || e.status === 403))) throw e;
    mode = "search";
  }
  members.sort((a, b) => a.name.localeCompare(b.name));

  const channels = (await api.channels(guildId))
    .filter((c) => c.type === CHANNEL_TYPE_GUILD_TEXT || c.type === CHANNEL_TYPE_GUILD_ANNOUNCEMENT)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({ id: c.id, name: c.name ?? c.id }));

  return Response.json({ mode, members, channels });
}

export async function searchMembers(env: Env, session: Session, guildId: string, query: string): Promise<Response> {
  const api = DiscordApi.bot(env);
  if (!(await requireMember(api, guildId, session.uid))) return jsonError(403, "You're not a member of that server.");
  const q = query.trim();
  if (!q) return Response.json({ members: [] });
  const members = (await api.searchMembers(guildId, q)).map(toDirectoryMember).filter((m): m is DirectoryMember => m !== null);
  return Response.json({ members });
}

/** Renders the Discord message for the compose form's live preview. Lenient: drafts are often half-filled. */
export function preview(env: Env, session: Session, input: Record<string, unknown>, origin: string): Response {
  const text = (v: unknown, max: number, fallback = "") => clip(typeof v === "string" && v.trim() ? v.trim() : fallback, max);
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const now = Date.now();

  const options: ResponseOption[] = Array.isArray(input.options)
    ? (input.options as Record<string, unknown>[])
        .filter((o) => RESPONSE_KINDS.includes(o?.kind as ResponseKind))
        .map((o) => ({ kind: o.kind as ResponseKind, label: text(o.label, 40, "…"), emoji: typeof o.emoji === "string" ? o.emoji : "" }))
    : DEFAULT_OPTIONS;

  const recipients = (Array.isArray(input.recipients) ? input.recipients : []).filter(
    (r): r is string => typeof r === "string" && /^\d{15,21}$/.test(r),
  );
  const ids = recipients.length ? recipients.slice(0, 10) : ["0"];

  const summons: Summons = {
    id: "preview",
    ref: "BMA-0000-0000",
    organizer: { id: session.uid, name: session.name, avatar: session.avatar },
    guildId: "0",
    guildName: "",
    classification: text(input.classification, 80, "OFFICIAL SUMMONS").toUpperCase(),
    title: text(input.title, 100, "Untitled operation"),
    objective: text(input.objective, 1000),
    location: text(input.location, 100),
    startsAt: num(input.startsAt, now + 3_600_000),
    durationMin: Math.max(5, num(input.durationMin, 60)),
    priority: PRIORITIES.includes(input.priority as never) ? (input.priority as Summons["priority"]) : "routine",
    dressCode: text(input.dressCode, 80),
    signatureTitle: text(input.signatureTitle, 60),
    respondBy: typeof input.respondBy === "number" ? input.respondBy : null,
    options: options.length ? options : DEFAULT_OPTIONS,
    delivery: input.delivery === "channel" ? "channel" : "dm",
    channelId: null,
    escalation: "standard",
    remindBeforeMin: 0,
    reminderSent: false,
    scheduledEventId: null,
    status: "active",
    origin,
    createdAt: now,
    endedAt: null,
  };
  const invites: Invite[] = ids.map((id, index) => ({
    id: `preview-${index}`,
    summonsId: "preview",
    recipient: { id, name: "", avatar: null },
    deliveredVia: "pending",
    channelId: null,
    messageId: null,
    status: "pending",
    note: null,
    respondedAt: null,
    nudgesSent: 0,
    nextNudgeAt: null,
    verdict: null,
    error: null,
  }));
  const addressees = summons.delivery === "channel" ? invites : invites.slice(0, 1);
  return Response.json({
    message: renderSummons(summons, invites, addressees, bureauName(env), now),
    text: renderSummonsText(summons, recipients, bureauName(env)),
  });
}

export async function createSummons(
  env: Env,
  session: Session,
  input: unknown,
  origin: string,
): Promise<Response> {
  const allowed = allowedOrganizers(env);
  if (allowed && !allowed.has(session.uid)) {
    return jsonError(403, "You're not on the list of officers allowed to issue summonses.");
  }

  let draft;
  try {
    draft = validateDraft(input, Date.now());
  } catch (e) {
    if (e instanceof ValidationError) return jsonError(400, e.message, e.field);
    throw e;
  }

  const api = DiscordApi.bot(env);
  let guildName: string;
  try {
    guildName = (await api.guild(draft.guildId)).name;
  } catch {
    return jsonError(400, "The bot isn't in that server anymore.", "guildId");
  }
  const organizerMember = await requireMember(api, draft.guildId, session.uid);
  if (!organizerMember) return jsonError(403, "You're not a member of that server.", "guildId");

  const recipients: Person[] = [];
  for (const id of draft.recipients) {
    const member = await requireMember(api, draft.guildId, id);
    if (!member?.user) return jsonError(400, `Someone you picked (${id}) isn't in that server.`, "recipients");
    if (member.user.bot) return jsonError(400, `${displayName(member.user, member)} is a bot. Bots cannot be summoned.`, "recipients");
    recipients.push({ id, name: displayName(member.user, member), avatar: avatarUrl(member.user) });
  }

  const organizer: Person = {
    id: session.uid,
    name: organizerMember.user ? displayName(organizerMember.user, organizerMember) : session.name,
    avatar: session.avatar,
  };

  try {
    const result = await bureauStub(env).issue(draft, { organizer, guildName, recipients, origin });
    return Response.json({
      id: result.summons.id,
      ref: result.summons.ref,
      deliveries: result.deliveries,
      warnings: result.warnings,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("too many")) return jsonError(429, message);
    throw e;
  }
}

export async function organizerAction(
  env: Env,
  session: Session,
  summonsId: string,
  action: "cancel" | "nudge",
): Promise<Response> {
  const bureau = bureauStub(env);
  const result = action === "cancel" ? await bureau.cancel(summonsId, session.uid) : await bureau.nudgeNow(summonsId, session.uid);
  if (!result.ok) return jsonError(400, result.reason);
  const message =
    action === "cancel"
      ? "Summons cancelled. Everyone has been released from duty."
      : `Reminder sent to ${result.count} ${result.count === 1 ? "person" : "people"}.`;
  return Response.json({ ok: true, message });
}

export async function respondOnWeb(env: Env, session: Session, summonsId: string, input: unknown): Promise<Response> {
  const body = (input ?? {}) as { kind?: unknown; note?: unknown };
  const kind = body.kind as ResponseKind;
  if (!RESPONSE_KINDS.includes(kind)) return jsonError(400, "Pick a response.");
  const note = typeof body.note === "string" ? body.note : null;
  if ((kind === "excuse" || kind === "extend") && !note?.trim()) {
    return jsonError(400, kind === "excuse" ? "The Committee requires an excuse in writing." : "Say how much extra time you need.", "note");
  }
  const result = await bureauStub(env).respond(summonsId, session.uid, kind, note, null);
  if (!result.ok) {
    const text = {
      not_found: "Summons not found.",
      not_recipient: "This summons isn't addressed to you.",
      inactive: "This file is closed.",
      option_disabled: "That option isn't available.",
    }[result.reason];
    return jsonError(400, text);
  }
  return Response.json({ ok: true, message: "Response filed. The issuing officer has been notified." });
}

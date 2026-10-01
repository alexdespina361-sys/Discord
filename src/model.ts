export type ResponseKind = "yes" | "no" | "excuse" | "extend";
export type InviteStatus = "pending" | ResponseKind;
export type SummonsStatus = "active" | "cancelled" | "closed";
export type Priority = "routine" | "elevated" | "high" | "critical";
/** "interaction": posted by /summon in whatever chat it was used in (often a personal DM). */
export type Delivery = "dm" | "channel" | "interaction";
export type Escalation = "off" | "gentle" | "standard" | "relentless";
export type Verdict = "granted" | "denied";

export const RESPONSE_KINDS: ResponseKind[] = ["yes", "no", "excuse", "extend"];
export const PRIORITIES: Priority[] = ["routine", "elevated", "high", "critical"];
export const ESCALATIONS: Escalation[] = ["off", "gentle", "standard", "relentless"];
export const REMIND_OPTIONS = [0, 5, 10, 15, 30, 60, 120] as const;
export const MAX_RECIPIENTS = 10;

/** Kinds that open a form so the recipient can explain themselves. */
export const NEEDS_NOTE: Record<ResponseKind, boolean> = { yes: false, no: false, excuse: true, extend: true };

export interface ResponseOption {
  kind: ResponseKind;
  label: string;
  emoji: string;
}

export const DEFAULT_OPTIONS: ResponseOption[] = [
  { kind: "yes", label: "Accept Mission", emoji: "🫡" },
  { kind: "no", label: "Decline Assignment", emoji: "❌" },
  { kind: "excuse", label: "Provide Weak Excuse", emoji: "🤡" },
  { kind: "extend", label: "Request Extension", emoji: "⏳" },
];

/** Emoji the compose form offers for buttons. Restricting to a known list keeps Discord from rejecting a message. */
export const BUTTON_EMOJI = [
  "🫡", "✅", "👍", "🙋", "🫶", "💪", "🚀", "🎮", "🛒", "🍕",
  "❌", "👎", "🙅", "🚫", "💀", "😴", "🛌", "🤡", "🥺", "🤒",
  "🐈", "🥱", "⏳", "⌛", "🕐", "🐢", "🙏", "📝", "🤷", "❓",
] as const;

export interface PriorityInfo {
  label: string;
  color: number;
  emoji: string;
}

export const PRIORITY_INFO: Record<Priority, PriorityInfo> = {
  routine: { label: "ROUTINE", color: 0x5865f2, emoji: "🔵" },
  elevated: { label: "ELEVATED", color: 0xfee75c, emoji: "🟡" },
  high: { label: "HIGH", color: 0xf0883e, emoji: "🟠" },
  critical: { label: "CRITICAL", color: 0xed4245, emoji: "🔴" },
};

export interface EscalationInfo {
  label: string;
  description: string;
  intervalMin: number;
  maxNotices: number;
}

export const ESCALATION_INFO: Record<Escalation, EscalationInfo> = {
  off: { label: "None", description: "One summons, no follow-ups", intervalMin: 0, maxNotices: 0 },
  gentle: { label: "Gentle", description: "Re-notify every 3 hours, up to 2 times", intervalMin: 180, maxNotices: 2 },
  standard: { label: "Standard", description: "Re-notify every 45 minutes, up to 3 times", intervalMin: 45, maxNotices: 3 },
  relentless: { label: "Relentless", description: "Re-notify every 10 minutes, up to 6 times", intervalMin: 10, maxNotices: 6 },
};

export interface SummonsDraft {
  guildId: string;
  recipients: string[];
  classification: string;
  title: string;
  objective: string;
  location: string;
  startsAt: number;
  durationMin: number;
  priority: Priority;
  dressCode: string;
  signatureTitle: string;
  respondBy: number | null;
  options: ResponseOption[];
  delivery: Delivery;
  channelId: string | null;
  escalation: Escalation;
  remindBeforeMin: number;
  createScheduledEvent: boolean;
}

export interface Person {
  id: string;
  name: string;
  avatar: string | null;
}

export interface Summons {
  id: string;
  ref: string;
  organizer: Person;
  guildId: string;
  guildName: string;
  classification: string;
  title: string;
  objective: string;
  location: string;
  startsAt: number;
  durationMin: number;
  priority: Priority;
  dressCode: string;
  signatureTitle: string;
  respondBy: number | null;
  options: ResponseOption[];
  delivery: Delivery;
  channelId: string | null;
  escalation: Escalation;
  remindBeforeMin: number;
  reminderSent: boolean;
  scheduledEventId: string | null;
  status: SummonsStatus;
  origin: string;
  createdAt: number;
  endedAt: number | null;
}

export interface Invite {
  id: string;
  summonsId: string;
  recipient: Person;
  deliveredVia: "pending" | "dm" | "channel" | "failed" | "interaction";
  channelId: string | null;
  messageId: string | null;
  status: InviteStatus;
  note: string | null;
  respondedAt: number | null;
  nudgesSent: number;
  nextNudgeAt: number | null;
  verdict: Verdict | null;
  error: string | null;
}

export interface LogEntry {
  at: number;
  inviteId: string | null;
  kind: string;
  detail: string;
}

export interface SummonsBundle {
  summons: Summons;
  invites: Invite[];
}

export interface SummonsDossier extends SummonsBundle {
  log: LogEntry[];
}

export function endsAt(s: Pick<Summons, "startsAt" | "durationMin">): number {
  return s.startsAt + s.durationMin * 60_000;
}

export function optionFor(s: Pick<Summons, "options">, kind: ResponseKind): ResponseOption {
  return s.options.find((o) => o.kind === kind) ?? DEFAULT_OPTIONS.find((o) => o.kind === kind)!;
}

// ---------------------------------------------------------------------------
// Validation of drafts coming from the website.

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const SNOWFLAKE = /^\d{15,21}$/;

function str(v: unknown, field: string, label: string, max: number, { required = false } = {}): string {
  const s = typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : v == null ? "" : null;
  if (s === null) throw new ValidationError(`${label} must be text`, field);
  if (required && !s) throw new ValidationError(`${label} is required`, field);
  if ([...s].length > max) throw new ValidationError(`${label} must be at most ${max} characters`, field);
  return s;
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || Math.floor(n) !== n) throw new ValidationError(`${field} must be a whole number`, field);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`, field);
  return n;
}

function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new ValidationError(`That ${field} choice isn't valid`, field);
  return v as T;
}

function snowflake(v: unknown, field: string): string {
  if (typeof v !== "string" || !SNOWFLAKE.test(v)) throw new ValidationError(`${field} must be a Discord ID`, field);
  return v;
}

export function validateDraft(input: unknown, now: number): SummonsDraft {
  if (!input || typeof input !== "object") throw new ValidationError("Expected a JSON object");
  const d = input as Record<string, unknown>;

  const recipientsRaw = Array.isArray(d.recipients) ? d.recipients : [];
  const recipients = [...new Set(recipientsRaw.map((r) => snowflake(r, "recipients")))];
  if (recipients.length === 0) throw new ValidationError("Pick at least one person to summon", "recipients");
  if (recipients.length > MAX_RECIPIENTS) throw new ValidationError(`You can summon at most ${MAX_RECIPIENTS} people at once`, "recipients");

  if (typeof d.startsAt === "number" && d.startsAt < now - 10 * 60_000) {
    throw new ValidationError("That time is in the past. The Bureau does not do time travel.", "startsAt");
  }
  const startsAt = int(d.startsAt, "startsAt", now - 10 * 60_000, now + 366 * 86_400_000);
  const durationMin = int(d.durationMin, "durationMin", 5, 24 * 60);

  let respondBy: number | null = null;
  if (d.respondBy !== null && d.respondBy !== undefined && d.respondBy !== "") {
    respondBy = int(d.respondBy, "respondBy", now, startsAt + durationMin * 60_000);
  }

  const delivery = oneOf(d.delivery ?? "dm", "delivery", ["dm", "channel"] as const) as Delivery;
  const channelId = d.channelId ? snowflake(d.channelId, "channelId") : null;
  if (delivery === "channel" && !channelId) throw new ValidationError("Pick a channel to post the summons in", "channelId");

  const optionsRaw = Array.isArray(d.options) ? d.options : DEFAULT_OPTIONS;
  const options: ResponseOption[] = [];
  for (const raw of optionsRaw) {
    if (!raw || typeof raw !== "object") throw new ValidationError("Invalid response option", "options");
    const o = raw as Record<string, unknown>;
    const kind = oneOf(o.kind, "options.kind", RESPONSE_KINDS);
    if (options.some((x) => x.kind === kind)) throw new ValidationError("Duplicate response option", "options");
    const label = str(o.label, "options", "Button label", 40, { required: true });
    const emoji = o.emoji ? oneOf(o.emoji, "options", BUTTON_EMOJI) : "";
    options.push({ kind, label, emoji });
  }
  if (options.length < 2) throw new ValidationError("Keep at least two response buttons", "options");
  if (!options.some((o) => o.kind === "yes")) throw new ValidationError("The accept button can't be removed", "options");
  options.sort((a, b) => RESPONSE_KINDS.indexOf(a.kind) - RESPONSE_KINDS.indexOf(b.kind));

  const remindBeforeMin = int(d.remindBeforeMin ?? 0, "remindBeforeMin", 0, 120);
  if (!(REMIND_OPTIONS as readonly number[]).includes(remindBeforeMin)) {
    throw new ValidationError("remindBeforeMin is not a valid choice", "remindBeforeMin");
  }

  return {
    guildId: snowflake(d.guildId, "guildId"),
    recipients,
    classification: str(d.classification, "classification", "Classification", 80, { required: true }).toUpperCase(),
    title: str(d.title, "title", "Title", 100, { required: true }),
    objective: str(d.objective, "objective", "Objective", 1000),
    location: str(d.location, "location", "Location", 100),
    startsAt,
    durationMin,
    priority: oneOf(d.priority ?? "routine", "priority", PRIORITIES),
    dressCode: str(d.dressCode, "dressCode", "Dress code", 80),
    signatureTitle: str(d.signatureTitle, "signatureTitle", "Your official title", 60),
    respondBy,
    options,
    delivery,
    channelId,
    escalation: oneOf(d.escalation ?? "standard", "escalation", ESCALATIONS),
    remindBeforeMin,
    createScheduledEvent: d.createScheduledEvent === true,
  };
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hours = `${h} hour${h === 1 ? "" : "s"}`;
  return m ? `${hours} ${m} min` : hours;
}

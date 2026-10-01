import { DurableObject } from "cloudflare:workers";
import { DiscordApi, DiscordError, ERR_INVALID_FORM, ERR_UNKNOWN_MESSAGE, type DiscordMessage } from "./discord";
import { bureauName, type Env } from "./env";
import { randomId } from "./crypto";
import {
  ESCALATION_INFO,
  NEEDS_NOTE,
  endsAt,
  type Escalation,
  type Invite,
  type InviteStatus,
  type LogEntry,
  type Person,
  type Priority,
  type ResponseKind,
  type Summons,
  type SummonsBundle,
  type SummonsDossier,
  type SummonsDraft,
  type Verdict,
} from "./model";
import {
  clip,
  renderBriefing,
  renderCancelNotice,
  renderNudge,
  renderReminder,
  renderResponseNotice,
  renderSummons,
  renderVerdictNotice,
  withoutButtonEmoji,
  type MessagePayload,
} from "./messages";

export interface IssueContext {
  organizer: Person;
  guildName: string;
  recipients: Person[];
  origin: string;
}

export interface DeliveryResult {
  recipient: Person;
  deliveredVia: Invite["deliveredVia"];
  error: string | null;
}

export interface IssueResult {
  summons: Summons;
  invites: Invite[];
  deliveries: DeliveryResult[];
  warnings: string[];
}

export type RespondFailure = "not_found" | "not_recipient" | "inactive" | "option_disabled";

export type RespondResult =
  | { ok: true; summons: Summons; invites: Invite[]; invite: Invite; changed: boolean }
  | { ok: false; reason: RespondFailure; summons?: Summons };

export type VerdictResult =
  | { ok: true; summons: Summons; invites: Invite[]; invite: Invite }
  | { ok: false; reason: "not_found" | "not_organizer" | "not_pending" };

export type OrganizerActionResult = { ok: true; count: number } | { ok: false; reason: string };

export interface DashboardData {
  issued: SummonsBundle[];
  received: SummonsBundle[];
}

interface OutboxRow {
  id: number;
  kind: "dm" | "delete_event";
  payload: string;
  attempts: number;
  summons_id: string | null;
  invite_id: string | null;
}

interface DmPayload {
  to: string;
  message: MessagePayload;
  /** Post here (the message must mention the user) if their DMs are closed. */
  fallbackChannelId?: string | null;
}

const ISSUE_LIMIT_PER_HOUR = 20;
const MAX_OUTBOX_ATTEMPTS = 5;
/** Free-plan Workers allow 50 subrequests per invocation; leave headroom. */
const NETWORK_BUDGET = 40;
const MANUAL_NUDGE_COOLDOWN_MS = 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS summons (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  ref TEXT NOT NULL,
  organizer_id TEXT NOT NULL,
  organizer_name TEXT NOT NULL,
  organizer_avatar TEXT,
  guild_id TEXT NOT NULL,
  guild_name TEXT NOT NULL,
  classification TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  location TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  priority TEXT NOT NULL,
  dress_code TEXT NOT NULL,
  signature_title TEXT NOT NULL,
  respond_by INTEGER,
  options TEXT NOT NULL,
  delivery TEXT NOT NULL,
  channel_id TEXT,
  escalation TEXT NOT NULL,
  remind_before_min INTEGER NOT NULL,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  scheduled_event_id TEXT,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  sync_at INTEGER
);
CREATE INDEX IF NOT EXISTS summons_organizer ON summons(organizer_id, created_at);
CREATE INDEX IF NOT EXISTS summons_status ON summons(status);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  summons_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_avatar TEXT,
  delivered_via TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  status TEXT NOT NULL,
  note TEXT,
  responded_at INTEGER,
  nudges_sent INTEGER NOT NULL DEFAULT 0,
  next_nudge_at INTEGER,
  verdict TEXT,
  error TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  UNIQUE (summons_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS invites_recipient ON invites(recipient_id);
CREATE INDEX IF NOT EXISTS invites_summons ON invites(summons_id);

CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summons_id TEXT NOT NULL,
  invite_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_summons ON log(summons_id, id);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  due_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summons_id TEXT,
  invite_id TEXT,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(due_at);
`;

type Row = Record<string, SqlStorageValue>;

function s(v: SqlStorageValue | undefined): string {
  return v == null ? "" : String(v);
}
function n(v: SqlStorageValue | undefined): number {
  return Number(v ?? 0);
}
function nn(v: SqlStorageValue | undefined): number | null {
  return v == null ? null : Number(v);
}
function sn(v: SqlStorageValue | undefined): string | null {
  return v == null ? null : String(v);
}

function toSummons(r: Row): Summons {
  return {
    id: s(r.id),
    ref: s(r.ref),
    organizer: { id: s(r.organizer_id), name: s(r.organizer_name), avatar: sn(r.organizer_avatar) },
    guildId: s(r.guild_id),
    guildName: s(r.guild_name),
    classification: s(r.classification),
    title: s(r.title),
    objective: s(r.objective),
    location: s(r.location),
    startsAt: n(r.starts_at),
    durationMin: n(r.duration_min),
    priority: s(r.priority) as Priority,
    dressCode: s(r.dress_code),
    signatureTitle: s(r.signature_title),
    respondBy: nn(r.respond_by),
    options: JSON.parse(s(r.options)),
    delivery: s(r.delivery) as Summons["delivery"],
    channelId: sn(r.channel_id),
    escalation: s(r.escalation) as Escalation,
    remindBeforeMin: n(r.remind_before_min),
    reminderSent: n(r.reminder_sent) === 1,
    scheduledEventId: sn(r.scheduled_event_id),
    status: s(r.status) as Summons["status"],
    origin: s(r.origin),
    createdAt: n(r.created_at),
    endedAt: nn(r.ended_at),
  };
}

function toInvite(r: Row): Invite {
  return {
    id: s(r.id),
    summonsId: s(r.summons_id),
    recipient: { id: s(r.recipient_id), name: s(r.recipient_name), avatar: sn(r.recipient_avatar) },
    deliveredVia: s(r.delivered_via) as Invite["deliveredVia"],
    channelId: sn(r.channel_id),
    messageId: sn(r.message_id),
    status: s(r.status) as InviteStatus,
    note: sn(r.note),
    respondedAt: nn(r.responded_at),
    nudgesSent: n(r.nudges_sent),
    nextNudgeAt: nn(r.next_nudge_at),
    verdict: sn(r.verdict) as Verdict | null,
    error: sn(r.error),
  };
}

/** Follow-up notices stop shortly before the event ends; after that there's nothing left to join. */
function nudgeCutoff(summons: Summons): number {
  return endsAt(summons) - 5 * 60_000;
}

function errorText(e: unknown): string {
  return clip(e instanceof Error ? e.message : String(e), 300);
}

function isRetryable(e: unknown): boolean {
  if (e instanceof DiscordError) return e.status === 429 || e.status >= 500;
  return true; // network errors
}

export class Bureau extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private get api(): DiscordApi {
    return DiscordApi.bot(this.env);
  }

  private get bureau(): string {
    return bureauName(this.env);
  }

  // --- reads -------------------------------------------------------------------------

  private loadSummons(id: string): Summons | null {
    const row = this.sql.exec("SELECT * FROM summons WHERE id = ?", id).toArray()[0];
    return row ? toSummons(row) : null;
  }

  private loadInvites(summonsId: string): Invite[] {
    return this.sql
      .exec("SELECT * FROM invites WHERE summons_id = ? ORDER BY rowid", summonsId)
      .toArray()
      .map(toInvite);
  }

  private loadBundle(id: string): SummonsBundle | null {
    const summons = this.loadSummons(id);
    return summons ? { summons, invites: this.loadInvites(id) } : null;
  }

  get(id: string): SummonsDossier | null {
    const bundle = this.loadBundle(id);
    if (!bundle) return null;
    const log = this.sql
      .exec("SELECT at, invite_id, kind, detail FROM log WHERE summons_id = ? ORDER BY id", id)
      .toArray()
      .map((r): LogEntry => ({ at: n(r.at), inviteId: sn(r.invite_id), kind: s(r.kind), detail: s(r.detail) }));
    return { ...bundle, log };
  }

  dashboard(userId: string): DashboardData {
    const issued = this.sql
      .exec("SELECT id FROM summons WHERE organizer_id = ? ORDER BY created_at DESC LIMIT 50", userId)
      .toArray()
      .map((r) => this.loadBundle(s(r.id))!);
    const received = this.sql
      .exec(
        `SELECT s.id FROM invites i JOIN summons s ON s.id = i.summons_id
         WHERE i.recipient_id = ? ORDER BY s.created_at DESC LIMIT 50`,
        userId,
      )
      .toArray()
      .map((r) => this.loadBundle(s(r.id))!);
    return { issued, received };
  }

  /** Summonses addressed to this user that still wait for their answer. */
  pendingFor(userId: string): SummonsBundle[] {
    return this.sql
      .exec(
        `SELECT s.id FROM invites i JOIN summons s ON s.id = i.summons_id
         WHERE i.recipient_id = ? AND i.status = 'pending' AND s.status = 'active'
         ORDER BY s.starts_at LIMIT 10`,
        userId,
      )
      .toArray()
      .map((r) => this.loadBundle(s(r.id))!);
  }

  // --- issuing -------------------------------------------------------------------------

  async issue(draft: SummonsDraft, context: IssueContext): Promise<IssueResult> {
    const now = Date.now();
    const recent = n(
      this.sql
        .exec("SELECT COUNT(*) AS c FROM summons WHERE organizer_id = ? AND created_at > ?", context.organizer.id, now - 3_600_000)
        .one().c,
    );
    if (recent >= ISSUE_LIMIT_PER_HOUR) {
      throw new Error("The Bureau has processed too many summonses from you this hour. Try again later.");
    }

    const id = randomId(10);
    const seq = n(this.sql.exec("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM summons").one().next);
    const ref = `BMA-${new Date(now).getUTCFullYear()}-${String(seq).padStart(4, "0")}`;
    const remindAt = draft.startsAt - draft.remindBeforeMin * 60_000;
    // A reminder that would fire within the next minute (or in the past) is pointless.
    const reminderSent = draft.remindBeforeMin === 0 || remindAt <= now + 60_000 ? 1 : 0;

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO summons (id, seq, ref, organizer_id, organizer_name, organizer_avatar, guild_id, guild_name,
           classification, title, objective, location, starts_at, duration_min, priority, dress_code, signature_title,
           respond_by, options, delivery, channel_id, escalation, remind_before_min, reminder_sent, status, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        id, seq, ref, context.organizer.id, context.organizer.name, context.organizer.avatar, draft.guildId, context.guildName,
        draft.classification, draft.title, draft.objective, draft.location, draft.startsAt, draft.durationMin, draft.priority,
        draft.dressCode, draft.signatureTitle, draft.respondBy, JSON.stringify(draft.options), draft.delivery, draft.channelId,
        draft.escalation, draft.remindBeforeMin, reminderSent, context.origin, now,
      );
      for (const person of context.recipients) {
        this.sql.exec(
          `INSERT INTO invites (id, summons_id, recipient_id, recipient_name, recipient_avatar, delivered_via, status)
           VALUES (?, ?, ?, ?, ?, 'pending', 'pending')`,
          randomId(10), id, person.id, person.name, person.avatar,
        );
      }
      this.log(id, null, "issued", `Issued by ${context.organizer.name}`, now);
    });

    const warnings: string[] = [];
    const summons = this.loadSummons(id)!;
    let invites = this.loadInvites(id);

    if (summons.delivery === "channel" && summons.channelId) {
      try {
        const msg = await this.send(summons.channelId, renderSummons(summons, invites, invites, this.bureau, now));
        this.sql.exec(
          "UPDATE invites SET delivered_via = 'channel', channel_id = ?, message_id = ? WHERE summons_id = ?",
          msg.channel_id ?? summons.channelId, msg.id, id,
        );
        this.log(id, null, "delivered", "Posted in the server channel");
      } catch (e) {
        this.sql.exec("UPDATE invites SET delivered_via = 'failed', error = ? WHERE summons_id = ?", errorText(e), id);
        this.log(id, null, "delivery_failed", errorText(e));
      }
    } else {
      for (const invite of invites) {
        const message = renderSummons(summons, invites, [invite], this.bureau, now);
        try {
          const channel = await this.api.openDm(invite.recipient.id);
          const msg = await this.send(channel.id, message);
          this.markDelivered(invite, "dm", channel.id, msg.id);
        } catch (e) {
          if (e instanceof DiscordError && e.cannotDm && summons.channelId) {
            try {
              const msg = await this.send(summons.channelId, message);
              this.markDelivered(invite, "channel", summons.channelId, msg.id);
              this.log(id, invite.id, "dm_closed", `${invite.recipient.name} has DMs closed — posted in the server channel instead`);
              continue;
            } catch (e2) {
              e = e2;
            }
          }
          this.sql.exec("UPDATE invites SET delivered_via = 'failed', error = ? WHERE id = ?", errorText(e), invite.id);
          this.log(id, invite.id, "delivery_failed", `${invite.recipient.name}: ${errorText(e)}`);
        }
      }
    }

    if (draft.createScheduledEvent) {
      try {
        const event = await this.api.createScheduledEvent(summons.guildId, {
          name: clip(`${summons.classification}: ${summons.title}`, 100),
          description: clip(`${summons.objective}\n\nRef. ${summons.ref}`.trim(), 1000),
          privacy_level: 2,
          entity_type: 3,
          entity_metadata: { location: clip(summons.location || "To be disclosed", 100) },
          scheduled_start_time: new Date(Math.max(summons.startsAt, now + 60_000)).toISOString(),
          scheduled_end_time: new Date(endsAt(summons)).toISOString(),
        });
        this.sql.exec("UPDATE summons SET scheduled_event_id = ? WHERE id = ?", event.id, id);
        this.log(id, null, "event_created", "Added to the server's Events tab");
      } catch (e) {
        warnings.push(`Couldn't add it to the server's Events tab: ${errorText(e)}`);
        this.log(id, null, "event_failed", errorText(e));
      }
    }

    this.scheduleFirstNudges(summons, now);
    await this.reschedule();

    invites = this.loadInvites(id);
    return {
      summons: this.loadSummons(id)!,
      invites,
      deliveries: invites.map((i) => ({ recipient: i.recipient, deliveredVia: i.deliveredVia, error: i.error })),
      warnings,
    };
  }

  private markDelivered(invite: Invite, via: "dm" | "channel", channelId: string, messageId: string) {
    this.sql.exec(
      "UPDATE invites SET delivered_via = ?, channel_id = ?, message_id = ?, error = NULL WHERE id = ?",
      via, channelId, messageId, invite.id,
    );
    if (via === "dm") this.log(invite.summonsId, invite.id, "delivered", `${invite.recipient.name}: delivered by direct message`);
  }

  private scheduleFirstNudges(summons: Summons, now: number) {
    const info = ESCALATION_INFO[summons.escalation];
    if (!info.maxNotices) return;
    const next = now + info.intervalMin * 60_000;
    if (next >= nudgeCutoff(summons)) return;
    this.sql.exec(
      "UPDATE invites SET next_nudge_at = ? WHERE summons_id = ? AND status = 'pending' AND delivered_via != 'failed'",
      next, summons.id,
    );
  }

  /** Sends a message, retrying without button emoji if Discord rejects one. */
  private async send(channelId: string, message: MessagePayload): Promise<DiscordMessage> {
    try {
      return await this.api.sendMessage(channelId, message);
    } catch (e) {
      if (e instanceof DiscordError && e.code === ERR_INVALID_FORM && JSON.stringify(e.body).includes("emoji")) {
        return this.api.sendMessage(channelId, withoutButtonEmoji(message));
      }
      throw e;
    }
  }

  private async edit(channelId: string, messageId: string, message: MessagePayload): Promise<void> {
    try {
      await this.api.editMessage(channelId, messageId, message);
    } catch (e) {
      if (e instanceof DiscordError && e.code === ERR_INVALID_FORM && JSON.stringify(e.body).includes("emoji")) {
        await this.api.editMessage(channelId, messageId, withoutButtonEmoji(message));
        return;
      }
      throw e;
    }
  }

  // --- responses ---------------------------------------------------------------------

  async respond(
    summonsId: string,
    userId: string,
    kind: ResponseKind,
    note: string | null,
    clickedMessageId: string | null,
  ): Promise<RespondResult> {
    const summons = this.loadSummons(summonsId);
    if (!summons) return { ok: false, reason: "not_found" };
    const row = this.sql.exec("SELECT * FROM invites WHERE summons_id = ? AND recipient_id = ?", summonsId, userId).toArray()[0];
    if (!row) return { ok: false, reason: "not_recipient", summons };
    if (summons.status !== "active") return { ok: false, reason: "inactive", summons };
    if (!summons.options.some((o) => o.kind === kind)) return { ok: false, reason: "option_disabled", summons };

    const invite = toInvite(row);
    const cleanNote = NEEDS_NOTE[kind] ? clip((note ?? "").trim(), 300) || null : null;
    const changed = invite.status !== kind || invite.note !== cleanNote;
    const now = Date.now();

    if (changed) {
      const previous = invite.status;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE invites SET status = ?, note = ?, responded_at = ?, next_nudge_at = NULL, verdict = NULL WHERE id = ?`,
          kind, cleanNote, now, invite.id,
        );
        // Every other message that shows this summons needs re-rendering (roster, tally).
        const marked = this.sql.exec(
          `UPDATE invites SET dirty = 1 WHERE summons_id = ? AND message_id IS NOT NULL AND message_id IS NOT ?`,
          summonsId, clickedMessageId,
        ).rowsWritten;
        if (marked > 0) this.markSyncNeeded(summonsId, now + 1_000);
        this.log(summonsId, invite.id, "response", `${invite.recipient.name}: ${kind}${cleanNote ? ` — “${cleanNote}”` : ""}`, now);
      });

      const invites = this.loadInvites(summonsId);
      const updated = invites.find((i) => i.id === invite.id)!;
      this.enqueueDm(summonsId, invite.id, {
        to: summons.organizer.id,
        message: renderResponseNotice(summons, invites, updated, previous, this.bureau),
      });
      await this.reschedule();
      return { ok: true, summons, invites, invite: updated, changed };
    }

    const invites = this.loadInvites(summonsId);
    return { ok: true, summons, invites, invite: invites.find((i) => i.id === invite.id)!, changed };
  }

  async verdict(inviteId: string, userId: string, verdict: Verdict): Promise<VerdictResult> {
    const row = this.sql.exec("SELECT * FROM invites WHERE id = ?", inviteId).toArray()[0];
    if (!row) return { ok: false, reason: "not_found" };
    const invite = toInvite(row);
    const summons = this.loadSummons(invite.summonsId);
    if (!summons) return { ok: false, reason: "not_found" };
    if (summons.organizer.id !== userId) return { ok: false, reason: "not_organizer" };
    if (invite.status !== "extend" || summons.status !== "active") return { ok: false, reason: "not_pending" };

    if (invite.verdict !== verdict) {
      this.sql.exec("UPDATE invites SET verdict = ?, dirty = CASE WHEN message_id IS NULL THEN 0 ELSE 1 END WHERE id = ?", verdict, inviteId);
      this.log(summons.id, inviteId, "verdict", `Extension for ${invite.recipient.name} ${verdict}`);
      const updated = { ...invite, verdict };
      this.enqueueDm(summons.id, inviteId, {
        to: invite.recipient.id,
        message: renderVerdictNotice(summons, updated),
        fallbackChannelId: invite.deliveredVia === "channel" ? invite.channelId : null,
      });
      this.markSyncNeeded(summons.id, Date.now() + 1_000);
      await this.reschedule();
    }
    const invites = this.loadInvites(summons.id);
    return { ok: true, summons, invites, invite: invites.find((i) => i.id === inviteId)! };
  }

  // --- organizer actions -------------------------------------------------------------

  async cancel(summonsId: string, userId: string): Promise<OrganizerActionResult> {
    const summons = this.loadSummons(summonsId);
    if (!summons || summons.organizer.id !== userId) return { ok: false, reason: "Summons not found" };
    if (summons.status !== "active") return { ok: false, reason: "This summons is no longer active" };
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE summons SET status = 'cancelled', ended_at = ? WHERE id = ?", now, summonsId);
      this.sql.exec(
        "UPDATE invites SET next_nudge_at = NULL, dirty = CASE WHEN message_id IS NULL THEN 0 ELSE 1 END WHERE summons_id = ?",
        summonsId,
      );
      this.log(summonsId, null, "cancelled", "Cancelled by the issuing officer", now);
    });
    const cancelled = this.loadSummons(summonsId)!;
    let count = 0;
    for (const invite of this.loadInvites(summonsId)) {
      if (invite.status === "no" || invite.deliveredVia === "failed" || invite.deliveredVia === "pending") continue;
      this.enqueueDm(summonsId, invite.id, {
        to: invite.recipient.id,
        message: renderCancelNotice(cancelled, invite),
        fallbackChannelId: invite.deliveredVia === "channel" ? invite.channelId : null,
      });
      count++;
    }
    if (summons.scheduledEventId) {
      this.enqueue("delete_event", summonsId, null, { guildId: summons.guildId, eventId: summons.scheduledEventId });
    }
    this.markSyncNeeded(summonsId, now);
    await this.reschedule();
    return { ok: true, count };
  }

  async nudgeNow(summonsId: string, userId: string): Promise<OrganizerActionResult> {
    const summons = this.loadSummons(summonsId);
    if (!summons || summons.organizer.id !== userId) return { ok: false, reason: "Summons not found" };
    if (summons.status !== "active") return { ok: false, reason: "This summons is no longer active" };
    const now = Date.now();
    const last = this.sql
      .exec("SELECT MAX(at) AS at FROM log WHERE summons_id = ? AND kind = 'manual_nudge'", summonsId)
      .one().at;
    if (last != null && now - Number(last) < MANUAL_NUDGE_COOLDOWN_MS) {
      return { ok: false, reason: "You just sent a reminder. Give them a minute." };
    }
    let count = 0;
    for (const invite of this.loadInvites(summonsId)) {
      if (invite.status !== "pending" || invite.deliveredVia === "failed" || invite.deliveredVia === "pending") continue;
      this.enqueueDm(summonsId, invite.id, {
        to: invite.recipient.id,
        message: renderNudge(summons, invite, invite.nudgesSent, false),
        fallbackChannelId: summons.channelId,
      });
      this.sql.exec("UPDATE invites SET nudges_sent = nudges_sent + 1 WHERE id = ?", invite.id);
      count++;
    }
    if (!count) return { ok: false, reason: "Nobody is waiting to respond." };
    this.log(summonsId, null, "manual_nudge", `Reminder sent to ${count} ${count === 1 ? "person" : "people"}`, now);
    await this.reschedule();
    return { ok: true, count };
  }

  // --- scheduler ---------------------------------------------------------------------

  override async alarm(): Promise<void> {
    await this.runDue(Date.now());
  }

  /** Test hook: run the scheduler as if the clock read `now`. */
  async tick(now: number): Promise<void> {
    await this.runDue(now);
  }

  private async runDue(now: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.closeExpired(now);
      this.queueReminders(now);
      this.queueNudges(now);
      let budget = NETWORK_BUDGET;
      budget = await this.flushOutbox(now, budget);
      await this.syncMessages(now, budget);
    } finally {
      this.running = false;
      await this.reschedule();
    }
  }

  private closeExpired(now: number) {
    const rows = this.sql
      .exec("SELECT id FROM summons WHERE status = 'active' AND starts_at + duration_min * 60000 <= ?", now)
      .toArray();
    for (const r of rows) {
      const id = s(r.id);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE summons SET status = 'closed', ended_at = ?, sync_at = ? WHERE id = ?", now, now, id);
        this.sql.exec(
          "UPDATE invites SET next_nudge_at = NULL, dirty = CASE WHEN message_id IS NULL THEN 0 ELSE 1 END WHERE summons_id = ?",
          id,
        );
        this.log(id, null, "closed", "File closed: the event is over", now);
      });
    }
  }

  private queueReminders(now: number) {
    const rows = this.sql
      .exec(
        `SELECT id FROM summons WHERE status = 'active' AND reminder_sent = 0 AND remind_before_min > 0
         AND starts_at - remind_before_min * 60000 <= ?`,
        now,
      )
      .toArray();
    for (const r of rows) {
      const summons = this.loadSummons(s(r.id))!;
      this.sql.exec("UPDATE summons SET reminder_sent = 1 WHERE id = ?", summons.id);
      if (now >= summons.startsAt) continue;
      const invites = this.loadInvites(summons.id);
      let count = 0;
      for (const invite of invites) {
        const coming = invite.status === "yes" || (invite.status === "extend" && invite.verdict === "granted");
        if (!coming) continue;
        this.enqueueDm(summons.id, invite.id, {
          to: invite.recipient.id,
          message: renderReminder(summons, invite),
          fallbackChannelId: invite.deliveredVia === "channel" ? invite.channelId : null,
        }, now);
        count++;
      }
      this.enqueueDm(summons.id, null, { to: summons.organizer.id, message: renderBriefing(summons, invites, this.bureau) }, now);
      this.log(summons.id, null, "reminder", `Pre-event reminder sent to ${count} confirmed ${count === 1 ? "attendee" : "attendees"}`, now);
    }
  }

  private queueNudges(now: number) {
    const rows = this.sql
      .exec(
        `SELECT i.id AS invite_id, s.id AS summons_id FROM invites i JOIN summons s ON s.id = i.summons_id
         WHERE s.status = 'active' AND i.status = 'pending' AND i.next_nudge_at IS NOT NULL AND i.next_nudge_at <= ?`,
        now,
      )
      .toArray();
    for (const r of rows) {
      const summons = this.loadSummons(s(r.summons_id))!;
      const invite = toInvite(this.sql.exec("SELECT * FROM invites WHERE id = ?", s(r.invite_id)).one());
      const info = ESCALATION_INFO[summons.escalation];
      const sent = invite.nudgesSent;
      if (sent >= info.maxNotices || now >= nudgeCutoff(summons)) {
        this.sql.exec("UPDATE invites SET next_nudge_at = NULL WHERE id = ?", invite.id);
        continue;
      }
      const final = sent + 1 >= info.maxNotices;
      this.enqueueDm(summons.id, invite.id, {
        to: invite.recipient.id,
        message: renderNudge(summons, invite, sent, final),
        fallbackChannelId: summons.channelId,
      }, now);
      const next = now + info.intervalMin * 60_000;
      this.sql.exec(
        "UPDATE invites SET nudges_sent = ?, next_nudge_at = ? WHERE id = ?",
        sent + 1, final || next >= nudgeCutoff(summons) ? null : next, invite.id,
      );
      this.log(summons.id, invite.id, "nudge", `${final ? "Final notice" : `Notice #${sent + 2}`} sent to ${invite.recipient.name}`, now);
    }
  }

  private enqueueDm(summonsId: string | null, inviteId: string | null, payload: DmPayload, dueAt = Date.now()) {
    this.enqueue("dm", summonsId, inviteId, payload, dueAt);
  }

  private enqueue(kind: OutboxRow["kind"], summonsId: string | null, inviteId: string | null, payload: unknown, dueAt = Date.now()) {
    this.sql.exec(
      "INSERT INTO outbox (due_at, kind, summons_id, invite_id, payload) VALUES (?, ?, ?, ?, ?)",
      dueAt, kind, summonsId, inviteId, JSON.stringify(payload),
    );
  }

  private markSyncNeeded(summonsId: string, at: number) {
    this.sql.exec(
      "UPDATE summons SET sync_at = CASE WHEN sync_at IS NULL OR sync_at > ? THEN ? ELSE sync_at END WHERE id = ?",
      at, at, summonsId,
    );
  }

  private async flushOutbox(now: number, budget: number): Promise<number> {
    const items = this.sql
      .exec("SELECT id, kind, payload, attempts, summons_id, invite_id FROM outbox WHERE due_at <= ? ORDER BY id LIMIT 20", now)
      .toArray() as unknown as OutboxRow[];
    for (const item of items) {
      if (budget < 3) break;
      try {
        if (item.kind === "dm") {
          budget -= 2;
          await this.deliverDm(JSON.parse(item.payload) as DmPayload, () => budget--);
        } else if (item.kind === "delete_event") {
          budget -= 1;
          const p = JSON.parse(item.payload) as { guildId: string; eventId: string };
          await this.api.deleteScheduledEvent(p.guildId, p.eventId).catch((e) => {
            if (!(e instanceof DiscordError && e.status === 404)) throw e;
          });
        }
        this.sql.exec("DELETE FROM outbox WHERE id = ?", item.id);
      } catch (e) {
        const attempts = n(item.attempts) + 1;
        if (attempts >= MAX_OUTBOX_ATTEMPTS || !isRetryable(e)) {
          this.sql.exec("DELETE FROM outbox WHERE id = ?", item.id);
          if (item.summons_id) this.log(item.summons_id, item.invite_id, "notify_failed", errorText(e));
        } else {
          const retryAt = Date.now() + 30_000 * 2 ** (attempts - 1);
          this.sql.exec("UPDATE outbox SET attempts = ?, due_at = ?, last_error = ? WHERE id = ?", attempts, retryAt, errorText(e), item.id);
        }
      }
    }
    return budget;
  }

  private async deliverDm(p: DmPayload, spend: () => void): Promise<void> {
    try {
      const channel = await this.api.openDm(p.to);
      await this.send(channel.id, p.message);
    } catch (e) {
      if (e instanceof DiscordError && e.cannotDm && p.fallbackChannelId) {
        spend();
        await this.send(p.fallbackChannelId, p.message);
        return;
      }
      throw e;
    }
  }

  private async syncMessages(now: number, budget: number): Promise<void> {
    const due = this.sql.exec("SELECT id FROM summons WHERE sync_at IS NOT NULL AND sync_at <= ?", now).toArray();
    for (const r of due) {
      const id = s(r.id);
      const summons = this.loadSummons(id)!;
      const invites = this.loadInvites(id);
      const dirty = this.sql
        .exec("SELECT * FROM invites WHERE summons_id = ? AND dirty = 1", id)
        .toArray()
        .map(toInvite);
      const groups = new Map<string, Invite[]>();
      for (const invite of dirty) {
        if (!invite.channelId || !invite.messageId) continue;
        const key = `${invite.channelId}/${invite.messageId}`;
        if (!groups.has(key)) groups.set(key, invites.filter((i) => i.messageId === invite.messageId));
      }
      let finished = true;
      for (const [key, addressees] of groups) {
        if (budget < 1) {
          finished = false;
          break;
        }
        budget--;
        const [channelId, messageId] = key.split("/") as [string, string];
        try {
          await this.edit(channelId, messageId, renderSummons(summons, invites, addressees, this.bureau, now));
        } catch (e) {
          if (e instanceof DiscordError && e.code === ERR_UNKNOWN_MESSAGE) {
            this.sql.exec("UPDATE invites SET message_id = NULL WHERE message_id = ?", messageId);
          } else if (isRetryable(e)) {
            finished = false;
            continue;
          } else {
            this.log(id, null, "sync_failed", errorText(e));
          }
        }
        this.sql.exec("UPDATE invites SET dirty = 0 WHERE summons_id = ? AND message_id IS ?", id, messageId);
      }
      if (finished) {
        this.sql.exec("UPDATE invites SET dirty = 0 WHERE summons_id = ? AND message_id IS NULL", id);
        this.sql.exec("UPDATE summons SET sync_at = NULL WHERE id = ?", id);
      } else {
        this.sql.exec("UPDATE summons SET sync_at = ? WHERE id = ?", Date.now() + 15_000, id);
      }
    }
  }

  private async reschedule(): Promise<void> {
    const candidates = [
      "SELECT MIN(starts_at + duration_min * 60000) AS t FROM summons WHERE status = 'active'",
      "SELECT MIN(starts_at - remind_before_min * 60000) AS t FROM summons WHERE status = 'active' AND reminder_sent = 0 AND remind_before_min > 0",
      `SELECT MIN(i.next_nudge_at) AS t FROM invites i JOIN summons s ON s.id = i.summons_id
       WHERE s.status = 'active' AND i.status = 'pending' AND i.next_nudge_at IS NOT NULL`,
      "SELECT MIN(due_at) AS t FROM outbox",
      "SELECT MIN(sync_at) AS t FROM summons WHERE sync_at IS NOT NULL",
    ];
    let next: number | null = null;
    for (const q of candidates) {
      const t = this.sql.exec(q).one().t;
      if (t != null && (next === null || Number(t) < next)) next = Number(t);
    }
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const at = Math.max(next, Date.now() + 250);
    const current = await this.ctx.storage.getAlarm();
    if (current !== at) await this.ctx.storage.setAlarm(at);
  }

  private log(summonsId: string, inviteId: string | null, kind: string, detail: string, at = Date.now()) {
    this.sql.exec(
      "INSERT INTO log (summons_id, invite_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)",
      summonsId, inviteId, at, kind, clip(detail, 500),
    );
  }
}

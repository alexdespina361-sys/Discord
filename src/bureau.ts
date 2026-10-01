import { DurableObject } from "cloudflare:workers";
import { DiscordApi, DiscordError, ERR_INVALID_FORM, ERR_UNKNOWN_MESSAGE, type DiscordMessage } from "./discord";
import { bureauName, cfg, type Env } from "./env";
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
  renderForward,
  renderInChatCancel,
  renderInChatResponse,
  renderInChatVerdict,
  renderNudge,
  renderRelayFailed,
  renderRelayHelp,
  renderRelayRouted,
  renderReminder,
  renderUnreachable,
  renderResponseNotice,
  renderSummons,
  renderVerdictNotice,
  withoutButtonEmoji,
  type MessagePayload,
} from "./messages";
import { laterId, snowflakeAt, toIncomingDm, type IncomingDm, type RelayOutcome } from "./relay";

export interface IssueContext {
  organizer: Person;
  guildName: string;
  recipients: Person[];
  origin: string;
}

/** /summon used in a chat: the summons is the interaction response itself. */
export interface HereContext extends IssueContext {
  channelId: string;
  guildId: string | null;
  token: string;
}

/** The interaction that touched a summons message, if any. Its token can post in that chat for 15 minutes. */
export interface Via {
  messageId: string | null;
  token?: string | null;
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
  | { ok: true; summons: Summons; invites: Invite[]; invite: Invite; changed: boolean; relay: boolean }
  | { ok: false; reason: RespondFailure; summons?: Summons; invites?: Invite[] };

export type VerdictResult =
  | { ok: true; summons: Summons; invites: Invite[]; invite: Invite; relay: boolean }
  | { ok: false; reason: "not_found" | "not_organizer" | "not_pending" };

export type BellResult =
  | { ok: true; summons: Summons; invites: Invite[]; invite: Invite }
  | { ok: false; reason: "not_found" | "not_organizer" | "inactive" | "answered" | "cooldown"; invite?: Invite; summons?: Summons; invites?: Invite[] };

export type OrganizerActionResult = { ok: true; count: number } | { ok: false; reason: string };

export interface DashboardData {
  issued: SummonsBundle[];
  received: SummonsBundle[];
}

type OutboxKind = "dm" | "delete_event" | "followup" | "edit_original";

interface OutboxRow {
  id: number;
  kind: OutboxKind;
  payload: string;
  attempts: number;
  summons_id: string | null;
  invite_id: string | null;
}

interface DmPayload {
  to: string;
  message: MessagePayload;
  /** Who a reply to this DM should be forwarded to. */
  peer?: string | null;
  /** Post here (the message must mention the user) if their DMs are closed. */
  fallbackChannelId?: string | null;
}

interface WebhookPayload {
  token: string;
  message: MessagePayload;
}

interface ChatToken {
  token: string;
  expires: number;
  followups: number;
}

const ISSUE_LIMIT_PER_HOUR = 20;
const MAX_OUTBOX_ATTEMPTS = 5;
/** Free-plan Workers allow 50 subrequests per invocation; leave headroom. */
const NETWORK_BUDGET = 40;
const MANUAL_NUDGE_COOLDOWN_MS = 60_000;
/** Interaction tokens last 15 minutes; stop using them a little early. */
const TOKEN_LIFETIME_MS = 14 * 60_000;
/** Discord allows 5 follow-ups per interaction for apps used outside a server they're installed in. */
const MAX_FOLLOWUPS = 5;
/** In-chat notices after /summon or the 🔔: every 4 minutes, up to 3 per interaction. */
const WINDOW_GAP_MS = 4 * 60_000;
const WINDOW_NOTICES = 3;
const PARTNER_TTL_MS = 14 * 86_400_000;
const HELP_COOLDOWN_MS = 10 * 60_000;

const SCHEMA_V1 = `
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

/** v2: /summon in chats (interaction tokens) and the DM relay. */
const SCHEMA_V2_TABLES = `
CREATE TABLE IF NOT EXISTS dm_channels (
  user_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  last_seen TEXT,
  active_at INTEGER NOT NULL,
  help_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_messages (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  peer_id TEXT,
  summons_id TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_partners (
  user_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  summons_id TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_seen (
  message_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
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
    this.migrate();
  }

  /** Every step is idempotent, so a half-applied upgrade simply runs again. */
  private migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const steps: (() => void)[] = [
      () => this.sql.exec(SCHEMA_V1),
      () => {
        this.addColumn("summons", "interaction_token", "TEXT");
        this.addColumn("summons", "interaction_expires", "INTEGER");
        this.addColumn("summons", "interaction_followups", "INTEGER NOT NULL DEFAULT 0");
        this.addColumn("invites", "window_nudges", "INTEGER NOT NULL DEFAULT 0");
        this.sql.exec(SCHEMA_V2_TABLES);
      },
      () => {
        // Where each person's typed messages went last, so we can say so when it changes.
        this.addColumn("dm_channels", "last_target", "TEXT");
        // Earlier versions could pair someone with themselves (a self-summons); that only echoed messages back.
        this.sql.exec("DELETE FROM relay_partners WHERE partner_id = user_id");
      },
    ];
    const version = Number(this.getSetting("schema_version") ?? 0);
    if (version >= steps.length) return;
    this.ctx.storage.transactionSync(() => {
      for (let v = version; v < steps.length; v++) steps[v]!();
      this.setSettingSync("schema_version", String(steps.length));
    });
  }

  private addColumn(table: string, column: string, type: string) {
    const exists = this.sql
      .exec(`PRAGMA table_info(${table})`)
      .toArray()
      .some((c) => c.name === column);
    if (!exists) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private getSetting(key: string): string | null {
    return sn(this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value);
  }

  private setSettingSync(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private get api(): DiscordApi {
    return DiscordApi.bot(this.env);
  }

  private get bureau(): string {
    return bureauName(this.env);
  }

  // --- settings ----------------------------------------------------------------------

  relayEnabled(): boolean {
    return this.getSetting("relay") !== "0";
  }

  setRelay(enabled: boolean): boolean {
    const was = this.relayEnabled();
    this.setSettingSync("relay", enabled ? "1" : "0");
    // Don't deliver, much later, whatever people typed while forwarding was off.
    if (enabled && !was) this.sql.exec("UPDATE dm_channels SET last_seen = ?", snowflakeAt(Date.now()));
    return enabled;
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

  private checkRate(organizerId: string, now: number) {
    const recent = n(
      this.sql.exec("SELECT COUNT(*) AS c FROM summons WHERE organizer_id = ? AND created_at > ?", organizerId, now - 3_600_000).one().c,
    );
    if (recent >= ISSUE_LIMIT_PER_HOUR) {
      throw new Error("The Bureau has processed too many summonses from you this hour. Try again later.");
    }
  }

  private insertSummons(draft: SummonsDraft, context: IssueContext, now: number, token: string | null = null): string {
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
           respond_by, options, delivery, channel_id, escalation, remind_before_min, reminder_sent, status, origin, created_at,
           interaction_token, interaction_expires, interaction_followups)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0)`,
        id, seq, ref, context.organizer.id, context.organizer.name, context.organizer.avatar, draft.guildId, context.guildName,
        draft.classification, draft.title, draft.objective, draft.location, draft.startsAt, draft.durationMin, draft.priority,
        draft.dressCode, draft.signatureTitle, draft.respondBy, JSON.stringify(draft.options), draft.delivery, draft.channelId,
        draft.escalation, draft.remindBeforeMin, reminderSent, context.origin, now,
        token, token ? now + TOKEN_LIFETIME_MS : null,
      );
      for (const person of context.recipients) {
        this.sql.exec(
          `INSERT INTO invites (id, summons_id, recipient_id, recipient_name, recipient_avatar, delivered_via, status)
           VALUES (?, ?, ?, ?, ?, 'pending', 'pending')`,
          randomId(10), id, person.id, person.name, person.avatar,
        );
        // Anything they type to the bot now goes to whoever summoned them.
        this.notePartner(person.id, context.organizer.id, id, now);
      }
      if (context.recipients.length === 1) this.notePartner(context.organizer.id, context.recipients[0]!.id, id, now);
      this.log(id, null, "issued", `Issued by ${context.organizer.name}`, now);
    });
    return id;
  }

  async issue(draft: SummonsDraft, context: IssueContext): Promise<IssueResult> {
    const now = Date.now();
    this.checkRate(context.organizer.id, now);
    const id = this.insertSummons(draft, context, now);

    const warnings: string[] = [];
    const summons = this.loadSummons(id)!;
    let invites = this.loadInvites(id);
    const relay = this.relayEnabled();

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
        const asDm = { ...invite, deliveredVia: "dm" as const };
        try {
          const channelId = await this.dmChannel(invite.recipient.id);
          const msg = await this.send(channelId, renderSummons(summons, invites, [asDm], this.bureau, now, { relay }));
          this.markDelivered(invite, "dm", channelId, msg.id);
          this.trackBotMessage(msg.id, invite.recipient.id, summons.organizer.id, id, now);
        } catch (e) {
          if (e instanceof DiscordError && e.cannotDm && summons.channelId) {
            try {
              const msg = await this.send(summons.channelId, renderSummons(summons, invites, [invite], this.bureau, now));
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

  /**
   * /summon used in a chat (often a personal DM): the summons message is the interaction
   * response, which the Worker sends. Here we only file it and plan the in-chat notices.
   */
  async issueHere(draft: SummonsDraft, context: HereContext): Promise<SummonsBundle> {
    const now = Date.now();
    this.checkRate(context.organizer.id, now);
    const id = this.insertSummons({ ...draft, delivery: "interaction", channelId: context.channelId }, context, now, context.token);
    this.sql.exec(
      "UPDATE invites SET delivered_via = 'interaction', channel_id = ?, next_nudge_at = ? WHERE summons_id = ?",
      context.channelId, draft.escalation === "off" ? null : now + WINDOW_GAP_MS, id,
    );
    this.log(id, null, "delivered", "Posted in the chat where /summon was used");
    await this.reschedule();
    return this.loadBundle(id)!;
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

  // --- interaction tokens (posting in the chat where /summon was used) ------------------

  /** Remembers the latest interaction on a /summon message: its token can edit that message and post follow-ups. */
  private noteVia(summons: Summons, invite: Invite | null, via: Via | null | undefined, now: number) {
    if (summons.delivery !== "interaction" || !via?.token) return;
    this.sql.exec(
      "UPDATE summons SET interaction_token = ?, interaction_expires = ?, interaction_followups = 0 WHERE id = ?",
      via.token, now + TOKEN_LIFETIME_MS, summons.id,
    );
    if (invite && via.messageId) this.sql.exec("UPDATE invites SET message_id = ? WHERE id = ?", via.messageId, invite.id);
  }

  /** A token that can still post `need` more follow-ups, if there is one. */
  private chatToken(summonsId: string, now: number, need = 1): ChatToken | null {
    const r = this.sql
      .exec("SELECT interaction_token, interaction_expires, interaction_followups FROM summons WHERE id = ?", summonsId)
      .toArray()[0];
    if (!r?.interaction_token) return null;
    const token = { token: s(r.interaction_token), expires: n(r.interaction_expires), followups: n(r.interaction_followups) };
    if (token.expires - now < 30_000 || token.followups + need > MAX_FOLLOWUPS) return null;
    return token;
  }

  private enqueueFollowup(summonsId: string, inviteId: string | null, token: ChatToken, message: MessagePayload, dueAt = Date.now()) {
    this.sql.exec("UPDATE summons SET interaction_followups = interaction_followups + 1 WHERE id = ?", summonsId);
    this.enqueue("followup", summonsId, inviteId, { token: token.token, message } satisfies WebhookPayload, dueAt);
  }

  // --- responses ---------------------------------------------------------------------

  async respond(summonsId: string, userId: string, kind: ResponseKind, note: string | null, via: Via | null): Promise<RespondResult> {
    const summons = this.loadSummons(summonsId);
    if (!summons) return { ok: false, reason: "not_found" };
    const row = this.sql.exec("SELECT * FROM invites WHERE summons_id = ? AND recipient_id = ?", summonsId, userId).toArray()[0];
    if (!row) return { ok: false, reason: "not_recipient", summons };
    if (summons.status !== "active") return { ok: false, reason: "inactive", summons, invites: this.loadInvites(summonsId) };
    if (!summons.options.some((o) => o.kind === kind)) return { ok: false, reason: "option_disabled", summons };

    const invite = toInvite(row);
    const cleanNote = NEEDS_NOTE[kind] ? clip((note ?? "").trim(), 300) || null : null;
    const changed = invite.status !== kind || invite.note !== cleanNote;
    const now = Date.now();
    const relay = this.relayEnabled();
    this.noteVia(summons, invite, via, now);

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
          summonsId, via?.messageId ?? null,
        ).rowsWritten;
        if (marked > 0) this.markSyncNeeded(summonsId, now + 1_000);
        this.log(summonsId, invite.id, "response", `${invite.recipient.name}: ${kind}${cleanNote ? ` — “${cleanNote}”` : ""}`, now);
        this.notePartner(summons.organizer.id, invite.recipient.id, summonsId, now);
      });

      const invites = this.loadInvites(summonsId);
      const updated = invites.find((i) => i.id === invite.id)!;
      const token = summons.delivery === "interaction" ? this.chatToken(summonsId, now) : null;
      if (token) {
        // They answered in the shared chat; tell the issuer right there (an edit alone doesn't notify).
        this.enqueueFollowup(summonsId, invite.id, token, renderInChatResponse(summons, updated));
      } else {
        this.enqueueDm(summonsId, invite.id, {
          to: summons.organizer.id,
          peer: invite.recipient.id,
          message: renderResponseNotice(summons, invites, updated, previous, this.bureau, { relay }),
        });
      }
      await this.reschedule();
      return { ok: true, summons, invites, invite: updated, changed, relay };
    }

    const invites = this.loadInvites(summonsId);
    return { ok: true, summons, invites, invite: invites.find((i) => i.id === invite.id)!, changed, relay };
  }

  async verdict(inviteId: string, userId: string, verdict: Verdict, via: Via | null = null): Promise<VerdictResult> {
    const row = this.sql.exec("SELECT * FROM invites WHERE id = ?", inviteId).toArray()[0];
    if (!row) return { ok: false, reason: "not_found" };
    const invite = toInvite(row);
    const summons = this.loadSummons(invite.summonsId);
    if (!summons) return { ok: false, reason: "not_found" };
    if (summons.organizer.id !== userId) return { ok: false, reason: "not_organizer" };
    if (invite.status !== "extend" || summons.status !== "active") return { ok: false, reason: "not_pending" };
    const now = Date.now();
    this.noteVia(summons, invite, via, now);

    if (invite.verdict !== verdict) {
      this.sql.exec("UPDATE invites SET verdict = ?, dirty = CASE WHEN message_id IS NULL THEN 0 ELSE 1 END WHERE id = ?", verdict, inviteId);
      this.log(summons.id, inviteId, "verdict", `Extension for ${invite.recipient.name} ${verdict}`);
      const updated = { ...invite, verdict };
      const token = summons.delivery === "interaction" ? this.chatToken(summons.id, now) : null;
      if (token) {
        this.enqueueFollowup(summons.id, inviteId, token, renderInChatVerdict(summons, updated));
      } else {
        this.enqueueDm(summons.id, inviteId, {
          to: invite.recipient.id,
          peer: summons.organizer.id,
          message: renderVerdictNotice(summons, updated),
          fallbackChannelId: invite.deliveredVia === "channel" ? invite.channelId : null,
        });
      }
      if (summons.delivery !== "interaction") this.markSyncNeeded(summons.id, now + 1_000);
      else this.sql.exec("UPDATE invites SET dirty = 0 WHERE id = ?", inviteId); // the click response re-renders it
      await this.reschedule();
    }
    const invites = this.loadInvites(summons.id);
    return { ok: true, summons, invites, invite: invites.find((i) => i.id === inviteId)!, relay: this.relayEnabled() };
  }

  /** 🔔 on a /summon message: an immediate notice in the chat, then a fresh round of automatic ones. */
  async ringBell(summonsId: string, userId: string, via: Via): Promise<BellResult> {
    const summons = this.loadSummons(summonsId);
    if (!summons) return { ok: false, reason: "not_found" };
    const invites = this.loadInvites(summonsId);
    const invite = invites[0];
    if (!invite) return { ok: false, reason: "not_found" };
    if (summons.organizer.id !== userId) return { ok: false, reason: "not_organizer" };
    if (summons.status !== "active") return { ok: false, reason: "inactive", summons, invites };
    if (invite.status !== "pending") return { ok: false, reason: "answered", invite };
    const now = Date.now();
    const last = this.sql.exec("SELECT MAX(at) AS at FROM log WHERE summons_id = ? AND kind = 'manual_nudge'", summonsId).one().at;
    if (last != null && now - Number(last) < MANUAL_NUDGE_COOLDOWN_MS) return { ok: false, reason: "cooldown" };

    this.noteVia(summons, invite, via, now);
    const token = this.chatToken(summonsId, now);
    if (token) this.enqueueFollowup(summonsId, invite.id, token, renderNudge(summons, invite, invite.nudgesSent, false, true));
    this.sql.exec(
      "UPDATE invites SET nudges_sent = nudges_sent + 1, window_nudges = window_nudges + 1, next_nudge_at = ? WHERE id = ?",
      Math.min(now + WINDOW_GAP_MS, nudgeCutoff(summons)), invite.id,
    );
    this.log(summonsId, invite.id, "manual_nudge", `🔔 Bell rung: notice sent to ${invite.recipient.name} in the chat`, now);
    await this.reschedule();
    const fresh = this.loadInvites(summonsId);
    return { ok: true, summons, invites: fresh, invite: fresh[0]! };
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
        `UPDATE invites SET next_nudge_at = NULL,
           dirty = CASE WHEN message_id IS NULL AND delivered_via != 'interaction' THEN 0 ELSE 1 END
         WHERE summons_id = ?`,
        summonsId,
      );
      this.log(summonsId, null, "cancelled", "Cancelled by the issuing officer", now);
    });
    const cancelled = this.loadSummons(summonsId)!;
    let count = 0;
    for (const invite of this.loadInvites(summonsId)) {
      if (invite.status === "no" || invite.deliveredVia === "failed" || invite.deliveredVia === "pending") continue;
      const token = invite.deliveredVia === "interaction" ? this.chatToken(summonsId, now, 2) : null;
      if (token) {
        this.enqueueFollowup(summonsId, invite.id, token, renderInChatCancel(cancelled, invite));
      } else {
        this.enqueueDm(summonsId, invite.id, {
          to: invite.recipient.id,
          peer: summons.organizer.id,
          message: renderCancelNotice(cancelled, invite),
          fallbackChannelId: invite.deliveredVia === "channel" ? invite.channelId : null,
        });
      }
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
      this.sendNudge(summons, invite, invite.nudgesSent, false, now);
      count++;
    }
    if (!count) return { ok: false, reason: "Nobody is waiting to respond." };
    this.log(summonsId, null, "manual_nudge", `Reminder sent to ${count} ${count === 1 ? "person" : "people"}`, now);
    await this.reschedule();
    return { ok: true, count };
  }

  /** In the shared chat when /summon's token still works, otherwise by the bot's DM. */
  private sendNudge(summons: Summons, invite: Invite, n: number, final: boolean, now: number) {
    const token = invite.deliveredVia === "interaction" ? this.chatToken(summons.id, now) : null;
    if (token) {
      this.enqueueFollowup(summons.id, invite.id, token, renderNudge(summons, invite, n, final, true), now);
      this.sql.exec("UPDATE invites SET nudges_sent = nudges_sent + 1, window_nudges = window_nudges + 1 WHERE id = ?", invite.id);
      return;
    }
    this.enqueueDm(summons.id, invite.id, {
      to: invite.recipient.id,
      peer: summons.organizer.id,
      message: renderNudge(summons, invite, n, final),
      fallbackChannelId: summons.delivery === "interaction" ? null : summons.channelId,
    }, now);
    this.sql.exec("UPDATE invites SET nudges_sent = nudges_sent + 1 WHERE id = ?", invite.id);
  }

  // --- the DM relay --------------------------------------------------------------------

  /** Someone typed in their DM with the bot: pass it on to whoever they're dealing with. */
  async relayIncoming(m: IncomingDm): Promise<RelayOutcome> {
    if (!this.relayEnabled()) return "ignored";
    const now = Date.now();
    const fresh = this.sql.exec("INSERT OR IGNORE INTO relay_seen (message_id, at) VALUES (?, ?)", m.id, now).rowsWritten;
    if (!fresh) return "duplicate";
    this.noteDmChannel(m.author.id, m.channelId, now, m.id);

    const route = this.routeFor(m.author.id, m.replyTo, now);
    if (!route) {
      const r = this.sql.exec("SELECT help_at FROM dm_channels WHERE user_id = ?", m.author.id).toArray()[0];
      if (!r?.help_at || now - n(r.help_at) > HELP_COOLDOWN_MS) {
        this.sql.exec("UPDATE dm_channels SET help_at = ? WHERE user_id = ?", now, m.author.id);
        await this.send(m.channelId, renderRelayHelp()).catch((e) => console.error("relay help failed", e));
      }
      return "help";
    }

    const ref = route.summonsId ? this.loadSummons(route.summonsId)?.ref ?? null : null;
    try {
      const channelId = await this.dmChannel(route.to);
      const sent = await this.send(channelId, renderForward(m.author.name, m.content, m.attachments, m.stickers, ref));
      this.trackBotMessage(sent.id, route.to, m.author.id, route.summonsId, now);
      this.notePartner(m.author.id, route.to, route.summonsId, now);
      this.notePartner(route.to, m.author.id, route.summonsId, now);
      await this.api.addReaction(m.channelId, m.id, "📨").catch(() => undefined);
      // Say who's getting their messages whenever that changes, so nothing goes somewhere unexpected.
      const last = this.sql.exec("SELECT last_target FROM dm_channels WHERE user_id = ?", m.author.id).toArray()[0];
      if (sn(last?.last_target) !== route.to) {
        this.sql.exec("UPDATE dm_channels SET last_target = ? WHERE user_id = ?", route.to, m.author.id);
        await this.send(m.channelId, renderRelayRouted(this.nameOf(route.to), ref)).catch((e) => console.error("relay notice failed", e));
      }
      return "forwarded";
    } catch (e) {
      if (e instanceof DiscordError && e.cannotDm) {
        await this.send(m.channelId, renderRelayFailed(this.nameOf(route.to))).catch(() => undefined);
        return "failed";
      }
      // Let a later catch-up try again.
      if (isRetryable(e)) this.sql.exec("DELETE FROM relay_seen WHERE message_id = ?", m.id);
      throw e;
    }
  }

  /** After a fresh Gateway session: forward whatever people typed while we weren't listening. */
  async relayCatchUp(): Promise<number> {
    if (!this.relayEnabled()) return 0;
    const now = Date.now();
    const channels = this.sql
      .exec(
        "SELECT user_id, channel_id, last_seen FROM dm_channels WHERE last_seen IS NOT NULL AND active_at > ? ORDER BY active_at DESC LIMIT 10",
        now - 7 * 86_400_000,
      )
      .toArray();
    let forwarded = 0;
    for (const c of channels) {
      if (forwarded >= 8) break;
      let messages;
      try {
        messages = await this.api.channelMessages(s(c.channel_id), s(c.last_seen), 20);
      } catch (e) {
        console.error("catch-up fetch failed", e);
        continue;
      }
      const missed = messages
        .map((m) => toIncomingDm({ ...m, channel_id: m.channel_id ?? s(c.channel_id) }))
        .filter((m): m is IncomingDm => m !== null)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const m of missed) {
        if (forwarded >= 8) break;
        try {
          if ((await this.relayIncoming(m)) === "forwarded") forwarded++;
        } catch (e) {
          console.error("catch-up relay failed", e);
        }
      }
    }
    return forwarded;
  }

  /**
   * Who a typed message is for. A reply goes to whoever the replied-to message came from.
   * Otherwise it goes to whoever the bot last brought them something from (the last notice sender),
   * or the person they last summoned or messaged, whichever is more recent. Never back to the sender.
   */
  private routeFor(userId: string, replyTo: string | null, now: number): { to: string; summonsId: string | null } | null {
    if (replyTo) {
      const r = this.sql.exec("SELECT peer_id, summons_id FROM bot_messages WHERE message_id = ? AND user_id = ?", replyTo, userId).toArray()[0];
      if (r?.peer_id && s(r.peer_id) !== userId) return { to: s(r.peer_id), summonsId: sn(r.summons_id) };
    }
    const since = now - PARTNER_TTL_MS;
    const candidates = [
      ...this.sql
        .exec(
          `SELECT peer_id AS who, summons_id, at FROM bot_messages
           WHERE user_id = ? AND peer_id IS NOT NULL AND peer_id != ? AND at > ? ORDER BY at DESC LIMIT 1`,
          userId, userId, since,
        )
        .toArray(),
      ...this.sql
        .exec("SELECT partner_id AS who, summons_id, at FROM relay_partners WHERE user_id = ? AND partner_id != ? AND at > ?", userId, userId, since)
        .toArray(),
    ].sort((a, b) => n(b.at) - n(a.at));
    const best = candidates[0];
    return best ? { to: s(best.who), summonsId: sn(best.summons_id) } : null;
  }

  private nameOf(userId: string): string {
    const r = this.sql
      .exec(
        `SELECT name FROM (
           SELECT organizer_name AS name, created_at AS at FROM summons WHERE organizer_id = ?
           UNION ALL SELECT i.recipient_name, s.created_at FROM invites i JOIN summons s ON s.id = i.summons_id WHERE i.recipient_id = ?
         ) ORDER BY at DESC LIMIT 1`,
        userId, userId,
      )
      .toArray()[0];
    return r ? s(r.name) : "them";
  }

  private notePartner(userId: string, partnerId: string, summonsId: string | null, now: number) {
    if (userId === partnerId) return; // summoning yourself is a test, not a conversation
    this.sql.exec(
      `INSERT INTO relay_partners (user_id, partner_id, summons_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET partner_id = excluded.partner_id, summons_id = excluded.summons_id, at = excluded.at`,
      userId, partnerId, summonsId, now,
    );
  }

  /** Remembers a user's DM channel with the bot, and the newest message of theirs we've handled. */
  private noteDmChannel(userId: string, channelId: string, now: number, seenId: string | null) {
    const r = this.sql.exec("SELECT last_seen FROM dm_channels WHERE user_id = ?", userId).toArray()[0];
    const lastSeen = seenId ? laterId(sn(r?.last_seen), seenId) : sn(r?.last_seen);
    this.sql.exec(
      `INSERT INTO dm_channels (user_id, channel_id, last_seen, active_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET channel_id = excluded.channel_id, last_seen = excluded.last_seen, active_at = excluded.active_at`,
      userId, channelId, lastSeen, now,
    );
  }

  private async dmChannel(userId: string): Promise<string> {
    const r = this.sql.exec("SELECT channel_id FROM dm_channels WHERE user_id = ?", userId).toArray()[0];
    if (r) return s(r.channel_id);
    const channel = await this.api.openDm(userId);
    this.noteDmChannel(userId, channel.id, Date.now(), null);
    return channel.id;
  }

  private trackBotMessage(messageId: string, userId: string, peerId: string | null, summonsId: string | null, now: number) {
    this.sql.exec(
      "INSERT OR REPLACE INTO bot_messages (message_id, user_id, peer_id, summons_id, at) VALUES (?, ?, ?, ?, ?)",
      messageId, userId, peerId, summonsId, now,
    );
    // Catch-up starts after the bot's first message in a conversation it hasn't heard back from yet.
    this.sql.exec("UPDATE dm_channels SET last_seen = COALESCE(last_seen, ?), active_at = ? WHERE user_id = ?", messageId, now, userId);
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
      this.prune(now);
    } finally {
      this.running = false;
      await this.reschedule();
    }
  }

  private prune(now: number) {
    if (now - Number(this.getSetting("pruned_at") ?? 0) < 3_600_000) return;
    this.sql.exec("DELETE FROM relay_seen WHERE at < ?", now - 3 * 86_400_000);
    this.sql.exec("DELETE FROM bot_messages WHERE at < ?", now - 60 * 86_400_000);
    this.setSettingSync("pruned_at", String(now));
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
          `UPDATE invites SET next_nudge_at = NULL,
             dirty = CASE WHEN message_id IS NULL AND delivered_via != 'interaction' THEN 0 ELSE 1 END
           WHERE summons_id = ?`,
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
          peer: summons.organizer.id,
          message: renderReminder(summons, invite),
          fallbackChannelId: invite.deliveredVia === "channel" ? invite.channelId : null,
        }, now);
        count++;
      }
      this.enqueueDm(summons.id, null, {
        to: summons.organizer.id,
        peer: invites.length === 1 ? invites[0]!.recipient.id : null,
        message: renderBriefing(summons, invites, this.bureau),
      }, now);
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
      const row = this.sql.exec("SELECT * FROM invites WHERE id = ?", s(r.invite_id)).one();
      const invite = toInvite(row);
      const info = ESCALATION_INFO[summons.escalation];
      const cutoff = nudgeCutoff(summons);
      if (now >= cutoff) {
        this.sql.exec("UPDATE invites SET next_nudge_at = NULL WHERE id = ?", invite.id);
        continue;
      }

      // /summon in a chat: a burst of notices right there while its interaction token lasts.
      if (invite.deliveredVia === "interaction") {
        const token = this.chatToken(summons.id, now);
        if (token && token.followups < WINDOW_NOTICES) {
          this.enqueueFollowup(summons.id, invite.id, token, renderNudge(summons, invite, invite.nudgesSent, false, true), now);
          let next: number | null = now + WINDOW_GAP_MS;
          if (token.followups + 1 >= WINDOW_NOTICES || next > token.expires - 30_000) {
            // Window over: carry on by the bot's DM, on the normal escalation schedule.
            next = info.maxNotices ? now + info.intervalMin * 60_000 : null;
          }
          this.sql.exec(
            "UPDATE invites SET nudges_sent = nudges_sent + 1, window_nudges = window_nudges + 1, next_nudge_at = ? WHERE id = ?",
            next !== null && next < cutoff ? next : null, invite.id,
          );
          this.log(summons.id, invite.id, "nudge", `Notice #${invite.nudgesSent + 2} posted in the chat`, now);
          continue;
        }
      }

      const byDm = invite.nudgesSent - n(row.window_nudges);
      if (byDm >= info.maxNotices) {
        this.sql.exec("UPDATE invites SET next_nudge_at = NULL WHERE id = ?", invite.id);
        continue;
      }
      const final = byDm + 1 >= info.maxNotices;
      this.enqueueDm(summons.id, invite.id, {
        to: invite.recipient.id,
        peer: summons.organizer.id,
        message: renderNudge(summons, invite, invite.nudgesSent, final),
        fallbackChannelId: summons.delivery === "interaction" ? null : summons.channelId,
      }, now);
      const next = now + info.intervalMin * 60_000;
      this.sql.exec(
        "UPDATE invites SET nudges_sent = nudges_sent + 1, next_nudge_at = ? WHERE id = ?",
        final || next >= cutoff ? null : next, invite.id,
      );
      this.log(summons.id, invite.id, "nudge", `${final ? "Final notice" : `Notice #${invite.nudgesSent + 2}`} sent to ${invite.recipient.name}`, now);
    }
  }

  private enqueueDm(summonsId: string | null, inviteId: string | null, payload: DmPayload, dueAt = Date.now()) {
    this.enqueue("dm", summonsId, inviteId, payload, dueAt);
  }

  private enqueue(kind: OutboxKind, summonsId: string | null, inviteId: string | null, payload: unknown, dueAt = Date.now()) {
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
    const appId = cfg(this.env, "DISCORD_APPLICATION_ID");
    for (const item of items) {
      if (budget < 3) break;
      try {
        if (item.kind === "dm") {
          budget -= 2;
          await this.deliverDm(JSON.parse(item.payload) as DmPayload, item.summons_id, () => budget--);
        } else if (item.kind === "delete_event") {
          budget -= 1;
          const p = JSON.parse(item.payload) as { guildId: string; eventId: string };
          await this.api.deleteScheduledEvent(p.guildId, p.eventId).catch((e) => {
            if (!(e instanceof DiscordError && e.status === 404)) throw e;
          });
        } else if (item.kind === "followup" || item.kind === "edit_original") {
          budget -= 1;
          const p = JSON.parse(item.payload) as WebhookPayload;
          const hooks = DiscordApi.webhooks(this.env);
          if (item.kind === "followup") await hooks.followup(appId, p.token, p.message);
          else await hooks.editOriginal(appId, p.token, p.message);
        }
        this.sql.exec("DELETE FROM outbox WHERE id = ?", item.id);
      } catch (e) {
        const attempts = n(item.attempts) + 1;
        if (attempts >= MAX_OUTBOX_ATTEMPTS || !isRetryable(e)) {
          this.sql.exec("DELETE FROM outbox WHERE id = ?", item.id);
          if (item.summons_id) this.log(item.summons_id, item.invite_id, "notify_failed", errorText(e));
          if (item.kind === "dm" && e instanceof DiscordError && e.cannotDm && item.summons_id && item.invite_id) {
            this.markUnreachable(item.summons_id, item.invite_id, (JSON.parse(item.payload) as DmPayload).to);
          }
        } else {
          const retryAt = Date.now() + 30_000 * 2 ** (attempts - 1);
          this.sql.exec("UPDATE outbox SET attempts = ?, due_at = ?, last_error = ? WHERE id = ?", attempts, retryAt, errorText(e), item.id);
        }
      }
    }
    return budget;
  }

  /**
   * The bot can't DM this recipient any more (blocked, left the server, or closed DMs).
   * Respect that: stop the notices, and tell the issuer once so they can sort it out in person.
   */
  private markUnreachable(summonsId: string, inviteId: string, userId: string) {
    const invite = this.loadInvites(summonsId).find((i) => i.id === inviteId);
    const summons = this.loadSummons(summonsId);
    if (!invite || !summons || invite.recipient.id !== userId) return;
    const already = this.sql.exec("SELECT 1 FROM log WHERE invite_id = ? AND kind = 'unreachable'", inviteId).toArray().length > 0;
    this.sql.exec("UPDATE invites SET next_nudge_at = NULL WHERE id = ?", inviteId);
    if (already) return;
    this.log(summonsId, inviteId, "unreachable", `The Bureau can't reach ${invite.recipient.name} any more; notices stopped`);
    if (summons.organizer.id === userId) return;
    this.enqueueDm(summonsId, null, {
      to: summons.organizer.id,
      message: renderUnreachable(summons, invite),
    });
  }

  private async deliverDm(p: DmPayload, summonsId: string | null, spend: () => void): Promise<void> {
    try {
      const channelId = await this.dmChannel(p.to);
      const sent = await this.send(channelId, p.message);
      this.trackBotMessage(sent.id, p.to, p.peer ?? null, summonsId, Date.now());
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
    const relay = this.relayEnabled();
    for (const r of due) {
      const id = s(r.id);
      const summons = this.loadSummons(id)!;
      const invites = this.loadInvites(id);
      const dirty = this.sql
        .exec("SELECT * FROM invites WHERE summons_id = ? AND dirty = 1", id)
        .toArray()
        .map(toInvite);

      // /summon messages can only be edited through a live interaction token.
      for (const invite of dirty.filter((i) => i.deliveredVia === "interaction")) {
        const token = this.chatToken(id, now, 0);
        if (token) {
          this.enqueue("edit_original", id, invite.id, {
            token: token.token,
            message: renderSummons(summons, invites, [invite], this.bureau, now),
          } satisfies WebhookPayload, now);
        }
        this.sql.exec("UPDATE invites SET dirty = 0 WHERE id = ?", invite.id);
      }

      const groups = new Map<string, Invite[]>();
      for (const invite of dirty) {
        if (invite.deliveredVia === "interaction" || !invite.channelId || !invite.messageId) continue;
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
          await this.edit(channelId, messageId, renderSummons(summons, invites, addressees, this.bureau, now, { relay }));
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

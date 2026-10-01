import {
  ESCALATION_INFO,
  PRIORITY_INFO,
  formatDuration,
  optionFor,
  type Invite,
  type InviteStatus,
  type ResponseKind,
  type ResponseOption,
  type Summons,
  type Verdict,
} from "./model";
import { messageLink } from "./discord";

export const EPHEMERAL = 1 << 6;

export const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 } as const;
export type ButtonStyle = (typeof ButtonStyle)[keyof typeof ButtonStyle];

export interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  author?: { name: string; icon_url?: string; url?: string };
  thumbnail?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
}

export interface Button {
  type: 2;
  style: ButtonStyle;
  label: string;
  emoji?: { name: string };
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface ActionRow {
  type: 1;
  components: Button[];
}

export interface MessagePayload {
  content?: string;
  embeds?: Embed[];
  components?: ActionRow[];
  allowed_mentions?: { parse: string[]; users?: string[] };
  flags?: number;
}

const GREY = 0x4e5058;
const GREEN = 0x57f287;
const RED = 0xed4245;
const BLURPLE = 0x5865f2;
const YELLOW = 0xfee75c;

export const STATUS_INFO: Record<InviteStatus, { label: string; color: number; emoji: string }> = {
  pending: { label: "AWAITING RESPONSE", color: GREY, emoji: "📭" },
  yes: { label: "ACCEPTED", color: GREEN, emoji: "✅" },
  no: { label: "DECLINED", color: RED, emoji: "❌" },
  excuse: { label: "EXCUSE FILED", color: YELLOW, emoji: "🤡" },
  extend: { label: "EXTENSION REQUESTED", color: BLURPLE, emoji: "⏳" },
};

const BUTTON_STYLE: Record<ResponseKind, ButtonStyle> = {
  yes: ButtonStyle.Success,
  no: ButtonStyle.Danger,
  excuse: ButtonStyle.Secondary,
  extend: ButtonStyle.Primary,
};

// --- formatting helpers -------------------------------------------------------

export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

export function ts(ms: number, style: "t" | "T" | "d" | "D" | "f" | "F" | "R" = "F"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function mention(id: string): string {
  return `<@${id}>`;
}

export function sealUrl(origin: string): string {
  return `${origin}/static/seal.png`;
}

export function dossierUrl(s: Pick<Summons, "origin" | "id">): string {
  return `${s.origin}/s/${s.id}`;
}

/** Emoji shown for a status — the organizer's custom button emoji when there is one. */
export function statusEmoji(s: Pick<Summons, "options">, status: InviteStatus): string {
  if (status === "pending") return STATUS_INFO.pending.emoji;
  return optionFor(s, status).emoji || STATUS_INFO[status].emoji;
}

export function tally(s: Pick<Summons, "options">, invites: Invite[]): string {
  const order: InviteStatus[] = ["yes", "no", "excuse", "extend", "pending"];
  const parts: string[] = [];
  for (const status of order) {
    const n = invites.filter((i) => i.status === status).length;
    if (n || status === "yes" || status === "pending") parts.push(`${statusEmoji(s, status)} ${n}`);
  }
  return parts.join(" · ");
}

function verdictLine(verdict: Verdict | null): string {
  if (verdict === "granted") return "Verdict: ✅ **GRANTED**";
  if (verdict === "denied") return "Verdict: ❌ **DENIED**";
  return "Verdict: 🕐 pending review by the issuing officer";
}

function statusLine(s: Summons, invite: Invite, now: number, personal: boolean): string {
  const emoji = statusEmoji(s, invite.status);
  switch (invite.status) {
    case "pending": {
      if (s.status === "closed") return "❗ **NO RESPONSE** — noted in the permanent record";
      if (s.status === "cancelled") return `${emoji} No response required`;
      const overdue = s.respondBy && now > s.respondBy ? " — ⚠️ **OVERDUE**" : "";
      return `${emoji} **${personal ? "AWAITING YOUR RESPONSE" : "AWAITING RESPONSE"}**${overdue}`;
    }
    case "yes":
    case "no":
      return `${emoji} **${STATUS_INFO[invite.status].label}** — logged ${invite.respondedAt ? ts(invite.respondedAt, "R") : ""}`.trim();
    case "excuse":
      return `${emoji} **EXCUSE FILED** — under review by the Committee\n${quote(`“${clip(invite.note ?? "", 300)}”`)}`;
    case "extend":
      return `${emoji} **EXTENSION REQUESTED**\n${quote(`“${clip(invite.note ?? "", 150)}”`)}\n${verdictLine(invite.verdict)}`;
  }
}

function rosterLine(s: Summons, invite: Invite): string {
  const who = mention(invite.recipient.id);
  const emoji = statusEmoji(s, invite.status);
  switch (invite.status) {
    case "pending":
      return s.status === "closed" ? `❗ ${who} — no response` : `${emoji} ${who} — awaiting response`;
    case "yes":
      return `${emoji} ${who} — accepted`;
    case "no":
      return `${emoji} ${who} — declined`;
    case "excuse":
      return `${emoji} ${who} — “${clip(invite.note ?? "", 40)}”`;
    case "extend": {
      const v = invite.verdict === "granted" ? " (granted)" : invite.verdict === "denied" ? " (denied)" : "";
      return `${emoji} ${who} — wants more time${v}`;
    }
  }
}

function fieldValue(text: string): string {
  return clip(text || "—", 1024);
}

// --- the summons itself ---------------------------------------------------------

/**
 * Renders the official summons. `addressees` are the invites this particular message is
 * addressed to: one for a DM, all of them for a shared channel post.
 */
export interface RenderOptions {
  /** The bot forwards DM replies to the issuer; say so on summonses delivered by DM. */
  relay?: boolean;
}

export function renderSummons(
  s: Summons,
  invites: Invite[],
  addressees: Invite[],
  bureau: string,
  now = Date.now(),
  opts: RenderOptions = {},
): MessagePayload {
  const ids = addressees.map((i) => i.recipient.id);
  const mentions = ids.map(mention).join(" ");
  const priority = PRIORITY_INFO[s.priority];
  const personal = addressees.length === 1 ? addressees[0] : undefined;

  let content: string;
  if (s.status === "cancelled") content = `🗂️ **SUMMONS WITHDRAWN** — ${mentions}, this summons was cancelled by the issuing officer.`;
  else if (s.status === "closed") content = `📁 **FILE CLOSED** — ${mentions}, this summons is no longer accepting responses.`;
  else content = `📨 **OFFICIAL SUMMONS** — ${mentions}, your presence has been formally requested. A response is required.`;
  if (opts.relay && s.status === "active" && personal?.deliveredVia === "dm") {
    content += `\n-# 💬 Questions? Reply to this message and the Bureau will pass it on to ${clip(s.organizer.name, 40)}.`;
  }

  const description = [`**${clip(s.title, 200)}**`];
  if (s.objective) description.push("", quote(clip(s.objective, 1000)));
  description.push("", `**Personnel requested:** ${invites.map((i) => mention(i.recipient.id)).join(", ")}`);

  const fields: NonNullable<Embed["fields"]> = [
    { name: "🗓️ Commences", value: `${ts(s.startsAt, "F")}\n${ts(s.startsAt, "R")}`, inline: true },
    { name: "⏱️ Est. duration", value: formatDuration(s.durationMin), inline: true },
    { name: "📍 Location", value: fieldValue(s.location || "To be disclosed"), inline: true },
    { name: "🚨 Priority", value: `${priority.emoji} ${priority.label}`, inline: true },
  ];
  if (s.dressCode) fields.push({ name: "👔 Dress code", value: fieldValue(s.dressCode), inline: true });
  if (s.respondBy) fields.push({ name: "⌛ Respond by", value: `${ts(s.respondBy, "f")}\n${ts(s.respondBy, "R")}`, inline: true });
  fields.push(
    {
      name: "🖋️ Issued by",
      value: fieldValue(`${mention(s.organizer.id)}${s.signatureTitle ? `\n*${s.signatureTitle}*` : ""}`),
      inline: true,
    },
    { name: "🗂️ Reference", value: `\`${s.ref}\``, inline: true },
  );

  let status: string;
  if (s.status === "cancelled") status = "🗂️ **CANCELLED** — you are released from duty";
  else if (personal) status = statusLine(s, personal, now, true);
  else status = tally(s, invites);
  if (s.status === "closed" && !personal) status = `📁 **FILE CLOSED** · ${tally(s, invites)}`;
  fields.push({ name: "📌 Status", value: fieldValue(status), inline: false });

  if (invites.length > 1) {
    fields.push({ name: "📋 Roster", value: fieldValue(invites.map((i) => rosterLine(s, i)).join("\n")), inline: false });
  }

  const active = s.status === "active";
  const embed: Embed = {
    author: { name: clip(`${bureau.toUpperCase()} · FORM BMA-27`, 256), icon_url: sealUrl(s.origin) },
    title: clip(`${priority.emoji} ${s.classification}`, 256),
    url: dossierUrl(s),
    description: clip(description.join("\n"), 4096),
    color: active ? priority.color : GREY,
    thumbnail: { url: sealUrl(s.origin) },
    fields,
    footer: {
      text: active
        ? `Ref. ${s.ref} · Failure to respond may result in public disappointment.`
        : `Ref. ${s.ref} · This file is closed.`,
    },
    timestamp: new Date(s.createdAt).toISOString(),
  };

  const components = [responseRow(s, !active)];
  if (s.delivery === "interaction" && active && personal) {
    // Posted in a chat both people can see: the issuer rules on extensions and rings the bell right there.
    if (personal.status === "extend" && !personal.verdict) {
      components.push({
        type: 1,
        components: [
          { type: 2, style: ButtonStyle.Success, label: "Grant extension", emoji: { name: "✅" }, custom_id: `xs:${personal.id}:granted` },
          { type: 2, style: ButtonStyle.Danger, label: "Deny extension", emoji: { name: "⛔" }, custom_id: `xs:${personal.id}:denied` },
        ],
      });
    }
    if (personal.status === "pending") {
      components.push({
        type: 1,
        components: [{ type: 2, style: ButtonStyle.Secondary, label: "Ring the bell (issuer only)", emoji: { name: "🔔" }, custom_id: `n:${s.id}` }],
      });
    }
  }

  return {
    content,
    embeds: [embed],
    components,
    allowed_mentions: { parse: [], users: ids },
  };
}

export function responseRow(s: Pick<Summons, "id" | "options">, disabled = false): ActionRow {
  return {
    type: 1,
    components: s.options.map((o) => responseButton(s.id, o, disabled)),
  };
}

function responseButton(summonsId: string, o: ResponseOption, disabled: boolean): Button {
  const b: Button = {
    type: 2,
    style: BUTTON_STYLE[o.kind],
    label: o.label,
    custom_id: `r:${summonsId}:${o.kind}`,
  };
  if (o.emoji) b.emoji = { name: o.emoji };
  if (disabled) b.disabled = true;
  return b;
}

/** Fallback when Discord rejects a button emoji: move the emoji into the label. */
export function withoutButtonEmoji(message: MessagePayload): MessagePayload {
  return {
    ...message,
    components: message.components?.map((row) => ({
      ...row,
      components: row.components.map(({ emoji, ...b }) => ({
        ...b,
        label: emoji ? clip(`${emoji.name} ${b.label}`, 80) : b.label,
      })),
    })),
  };
}

// --- modals ---------------------------------------------------------------------

export function renderModal(s: Pick<Summons, "id" | "options">, kind: "excuse" | "extend") {
  const option = optionFor(s, kind);
  if (kind === "excuse") {
    return {
      custom_id: `m:${s.id}:excuse`,
      title: "Form 12-C · Statement of Excuse",
      components: [
        {
          type: 10,
          content: `-# You selected **${clip(option.label, 60)}**. Excuses are reviewed by the Committee within 3–5 business days.`,
        },
        {
          type: 18,
          label: "State your excuse for the record",
          description: "Be specific. The Committee has heard “I'm tired” before.",
          component: {
            type: 4,
            custom_id: "note",
            style: 2,
            min_length: 3,
            max_length: 300,
            required: true,
            placeholder: "e.g. my cat scheduled a meeting with me",
          },
        },
      ],
    };
  }
  return {
    custom_id: `m:${s.id}:extend`,
    title: "Form 7-E · Request for Extension",
    components: [
      {
        type: 10,
        content: `-# You selected **${clip(option.label, 60)}**. Extensions are granted at the sole discretion of the issuing officer.`,
      },
      {
        type: 18,
        label: "How much extra time do you need?",
        description: "A time, a delay, or a reason. Honesty is appreciated.",
        component: {
          type: 4,
          custom_id: "note",
          style: 1,
          min_length: 2,
          max_length: 150,
          required: true,
          placeholder: "e.g. 30 minutes, still in the shower",
        },
      },
    ],
  };
}

// --- notices to the organizer -------------------------------------------------------

function linkButton(label: string, url: string, emoji?: string): Button {
  const b: Button = { type: 2, style: ButtonStyle.Link, label, url };
  if (emoji) b.emoji = { name: emoji };
  return b;
}

export function renderResponseNotice(
  s: Summons,
  invites: Invite[],
  invite: Invite,
  previous: InviteStatus,
  bureau: string,
  opts: RenderOptions = {},
): MessagePayload {
  const info = STATUS_INFO[invite.status];
  const option = invite.status === "pending" ? null : optionFor(s, invite.status);
  const lines = [`${statusEmoji(s, invite.status)} **${info.label}**${option ? ` · “${clip(option.label, 60)}”` : ""}`];
  if (invite.note) lines.push(quote(`“${clip(invite.note, 300)}”`));
  if (previous !== "pending" && previous !== invite.status) lines.push(`*Amended from ${STATUS_INFO[previous].label.toLowerCase()}*`);
  if (invite.status === "extend") lines.push("", verdictLine(invite.verdict));

  const buttons: Button[] = [];
  if (invite.status === "extend" && !invite.verdict && s.status === "active") {
    buttons.push(
      { type: 2, style: ButtonStyle.Success, label: "Grant extension", emoji: { name: "✅" }, custom_id: `x:${invite.id}:granted` },
      { type: 2, style: ButtonStyle.Danger, label: "Deny extension", emoji: { name: "⛔" }, custom_id: `x:${invite.id}:denied` },
    );
  }
  buttons.push(linkButton("Open dossier", dossierUrl(s), "🗂️"));

  let content = `📬 **Response received** — ${mention(invite.recipient.id)} answered summons **${s.ref}**`;
  if (opts.relay) content += `\n-# 💬 Reply to this message to answer ${clip(invite.recipient.name, 40)}.`;
  return {
    content,
    embeds: [
      {
        author: { name: clip(`${bureau.toUpperCase()} · RESPONSE DESK`, 256), icon_url: sealUrl(s.origin) },
        title: clip(`${s.classification} — ${s.title}`, 256),
        url: dossierUrl(s),
        description: clip(lines.join("\n"), 4096),
        color: info.color,
        fields: [{ name: "📋 Tally", value: tally(s, invites), inline: false }],
        footer: { text: `Ref. ${s.ref}` },
        timestamp: new Date(invite.respondedAt ?? Date.now()).toISOString(),
      },
    ],
    components: [{ type: 1, components: buttons }],
    allowed_mentions: { parse: [] },
  };
}

export function renderBriefing(s: Summons, invites: Invite[], bureau: string): MessagePayload {
  return {
    content: `📋 **Pre-operation briefing** — **${s.ref}** commences ${ts(s.startsAt, "R")}.`,
    embeds: [
      {
        author: { name: clip(`${bureau.toUpperCase()} · BRIEFING ROOM`, 256), icon_url: sealUrl(s.origin) },
        title: clip(`${s.classification} — ${s.title}`, 256),
        url: dossierUrl(s),
        color: PRIORITY_INFO[s.priority].color,
        fields: [
          { name: "📋 Roster", value: fieldValue(invites.map((i) => rosterLine(s, i)).join("\n")), inline: false },
          { name: "Tally", value: tally(s, invites), inline: false },
        ],
        footer: { text: `Ref. ${s.ref}` },
      },
    ],
    components: [{ type: 1, components: [linkButton("Open dossier", dossierUrl(s), "🗂️")] }],
    allowed_mentions: { parse: [] },
  };
}

// --- notices to recipients ----------------------------------------------------------

function jumpRow(s: Summons, invite: Invite, label: string): ActionRow[] {
  if (!invite.channelId || !invite.messageId) return [];
  const guildId = invite.deliveredVia === "channel" ? s.guildId : null;
  return [{ type: 1, components: [linkButton(label, messageLink(guildId, invite.channelId, invite.messageId), "📨")] }];
}

const NUDGE_LINES = [
  "Please respond at your earliest convenience. The Bureau thanks you for your cooperation.",
  "Your continued silence has been noted. The Bureau is beginning to lose patience.",
  "The Bureau does not forget. Silence is not an accepted response format.",
  "This matter has been escalated to a supervisor, who is also disappointed.",
  "Our records show you were last seen online. We know you saw this.",
];

const NUDGE_TITLES = ["📮 SECOND NOTICE", "⚠️ THIRD NOTICE", "🔔 FOURTH NOTICE", "🔔 FIFTH NOTICE", "🔔 SIXTH NOTICE"];

/** `n` is how many follow-up notices were sent before this one. `inChat` notices sit right under the summons. */
export function renderNudge(s: Summons, invite: Invite, n: number, final: boolean, inChat = false): MessagePayload {
  const title = final ? "🚨 FINAL NOTICE" : NUDGE_TITLES[Math.min(n, NUDGE_TITLES.length - 1)]!;
  const line = final
    ? "This is your final notice. Failure to respond will be escalated to the group chat."
    : NUDGE_LINES[Math.min(n, NUDGE_LINES.length - 1)]!;
  return {
    content: `**${title}** — ${mention(invite.recipient.id)}, our records indicate you have not responded to summons **${s.ref}**.`,
    embeds: [
      {
        title: clip(`${s.classification} — ${s.title}`, 256),
        description: `${line}\n\nCommences ${ts(s.startsAt, "R")}.`,
        color: final ? RED : PRIORITY_INFO[s.priority].color,
        footer: { text: `Ref. ${s.ref} · Notice ${n + 2}` },
      },
    ],
    components: inChat ? [] : jumpRow(s, invite, "Respond now"),
    allowed_mentions: { parse: [], users: [invite.recipient.id] },
  };
}

export function renderReminder(s: Summons, invite: Invite): MessagePayload {
  const lines = [`📍 ${s.location || "Location to be disclosed"}`];
  if (s.dressCode) lines.push(`👔 ${s.dressCode}`);
  lines.push("", "Report on time. The Bureau is watching.");
  return {
    content: `⏰ **T-minus ${s.remindBeforeMin} minutes** — **${clip(s.title, 200)}** commences ${ts(s.startsAt, "R")}.`,
    embeds: [
      {
        title: clip(`${s.classification} — ${s.title}`, 256),
        description: lines.join("\n"),
        color: PRIORITY_INFO[s.priority].color,
        footer: { text: `Ref. ${s.ref}` },
      },
    ],
    components: jumpRow(s, invite, "View summons"),
    allowed_mentions: { parse: [], users: [invite.recipient.id] },
  };
}

export function renderVerdictNotice(s: Summons, invite: Invite): MessagePayload {
  const granted = invite.verdict === "granted";
  return {
    content: `⚖️ **Extension ${granted ? "GRANTED" : "DENIED"}** — re: summons **${s.ref}**`,
    embeds: [
      {
        title: clip(`${s.classification} — ${s.title}`, 256),
        description: granted
          ? "The issuing officer has reviewed your request and granted an extension. Report at your earliest convenience."
          : `The issuing officer has reviewed your request. It has been **denied**. Report as originally scheduled: ${ts(s.startsAt, "F")}.`,
        color: granted ? GREEN : RED,
        footer: { text: `Ref. ${s.ref}` },
      },
    ],
    components: jumpRow(s, invite, "View summons"),
    allowed_mentions: { parse: [] },
  };
}

export function renderCancelNotice(s: Summons, invite: Invite): MessagePayload {
  return {
    content: `🗂️ **Summons withdrawn** — **${s.ref}** “${clip(s.title, 150)}” was cancelled by the issuing officer. You are released from duty.`,
    components: jumpRow(s, invite, "View summons"),
    allowed_mentions: { parse: [] },
  };
}

// --- notices posted in the chat where /summon was used -------------------------------------

export function renderInChatResponse(s: Summons, invite: Invite): MessagePayload {
  const info = STATUS_INFO[invite.status];
  const lines = [`📬 ${mention(s.organizer.id)} — **${clip(invite.recipient.name, 60)}** answered: ${statusEmoji(s, invite.status)} **${info.label}**`];
  if (invite.note) lines.push(quote(`“${clip(invite.note, 300)}”`));
  return { content: clip(lines.join("\n"), 2000), allowed_mentions: { parse: [], users: [s.organizer.id] } };
}

export function renderInChatVerdict(s: Summons, invite: Invite): MessagePayload {
  const granted = invite.verdict === "granted";
  return {
    content: granted
      ? `⚖️ ${mention(invite.recipient.id)} — your extension request was **GRANTED**. Report at your earliest convenience.`
      : `⚖️ ${mention(invite.recipient.id)} — your extension request was **DENIED**. Report as originally scheduled: ${ts(s.startsAt, "t")}.`,
    allowed_mentions: { parse: [], users: [invite.recipient.id] },
  };
}

export function renderInChatCancel(s: Summons, invite: Invite): MessagePayload {
  return {
    content: `🗂️ ${mention(invite.recipient.id)} — summons **${s.ref}** was withdrawn by the issuing officer. You are released from duty.`,
    allowed_mentions: { parse: [], users: [invite.recipient.id] },
  };
}

// --- the DM relay ---------------------------------------------------------------------------

export function renderForward(
  from: string,
  content: string,
  attachments: { url: string; filename: string }[],
  stickers: string[],
  ref: string | null,
): MessagePayload {
  const name = clip(from, 60);
  const text = content.trim();
  const lines: string[] = [];
  if (text && !text.includes("\n")) lines.push(`💬 **${name}:** ${text}`);
  else if (text) lines.push(`💬 **${name}:**`, quote(text));
  else lines.push(`💬 **${name}** sent:`);
  for (const s of stickers) lines.push(`*(sticker: ${clip(s, 60)})*`);
  for (const a of attachments) lines.push(a.url);
  const footer = `-# ↩️ Reply to this message to answer${ref ? ` · re: ${ref}` : ""}`;
  // Discord's 2000-character limit; leave room for emoji that count double in some measures.
  const body = clip(lines.join("\n"), 1990 - footer.length);
  return { content: `${body}\n${footer}`, allowed_mentions: { parse: [] } };
}

export function renderUnreachable(s: Summons, invite: Invite): MessagePayload {
  return {
    content:
      `📪 **The Bureau can't reach ${clip(invite.recipient.name, 60)} any more** (re: **${s.ref}**).\n` +
      "They may have blocked the bot, left the server, or turned off DMs. Further notices are stopped; you'll have to ask them yourself.",
    allowed_mentions: { parse: [] },
  };
}

export function renderRelayHelp(): MessagePayload {
  return {
    content:
      "🏛️ **The Bureau isn't sure who this is for.**\n" +
      "Reply to a summons or a forwarded message (long-press it → **Reply**) and the Bureau will pass your message on.",
    allowed_mentions: { parse: [] },
  };
}

export function renderRelayFailed(to: string): MessagePayload {
  return {
    content: `⚠️ The Bureau couldn't deliver that to **${clip(to, 60)}**: the bot can't DM them (they may have left the server or closed their DMs).`,
    allowed_mentions: { parse: [] },
  };
}

export function renderTestDm(bureau: string): MessagePayload {
  return {
    content:
      `🧪 **Test transmission from the ${bureau}.**\n` +
      "If you can read this, the Bureau can reach you by direct message. No response required. (This time.)",
    allowed_mentions: { parse: [] },
  };
}

export function escalationSummary(s: Pick<Summons, "escalation">): string {
  return ESCALATION_INFO[s.escalation].description;
}

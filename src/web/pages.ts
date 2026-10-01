import { bureauName, missingConfig, type Env } from "../env";
import {
  BUTTON_EMOJI,
  DEFAULT_OPTIONS,
  ESCALATION_INFO,
  MAX_RECIPIENTS,
  PRIORITY_INFO,
  REMIND_OPTIONS,
  formatDuration,
  optionFor,
  type Invite,
  type LogEntry,
  type Summons,
  type SummonsBundle,
  type SummonsDossier,
} from "../model";
import { renderSummons, renderSummonsText, statusEmoji } from "../messages";
import { ALL_TEMPLATES } from "../templates";
import type { Session } from "../session";
import type { SetupReport } from "../setup";
import { html, jsonScript, type SafeHtml } from "./html";
import { avatar, discordLogo, page, priorityBadge, stamp, statusChip, time } from "./layout";

interface Ctx {
  env: Env;
  origin: string;
  session: Session | null;
}

// --- landing -------------------------------------------------------------------------

function sampleSummons(origin: string): { message: unknown; names: Record<string, string> } {
  const now = Date.now();
  const s: Summons = {
    id: "sample",
    ref: "BMA-2026-0042",
    organizer: { id: "100000000000000001", name: "Mihai", avatar: null },
    guildId: "0",
    guildName: "",
    classification: "MANDATORY LOGISTICS OPERATION",
    title: "Procurement Run — LIDL",
    objective: "Procurement of Pepsi, chips and questionable bakery items.",
    location: "Lidl",
    startsAt: now + 90 * 60_000,
    durationMin: 45,
    priority: "elevated",
    dressCode: "Civilian attire",
    signatureTitle: "Chief Logistics Officer",
    respondBy: null,
    options: DEFAULT_OPTIONS,
    delivery: "dm",
    channelId: null,
    escalation: "standard",
    remindBeforeMin: 15,
    reminderSent: false,
    scheduledEventId: null,
    status: "active",
    origin,
    createdAt: now,
    endedAt: null,
  };
  const invite: Invite = {
    id: "i",
    summonsId: "sample",
    recipient: { id: "100000000000000002", name: "Andrei", avatar: null },
    deliveredVia: "dm",
    channelId: null,
    messageId: null,
    status: "pending",
    note: null,
    respondedAt: null,
    nudgesSent: 0,
    nextNudgeAt: null,
    verdict: null,
    error: null,
  };
  return {
    message: renderSummons(s, [invite], [invite], "Bureau of Mandatory Attendance", now),
    names: { "100000000000000001": "Mihai", "100000000000000002": "Andrei" },
  };
}

export function landingPage(c: Ctx): Response {
  const needsSetup = missingConfig(c.env).length > 0;
  const sample = sampleSummons(c.origin);
  const body = html`
  ${needsSetup ? html`<div class="banner">The Bureau isn't fully set up yet. <a href="/setup">Finish setup →</a></div>` : null}
  <section class="hero">
    <div class="hero__copy">
      <p class="eyebrow">Form BMA-27 · Official summons</p>
      <h1>Your presence has been <em>formally requested.</em></h1>
      <p class="lede">Turn “wanna play LoL?” into an official summons your friend can't just ignore.
        It lands in their Discord DMs with four buttons — accept, decline, file a weak excuse, or beg for an extension —
        and the Bureau keeps sending notices until they answer.</p>
      <div class="hero__cta">
        <a class="btn btn--discord btn--lg" href="/auth/login">${discordLogo()} Log in with Discord</a>
      </div>
      <p class="fineprint">Works with anyone in a Discord server that has the Bureau's bot.</p>
    </div>
    <div class="hero__preview">
      <div class="dc-frame" data-discord-preview="sample"></div>
      ${jsonScript("sample", sample)}
    </div>
  </section>
  <section class="steps">
    <div class="step"><span class="step__n">1</span><h3>Draft the summons</h3><p>Pick a template — gaming, a Lidl run, food — or write your own. Set the time, place and how urgent it is.</p></div>
    <div class="step"><span class="step__n">2</span><h3>The bot delivers it</h3><p>Your friend gets an official-looking DM with response buttons. No app to install.</p></div>
    <div class="step"><span class="step__n">3</span><h3>They must respond</h3><p>Silence triggers a second notice, then a third, then a final one. You get a DM the moment they answer.</p></div>
  </section>`;
  return page({ ...c, title: "Official summonses", active: "home", body, scripts: ["/static/preview-page.js"] });
}

// --- dashboard -----------------------------------------------------------------------

function tallyChips(b: SummonsBundle): SafeHtml {
  return html`<ul class="faces">${b.invites.map(
    (i) => html`<li class="face face--${i.status}" title="${i.recipient.name}: ${i.status}">
      ${avatar(i.recipient, "sm")}<span class="face__dot" aria-hidden="true">${statusEmoji(b.summons, i.status)}</span>
    </li>`,
  )}</ul>`;
}

function summonsCard(b: SummonsBundle, viewerId: string): SafeHtml {
  const { summons: s, invites } = b;
  const mine = invites.find((i) => i.recipient.id === viewerId);
  const fromOther = s.organizer.id !== viewerId;
  return html`<a class="card scard" href="/s/${s.id}">
    <div class="scard__top"><span class="ref">${s.ref}</span>${stamp(s.status, s.startsAt)}</div>
    <p class="eyebrow">${s.classification}</p>
    <h3 class="scard__title">${s.title}</h3>
    <p class="scard__when">🗓️ ${time(s.startsAt, "full")} · ${time(s.startsAt, "relative")}</p>
    <div class="scard__bottom">
      ${fromOther ? html`<span class="muted">From ${s.organizer.name}</span>` : tallyChips(b)}
      ${mine ? statusChip(mine.status, statusEmoji(s, mine.status)) : null}
    </div>
  </a>`;
}

export function dashboardPage(c: Ctx & { session: Session }, data: { issued: SummonsBundle[]; received: SummonsBundle[] }): Response {
  const awaiting = data.received.filter(
    (b) => b.summons.status === "active" && b.invites.some((i) => i.recipient.id === c.session.uid && i.status === "pending"),
  );
  const awaitingIds = new Set(awaiting.map((b) => b.summons.id));
  const history = data.received.filter((b) => !awaitingIds.has(b.summons.id) && b.summons.organizer.id !== c.session.uid);

  const body = html`
  <section class="page-head">
    <div>
      <p class="eyebrow">Officer's desk</p>
      <h1>Welcome back, ${c.session.name}.</h1>
    </div>
    <a class="btn btn--primary btn--lg" href="/new">📨 Issue a summons</a>
  </section>

  ${
    awaiting.length
      ? html`<section class="section">
          <h2 class="section__title">📭 Awaiting <em>your</em> response</h2>
          <div class="grid">${awaiting.map((b) => summonsCard(b, c.session.uid))}</div>
        </section>`
      : null
  }

  <section class="section">
    <h2 class="section__title">🗂️ Issued by you</h2>
    ${
      data.issued.length
        ? html`<div class="grid">${data.issued.map((b) => summonsCard(b, c.session.uid))}</div>`
        : html`<div class="empty card">
            <p class="empty__title">No summonses on file.</p>
            <p class="muted">Your friends are enjoying a suspicious amount of free time.</p>
            <a class="btn btn--primary" href="/new">Issue your first summons</a>
          </div>`
    }
  </section>

  ${
    history.length
      ? html`<section class="section">
          <h2 class="section__title">📨 Addressed to you</h2>
          <div class="grid">${history.map((b) => summonsCard(b, c.session.uid))}</div>
        </section>`
      : null
  }`;
  return page({ ...c, title: "Dossiers", active: "home", body });
}

// --- compose -----------------------------------------------------------------------

export interface Prefill {
  guildId: string;
  recipients: { id: string; name: string; avatar: string | null }[];
  classification: string;
  title: string;
  objective: string;
  location: string;
  durationMin: number;
  priority: string;
  dressCode: string;
  signatureTitle: string;
  options: Summons["options"];
  delivery: string;
  channelId: string | null;
  escalation: string;
  remindBeforeMin: number;
}

export function prefillFrom(s: Summons, invites: Invite[]): Prefill {
  return {
    guildId: s.guildId,
    recipients: invites.map((i) => i.recipient),
    classification: s.classification,
    title: s.title,
    objective: s.objective,
    location: s.location,
    durationMin: s.durationMin,
    priority: s.priority,
    dressCode: s.dressCode,
    signatureTitle: s.signatureTitle,
    options: s.options,
    delivery: s.delivery,
    channelId: s.channelId,
    escalation: s.escalation,
    remindBeforeMin: s.remindBeforeMin,
  };
}

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];

export function composePage(
  c: Ctx & { session: Session },
  guilds: { id: string; name: string }[],
  inviteUrl: string,
  prefill: Prefill | null,
): Response {
  if (!guilds.length) {
    const body = html`
    <section class="page-head"><div><p class="eyebrow">New summons</p><h1>No shared server yet</h1></div></section>
    <div class="card prose">
      <p>The Bureau can only reach people it shares a Discord server with, and it isn't in any server you're in.</p>
      <ol>
        <li>Add the bot to a server where your friends are (you need the <em>Manage Server</em> permission there, or create a new server and invite them).</li>
        <li>Come back here and refresh.</li>
      </ol>
      <p><a class="btn btn--discord" href="${inviteUrl}" target="_blank" rel="noopener">${discordLogo()} Add the bot to a server</a></p>
    </div>`;
    return page({ ...c, title: "New summons", active: "new", body });
  }

  const data = {
    me: { id: c.session.uid, name: c.session.name, avatar: c.session.avatar },
    guilds,
    templates: ALL_TEMPLATES,
    emoji: BUTTON_EMOJI,
    defaultOptions: DEFAULT_OPTIONS,
    escalations: ESCALATION_INFO,
    priorities: PRIORITY_INFO,
    maxRecipients: MAX_RECIPIENTS,
    prefill,
  };

  const field = (id: string, label: string, control: SafeHtml, hint?: string) =>
    html`<div class="field"><label for="${id}">${label}</label>${control}${hint ? html`<p class="hint">${hint}</p>` : null}</div>`;

  const body = html`
  ${jsonScript("compose-data", data)}
  <section class="page-head">
    <div>
      <p class="eyebrow">Form BMA-27</p>
      <h1>Issue a summons</h1>
    </div>
  </section>

  <div class="compose">
    <form id="compose" class="compose__form" novalidate>
      <section class="card panel">
        <h2 class="panel__title"><span class="panel__n">1</span> Quick start</h2>
        <div class="templates" id="templates" role="group" aria-label="Templates"></div>
        <button type="button" class="btn btn--ghost btn--sm" id="reroll">🎲 Re-roll the wording</button>
      </section>

      <section class="card panel">
        <h2 class="panel__title"><span class="panel__n">2</span> Who is being summoned?</h2>
        <div class="field" id="guild-field" ${guilds.length === 1 ? "hidden" : ""}>
          <label for="guildId">Server</label>
          <select id="guildId" name="guildId">${guilds.map((g) => html`<option value="${g.id}">${g.name}</option>`)}</select>
        </div>
        <div class="picker" id="picker">
          <div class="picker__selected" id="picked" aria-live="polite"></div>
          <input type="search" id="member-search" placeholder="Search people…" autocomplete="off" aria-label="Search people">
          <div class="picker__list" id="members" role="listbox" aria-multiselectable="true"><p class="muted">Loading members…</p></div>
          <p class="hint picker__tip">Tip: summon yourself first to see exactly what your friend will get.</p>
        </div>
        <p class="field-error" data-error-for="recipients" hidden></p>
      </section>

      <section class="card panel">
        <h2 class="panel__title"><span class="panel__n">3</span> The summons</h2>
        ${field("classification", "Classification", html`<input id="classification" name="classification" maxlength="80" list="classifications" required>
          <datalist id="classifications">${[...new Set(ALL_TEMPLATES.flatMap((t) => t.classification))].map((v) => html`<option value="${v}">`)}</datalist>`)}
        ${field("title", "Title", html`<input id="title" name="title" maxlength="100" required placeholder="Procurement Run — LIDL">`)}
        ${field("objective", "Objective", html`<textarea id="objective" name="objective" maxlength="1000" rows="3" placeholder="What is this about?"></textarea>`)}
        <div class="row2">
          ${field("startsAt", "When", html`<input id="startsAt" name="startsAt" type="datetime-local" required>`)}
          ${field("durationMin", "Estimated duration", html`<select id="durationMin" name="durationMin">${DURATIONS.map((d) => html`<option value="${d}">${formatDuration(d)}</option>`)}</select>`)}
        </div>
        ${field("location", "Location", html`<input id="location" name="location" maxlength="100" placeholder="Lidl">`)}
        <div class="field">
          <span class="label">Priority</span>
          <div class="segmented" role="radiogroup" aria-label="Priority">
            ${Object.entries(PRIORITY_INFO).map(
              ([key, p]) => html`<label class="seg seg--${key}"><input type="radio" name="priority" value="${key}"><span>${p.emoji} ${p.label}</span></label>`,
            )}
          </div>
        </div>
        <div class="row2">
          ${field("dressCode", "Dress code", html`<input id="dressCode" name="dressCode" maxlength="80" placeholder="Optional">`)}
          ${field("signatureTitle", "Your official title", html`<input id="signatureTitle" name="signatureTitle" maxlength="60" placeholder="Chief Logistics Officer">`)}
        </div>
        ${field("respondBy", "Respond by (optional)", html`<input id="respondBy" name="respondBy" type="datetime-local">`)}
      </section>

      <section class="card panel">
        <h2 class="panel__title"><span class="panel__n">4</span> Delivery &amp; follow-ups</h2>
        <div class="field">
          <span class="label">Deliver by</span>
          <div class="choices">
            <label class="choice"><input type="radio" name="delivery" value="dm" checked><span><strong>📬 Direct message</strong><small>Each person gets a private DM. Recommended.</small></span></label>
            <label class="choice"><input type="radio" name="delivery" value="channel"><span><strong>📢 Post in a channel</strong><small>One public post that pings everyone. Maximum peer pressure.</small></span></label>
          </div>
        </div>
        ${field("channelId", "If someone's DMs are closed, post in", html`<select id="channelId" name="channelId"><option value="">Don't post anywhere</option></select>`)}
        <div class="field">
          <span class="label">Escalation protocol (if they don't answer)</span>
          <div class="choices choices--compact">
            ${Object.entries(ESCALATION_INFO).map(
              ([key, e]) => html`<label class="choice"><input type="radio" name="escalation" value="${key}"><span><strong>${e.label}</strong><small>${e.description}</small></span></label>`,
            )}
          </div>
        </div>
        ${field(
          "remindBeforeMin",
          "Remind everyone who accepted",
          html`<select id="remindBeforeMin" name="remindBeforeMin">${REMIND_OPTIONS.map(
            (m) => html`<option value="${m}">${m === 0 ? "No reminder" : `${formatDuration(m)} before`}</option>`,
          )}</select>`,
        )}
        <label class="checkbox"><input type="checkbox" id="createScheduledEvent" name="createScheduledEvent"> <span>Also add it to the server's <strong>Events</strong> tab</span></label>
      </section>

      <details class="card panel">
        <summary class="panel__title"><span class="panel__n">5</span> Response buttons <span class="muted">(optional)</span></summary>
        <p class="hint">Rename the buttons or switch some off. The accept button always stays.</p>
        <div id="options" class="options"></div>
      </details>

    </form>

    <aside class="compose__preview">
      <p class="eyebrow">Live preview · what they'll see in Discord</p>
      <div class="dc-frame" id="preview"></div>
    </aside>

    <div class="dispatch">
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button type="submit" form="compose" class="btn btn--primary btn--lg btn--block" id="dispatch">📨 Dispatch summons</button>
      <p class="hint">The bot sends it to them in its own DM.</p>
      <div class="or"><span>or</span></div>
      <button type="button" class="btn btn--secondary btn--lg btn--block" id="post-summon">💬 Post it with /summon</button>
      <p class="hint">For one person. You then send <code>/summon</code> in your own DM with them, and the bot posts this summons right in your chat, with its buttons.</p>
      <div class="or"><span>or</span></div>
      <button type="button" class="btn btn--secondary btn--lg btn--block" id="copy-text">📋 Copy to send it yourself</button>
      <p class="hint">Copies it as text for you to paste and send. The bot sends nothing, so there are no buttons: they answer by reacting with an emoji.</p>
    </div>
  </div>`;
  return page({ ...c, title: "New summons", active: "new", body, scripts: ["/static/compose.js"] });
}

// --- dossier -------------------------------------------------------------------------

const LOG_ICONS: Record<string, string> = {
  issued: "🖋️",
  delivered: "📬",
  dm_closed: "📢",
  delivery_failed: "⚠️",
  event_created: "📅",
  event_failed: "⚠️",
  response: "📝",
  verdict: "⚖️",
  nudge: "📮",
  manual_nudge: "🔔",
  unreachable: "📪",
  reminder: "⏰",
  cancelled: "🗂️",
  closed: "📁",
  notify_failed: "⚠️",
  sync_failed: "⚠️",
};

function timeline(log: LogEntry[]): SafeHtml {
  return html`<ol class="timeline">${[...log].reverse().map(
    (e) => html`<li><span class="timeline__icon" aria-hidden="true">${LOG_ICONS[e.kind] ?? "•"}</span>
      <span class="timeline__text">${e.detail}</span>
      <span class="timeline__time">${time(e.at, "time")}</span></li>`,
  )}</ol>`;
}

function rosterRow(s: Summons, i: Invite): SafeHtml {
  const via = { dm: "📬 DM", channel: "📢 Channel", interaction: "💬 In your chat (/summon)", failed: "⚠️ Not delivered", pending: "…" }[i.deliveredVia];
  return html`<li class="roster__row">
    ${avatar(i.recipient)}
    <div class="roster__who">
      <strong>${i.recipient.name}</strong>
      <span class="muted small">${via}${i.nudgesSent ? ` · ${i.nudgesSent} follow-up ${i.nudgesSent === 1 ? "notice" : "notices"}` : ""}</span>
      ${i.error ? html`<span class="small error-text">${i.error}</span>` : null}
    </div>
    <div class="roster__status">
      ${statusChip(i.status, statusEmoji(s, i.status))}
      ${i.respondedAt ? html`<span class="muted small">${time(i.respondedAt, "relative")}</span>` : null}
    </div>
    ${i.note ? html`<blockquote class="roster__note">“${i.note}”${
      i.status === "extend" ? html`<footer>${i.verdict === "granted" ? "✅ Extension granted" : i.verdict === "denied" ? "❌ Extension denied" : "🕐 Awaiting your verdict (use the buttons in your Discord DM)"}</footer>` : null
    }</blockquote>` : null}
  </li>`;
}

export function dossierPage(c: Ctx & { session: Session }, d: SummonsDossier): Response {
  const { summons: s, invites } = d;
  const isOrganizer = s.organizer.id === c.session.uid;
  const mine = invites.find((i) => i.recipient.id === c.session.uid);
  const active = s.status === "active";
  const viewerInvite = mine ?? invites[0];
  const preview = viewerInvite
    ? renderSummons(s, invites, s.delivery === "channel" ? invites : [viewerInvite], bureauName(c.env))
    : null;
  const names = Object.fromEntries([[s.organizer.id, s.organizer.name], ...invites.map((i) => [i.recipient.id, i.recipient.name])]);

  const body = html`
  <article class="dossier">
    <header class="card dossier__head">
      <div class="dossier__top"><span class="ref">${s.ref}</span>${stamp(s.status, s.startsAt)}</div>
      <p class="eyebrow">${s.classification}</p>
      <h1>${s.title}</h1>
      ${s.objective ? html`<blockquote class="objective">${s.objective}</blockquote>` : null}
      <dl class="facts">
        <div class="facts__wide"><dt>🗓️ Commences</dt><dd>${time(s.startsAt, "full")} · <span class="muted">${time(s.startsAt, "relative")}</span></dd></div>
        <div><dt>⏱️ Duration</dt><dd>${formatDuration(s.durationMin)}</dd></div>
        <div><dt>📍 Location</dt><dd>${s.location || "To be disclosed"}</dd></div>
        <div><dt>🚨 Priority</dt><dd>${priorityBadge(s)}</dd></div>
        ${s.dressCode ? html`<div><dt>👔 Dress code</dt><dd>${s.dressCode}</dd></div>` : null}
        ${s.respondBy ? html`<div><dt>⌛ Respond by</dt><dd>${time(s.respondBy, "full")}</dd></div>` : null}
        <div><dt>🖋️ Issued by</dt><dd class="issuer">${avatar(s.organizer, "sm")} ${s.organizer.name}${s.signatureTitle ? html`<br><em class="muted">${s.signatureTitle}</em>` : null}</dd></div>
        <div><dt>📮 Escalation</dt><dd>${ESCALATION_INFO[s.escalation].label}</dd></div>
      </dl>
    </header>

    ${
      mine && active
        ? html`<section class="card panel respond" id="respond">
            <h2 class="panel__title">Your response</h2>
            <p class="muted">Currently: ${statusChip(mine.status, statusEmoji(s, mine.status))}</p>
            <div class="respond__buttons">
              ${s.options.map(
                (o) => html`<button type="button" class="btn btn--opt btn--opt-${o.kind}" data-respond="${o.kind}" data-needs-note="${o.kind === "excuse" || o.kind === "extend" ? "1" : ""}">${o.emoji} ${o.label}</button>`,
              )}
            </div>
            <div class="respond__note" hidden>
              <label for="note" id="note-label">Statement for the record</label>
              <textarea id="note" maxlength="300" rows="3"></textarea>
              <button type="button" class="btn btn--primary" id="note-submit">File response</button>
            </div>
          </section>`
        : null
    }

    <section class="card panel">
      <h2 class="panel__title">📋 Roster</h2>
      <ul class="roster">${invites.map((i) => rosterRow(s, i))}</ul>
    </section>

    ${
      isOrganizer
        ? html`<section class="actions">
            ${active ? html`<button type="button" class="btn btn--secondary" data-action="/api/summons/${s.id}/nudge">🔔 Send a reminder now</button>` : null}
            <a class="btn btn--secondary" href="/new?from=${s.id}">📄 Duplicate</a>
            <button type="button" class="btn btn--secondary" data-copy="${renderSummonsText(s, invites.map((i) => i.recipient.id), bureauName(c.env))}">📋 Copy as text</button>
            ${active ? html`<button type="button" class="btn btn--danger" data-action="/api/summons/${s.id}/cancel" data-confirm="Cancel this summons? Everyone will be released from duty.">🗂️ Cancel summons</button>` : null}
          </section>`
        : null
    }

    <section class="card panel">
      <h2 class="panel__title">🕰️ Case file</h2>
      ${timeline(d.log)}
    </section>

    ${
      preview
        ? html`<details class="card panel">
            <summary class="panel__title">💬 What it looks like in Discord</summary>
            <div class="dc-frame" data-discord-preview="dossier-preview"></div>
            ${jsonScript("dossier-preview", { message: preview, names })}
          </details>`
        : null
    }
  </article>
  ${jsonScript("dossier-data", { id: s.id, option: Object.fromEntries(s.options.map((o) => [o.kind, optionFor(s, o.kind).label])) })}`;
  return page({ ...c, title: `${s.ref} · ${s.title}`, body, scripts: ["/static/preview-page.js", "/static/dossier.js"] });
}

// --- setup ---------------------------------------------------------------------------

const STATE_ICON = { ok: "✅", todo: "⬜", error: "❌", skip: "➖", info: "ℹ️" } as const;

export function setupPage(c: Ctx, report: SetupReport): Response {
  const done = report.checks.filter((x) => x.state === "ok").length;
  const body = html`
  <section class="page-head">
    <div>
      <p class="eyebrow">Bureau setup</p>
      <h1>${report.ready ? "The Bureau is open for business." : "Let's get the Bureau running."}</h1>
      <p class="muted">${done} of ${report.checks.length} checks passing${report.botName ? ` · bot: ${report.botName}` : ""}</p>
    </div>
    ${report.ready && c.session ? html`<a class="btn btn--primary btn--lg" href="/new">📨 Issue a summons</a>` : null}
  </section>

  <ol class="checklist">
    ${report.checks.map(
      (x) => html`<li class="card check check--${x.state}">
        <span class="check__icon" aria-hidden="true">${STATE_ICON[x.state]}</span>
        <div class="check__body">
          <h3>${x.label}</h3>
          ${x.detail ? html`<p>${x.detail}</p>` : null}
          ${x.copy ? html`<div class="copy"><input readonly value="${x.copy}" aria-label="Value to copy"><button type="button" class="btn btn--sm btn--secondary" data-copy="${x.copy}">Copy</button></div>` : null}
          <div class="check__actions">
            ${x.action ? html`<button type="button" class="btn btn--sm btn--primary" data-setup="${x.action.id}">${x.action.label}</button>` : null}
            ${x.link ? html`<a class="btn btn--sm btn--secondary" href="${x.link.url}" ${x.link.url.startsWith("http") ? html`target="_blank" rel="noopener"` : null}>${x.link.label} ↗</a>` : null}
          </div>
        </div>
      </li>`,
    )}
  </ol>

  <details class="card panel prose" ${report.checks.length <= 1 ? "open" : ""}>
    <summary class="panel__title">📖 Full setup guide</summary>
    <ol>
      <li>Open the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a> → <strong>New Application</strong>. Name it something official, e.g. <em>${bureauName(c.env)}</em>.</li>
      <li>On <strong>General Information</strong>, copy the <strong>Application ID</strong> and <strong>Public Key</strong>.</li>
      <li>On <strong>Bot</strong>, click <strong>Reset Token</strong> and copy the token.</li>
      <li>On <strong>OAuth2</strong>, click <strong>Reset Secret</strong>, copy the <strong>Client Secret</strong>, then under <strong>Redirects</strong> add <code>${c.origin}/auth/callback</code> and save.</li>
      <li>In Cloudflare, open this Worker → <strong>Settings → Variables and Secrets</strong> and add four secrets:
        <code>DISCORD_APPLICATION_ID</code>, <code>DISCORD_PUBLIC_KEY</code>, <code>DISCORD_BOT_TOKEN</code>, <code>DISCORD_CLIENT_SECRET</code>.</li>
      <li>Reload this page and press the buttons above until everything is green.</li>
    </ol>
  </details>`;
  return page({ ...c, title: "Setup", active: "setup", body });
}

// --- errors --------------------------------------------------------------------------

export function messagePage(c: Ctx, title: string, message: string, status = 400, action?: { href: string; label: string }): Response {
  const body = html`
  <section class="card notice">
    <p class="eyebrow">Notice of irregularity</p>
    <h1>${title}</h1>
    <p>${message}</p>
    <p><a class="btn btn--primary" href="${action?.href ?? "/"}">${action?.label ?? "Back to the Bureau"}</a></p>
  </section>`;
  return page({ ...c, title, body, status });
}

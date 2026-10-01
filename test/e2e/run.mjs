// End-to-end test: runs the real Worker (wrangler dev / workerd) against the fake Discord API
// and walks through the whole flow — setup, login, issuing, clicking buttons, modals,
// extension verdicts, escalation notices, reminders, closing and cancelling.
//
//   npm run test:e2e
import assert from "node:assert/strict";
import { IDS, validateMessage, validateModal } from "./fake-discord.mjs";
import { startStack } from "./harness.mjs";

const stack = await startStack();
const { fake } = stack;
const WORKER = stack.worker;
const shutdown = stack.stop;

// --- helpers ---------------------------------------------------------------------------

const cookies = new Map();
function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function storeCookies(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const [name, value] = pair.split("=");
    if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) cookies.delete(name.trim());
    else cookies.set(name.trim(), value);
  }
}
async function web(path, init = {}) {
  const res = await fetch(`${WORKER}${path}`, {
    redirect: "manual",
    ...init,
    headers: { cookie: cookieHeader(), ...(init.headers ?? {}) },
  });
  storeCookies(res);
  return res;
}
async function api(path, body) {
  const res = await web(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WORKER },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() };
}
/** Follows the login redirects (worker ↔ fake Discord) like a browser; returns the first non-auth response. */
async function followLogin(start) {
  let res = await web(start);
  for (let hops = 0; hops < 8; hops++) {
    const location = res.headers.get("location");
    if (res.status !== 302 || !location) return res;
    const u = new URL(location, WORKER);
    if (u.origin !== WORKER) res = await fetch(u, { redirect: "manual" });
    else if (u.pathname.startsWith("/auth/")) res = await web(u.pathname + u.search);
    else return res;
  }
  throw new Error("login redirect loop");
}
async function loginAs(userId) {
  cookies.clear();
  fake.state.browserUser = userId;
  const done = await followLogin("/auth/login?next=/new");
  assert.equal(done.status, 302, `login failed: ${await done.text()}`);
  assert.equal(done.headers.get("location"), "/new");
  assert.ok(cookies.has("bma_session"), "session cookie set");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const control = (path, body) =>
  fetch(`http://127.0.0.1:${fake.state.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const typeDm = (from, content, extra = {}) => control("/__dm", { from, content, ...extra });

let interactionSeq = 0;
async function interact(payload, { badSignature = false } = {}) {
  const token = `itok-${++interactionSeq}`;
  const body = JSON.stringify({ id: String(interactionSeq), application_id: IDS.app, token, version: 1, ...payload });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${WORKER}/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": badSignature ? "ab".repeat(64) : stack.sign(ts, body),
      "x-signature-timestamp": ts,
    },
    body,
  });
  const text = await res.text();
  const json = text.startsWith("{") ? JSON.parse(text) : text;
  // Do with the response what Discord would, so the app's later follow-ups and edits have something to act on.
  if (res.status === 200 && typeof json === "object") {
    const channelId = payload.channel_id;
    const ephemeral = ((json.data?.flags ?? 0) & 64) !== 0;
    if (json.type === 4 && !ephemeral) await control("/__interaction", { token, channelId, create: json.data });
    else if (json.type === 7) await control("/__interaction", { token, channelId, messageId: payload.message?.id, update: json.data });
    else if (json.type === 5) await control("/__interaction", { token, channelId, deferred: true });
    else await control("/__interaction", { token, channelId });
  }
  return { status: res.status, json, token };
}
const user = (id) => ({ id, username: `u${id.slice(-2)}`, global_name: null });
function click(userId, message, customId) {
  const inGuild = message.channel_id === IDS.general;
  return interact({
    type: 3,
    data: { custom_id: customId, component_type: 2 },
    ...(inGuild ? { guild_id: IDS.guild, member: { user: user(userId) } } : { user: user(userId) }),
    channel_id: message.channel_id,
    message: { id: message.id, channel_id: message.channel_id },
  });
}
function submitModal(userId, message, customId, value) {
  return interact({
    type: 5,
    data: {
      custom_id: customId,
      components: [
        { type: 10, id: 1 },
        { type: 18, id: 2, component: { type: 4, id: 3, custom_id: "note", value } },
      ],
    },
    user: user(userId),
    channel_id: message.channel_id,
    message: { id: message.id, channel_id: message.channel_id },
  });
}
// Message re-syncs are debounced by a second, so "now" in tests is always a little ahead.
const tick = (advanceMs = 2_000) => api(`/dev/tick?advanceMs=${advanceMs}`);
const messages = () => [...fake.state.messages.values()];
/** What the bot sent someone in its DM with them (not what they typed, not hidden replies). */
const dmsTo = (uid) => messages().filter((m) => m.dm_user === uid && m.author?.id === IDS.bot && !((m.flags ?? 0) & 64));
const inChat = (re) => messages().filter((m) => m.channel_id === IDS.personalDm && re.test(m.content ?? ""));
const text = (m) => JSON.stringify(m);
function assertValidMessage(payload, label) {
  assert.deepEqual(validateMessage(payload), [], `${label} violates Discord limits`);
}

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    console.error("\n--- worker log ---\n" + stack.log().slice(-4000));
    process.exit(1);
  }
}

// --- scenario --------------------------------------------------------------------------

console.log("Worker is up. Running end-to-end scenario:");

await step("landing page renders for visitors", async () => {
  const res = await web("/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /formally requested/);
  assert.match(html, /Log in with Discord/);
});

await step("interactions endpoint rejects bad signatures", async () => {
  const r = await interact({ type: 1 }, { badSignature: true });
  assert.equal(r.status, 401);
});

await step("setup page reports what's left to configure", async () => {
  const html = await (await web("/setup")).text();
  assert.match(html, /Bot token works/);
  assert.match(html, /Set it for me/); // interactions URL not set yet
  assert.match(html, /Enable it for me/); // members intent off
  assert.match(html, new RegExp(`${WORKER}/auth/callback`)); // redirect to copy
});

await step("setup: one-click interactions URL (Discord pings and verifies it)", async () => {
  const r = await api("/setup/interactions");
  assert.equal(r.json.ok, true, r.json.message);
  assert.equal(fake.state.app.interactions_endpoint_url, `${WORKER}/interactions`);
});

await step("setup: enable members intent and register /bureau", async () => {
  assert.equal((await api("/setup/intent")).json.ok, true);
  assert.ok(fake.state.app.flags & (1 << 15));
  assert.equal((await api("/setup/commands")).json.ok, true);
  assert.equal(fake.state.commands[0].name, "bureau");
});

await step("login fails clearly while the redirect URI isn't registered", async () => {
  fake.state.browserUser = IDS.organizer;
  const res = await followLogin("/auth/login");
  assert.equal(res.status, 502);
  assert.match(await res.text(), /under Redirects/);
});

await step("first-time login falls back to Discord's approval screen", async () => {
  fake.state.authorized.clear();
  fake.state.browserUser = IDS.organizer;
  const start = await web("/auth/login?next=/setup");
  const quiet = await fetch(start.headers.get("location"), { redirect: "manual" });
  assert.match(quiet.headers.get("location"), /error=consent_required/);
  const back = new URL(quiet.headers.get("location"));
  const retry = await web(back.pathname + back.search);
  assert.equal(retry.headers.get("location"), "/auth/login?consent=1&next=%2Fsetup");
  const consent = await web("/auth/login?consent=1&next=%2Fsetup");
  assert.doesNotMatch(consent.headers.get("location"), /prompt=none/);
});

await step("Log in with Discord (OAuth2 code flow)", async () => {
  fake.state.app.redirect_uris = [`${WORKER}/auth/callback`];
  await loginAs(IDS.organizer);
  const html = await (await web("/setup")).text();
  assert.doesNotMatch(html, /Set it for me/);
  assert.match(html, /open for business/);
});

await step("setup: test DM reaches the logged-in user", async () => {
  const r = await api("/setup/test-dm");
  assert.equal(r.json.ok, true, r.json.message);
  assert.match(text(dmsTo(IDS.organizer).at(-1)), /Test transmission/);
});

await step("compose page lists the shared server", async () => {
  const html = await (await web("/new")).text();
  assert.match(html, /Friends HQ/);
  assert.match(html, /compose-data/);
});

await step("directory lists humans (no bots) and text channels", async () => {
  const res = await web(`/api/guilds/${IDS.guild}/directory`);
  const dir = await res.json();
  assert.equal(dir.mode, "list");
  assert.deepEqual(dir.members.map((m) => m.name).sort(), ["Andrei", "Bogdan", "Mihai"]);
  assert.deepEqual(dir.channels.map((c) => c.name), ["general"]);
});

await step("live preview renders a valid Discord message, plus a copyable text version", async () => {
  const r = await api("/api/preview", { title: "Preview", recipients: [IDS.alice] });
  assert.equal(r.status, 200);
  assertValidMessage(r.json.message, "preview");
  assert.match(text(r.json.message), /OFFICIAL SUMMONS/);
  assert.match(r.json.text, /^# 📨 OFFICIAL SUMMONS/);
  assert.match(r.json.text, new RegExp(`<@${IDS.alice}>`));
  assert.match(r.json.text, /React to respond/);
});

const baseDraft = {
  guildId: IDS.guild,
  classification: "Mandatory logistics operation",
  title: "Procurement Run — LIDL",
  objective: "Procurement of Pepsi, chips and questionable bakery items.",
  location: "Lidl",
  durationMin: 45,
  priority: "high",
  dressCode: "Civilian attire",
  signatureTitle: "Chief Logistics Officer",
  options: [
    { kind: "yes", label: "Accept Mission", emoji: "🫡" },
    { kind: "no", label: "Decline Assignment", emoji: "❌" },
    { kind: "excuse", label: "Provide Weak Excuse", emoji: "🤡" },
    { kind: "extend", label: "Request Extension", emoji: "⏳" },
  ],
  delivery: "dm",
  channelId: IDS.general,
  escalation: "standard",
  remindBeforeMin: 15,
  createScheduledEvent: true,
};

await step("validation rejects bad drafts with a field name", async () => {
  let r = await api("/api/summons", { ...baseDraft, recipients: [], startsAt: Date.now() + 3_600_000 });
  assert.equal(r.status, 400);
  assert.equal(r.json.field, "recipients");
  r = await api("/api/summons", { ...baseDraft, recipients: [IDS.alice], startsAt: Date.now() - 3_600_000 });
  assert.equal(r.json.field, "startsAt");
  r = await api("/api/summons", { ...baseDraft, recipients: [IDS.stranger], startsAt: Date.now() + 3_600_000 });
  assert.equal(r.json.field, "recipients");
  r = await api("/api/summons", { ...baseDraft, recipients: [IDS.bot], startsAt: Date.now() + 3_600_000 });
  assert.match(r.json.error, /bot/i);
});

let summonsId;
const startsAt = Date.now() + 3 * 3_600_000;

await step("issue a summons: DM to Andrei, channel fallback for Bogdan (DMs closed), server event", async () => {
  const r = await api("/api/summons", { ...baseDraft, recipients: [IDS.alice, IDS.bob], startsAt });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  summonsId = r.json.id;
  assert.match(r.json.ref, /^BMA-\d{4}-0001$/);
  const via = Object.fromEntries(r.json.deliveries.map((d) => [d.recipient.name, d.deliveredVia]));
  assert.deepEqual(via, { Andrei: "dm", Bogdan: "channel" });
  assert.deepEqual(r.json.warnings, []);
  assert.equal(fake.state.events.length, 1);
});

await step("the DM looks official and carries the four response buttons", async () => {
  const dm = dmsTo(IDS.alice).at(-1);
  assertValidMessage(dm, "summons DM");
  assert.match(dm.content, /OFFICIAL SUMMONS/);
  assert.equal(dm.embeds[0].title, "🟠 MANDATORY LOGISTICS OPERATION");
  const buttons = dm.components[0].components;
  assert.deepEqual(buttons.map((b) => b.custom_id), ["yes", "no", "excuse", "extend"].map((k) => `r:${summonsId}:${k}`));
  assert.deepEqual(dm.allowed_mentions, { parse: [], users: [IDS.alice] });
  const channelPost = messages().find((m) => m.channel_id === IDS.general);
  assert.match(channelPost.content, new RegExp(`<@${IDS.bob}>`));
});

await step("a stranger clicking a button is turned away", async () => {
  const post = messages().find((m) => m.channel_id === IDS.general);
  const r = await click(IDS.organizer, post, `r:${summonsId}:yes`);
  assert.equal(r.json.type, 4);
  assert.equal(r.json.data.flags, 64);
  assert.match(r.json.data.content, /not addressed to you/);
});

await step("Andrei accepts: his message updates in place", async () => {
  const dm = dmsTo(IDS.alice).at(-1);
  const r = await click(IDS.alice, dm, `r:${summonsId}:yes`);
  assert.equal(r.json.type, 7);
  assertValidMessage(r.json.data, "updated summons");
  assert.match(text(r.json.data), /ACCEPTED/);
});

await step("the organizer gets a DM, and Bogdan's copy shows the new roster", async () => {
  await tick();
  const notice = dmsTo(IDS.organizer).at(-1);
  assertValidMessage(notice, "response notice");
  assert.match(notice.content, /Response received/);
  const post = messages().find((m) => m.channel_id === IDS.general);
  assert.ok(post.edits >= 1, "channel copy was re-rendered");
  assert.match(text(post), /accepted/);
});

await step("Bogdan asks for an extension through the modal", async () => {
  const post = messages().find((m) => m.channel_id === IDS.general);
  const open = await click(IDS.bob, post, `r:${summonsId}:extend`);
  assert.equal(open.json.type, 9);
  assert.deepEqual(validateModal(open.json.data), []);
  const r = await submitModal(IDS.bob, { ...post, dm_user: null }, `m:${summonsId}:extend`, "30 more minutes, still in the shower");
  assert.equal(r.json.type, 7);
  assert.match(text(r.json.data), /EXTENSION REQUESTED/);
  assert.match(text(r.json.data), /still in the shower/);
});

await step("the organizer grants the extension from their DM", async () => {
  await tick();
  const notice = dmsTo(IDS.organizer).at(-1);
  const grant = notice.components[0].components.find((b) => b.custom_id?.endsWith(":granted"));
  assert.ok(grant, "grant button present");
  const denied = await interact({
    type: 3,
    data: { custom_id: grant.custom_id, component_type: 2 },
    user: user(IDS.alice),
    channel_id: notice.channel_id,
    message: { id: notice.id, channel_id: notice.channel_id },
  });
  assert.match(denied.json.data.content, /Only the issuing officer/);
  const r = await interact({
    type: 3,
    data: { custom_id: grant.custom_id, component_type: 2 },
    user: user(IDS.organizer),
    channel_id: notice.channel_id,
    message: { id: notice.id, channel_id: notice.channel_id },
  });
  assert.equal(r.json.type, 7);
  assert.match(text(r.json.data), /GRANTED/);
  await tick();
  const toBob = messages().filter((m) => m.channel_id === IDS.general).at(-1); // DMs closed → channel fallback
  assert.match(toBob.content, /Extension GRANTED/);
});

await step("Andrei changes his mind and files a weak excuse (modal pre-filled next time)", async () => {
  const dm = dmsTo(IDS.alice).find((m) => m.embeds?.[0]?.title?.includes("LOGISTICS"));
  const r = await submitModal(IDS.alice, dm, `m:${summonsId}:excuse`, "my cat scheduled a meeting with me");
  assert.equal(r.json.type, 7);
  assert.match(text(r.json.data), /EXCUSE FILED/);
  const reopen = await click(IDS.alice, dm, `r:${summonsId}:excuse`);
  assert.equal(reopen.json.data.components[1].component.value, "my cat scheduled a meeting with me");
});

await step("the dossier page shows the roster and case file", async () => {
  const html = await (await web(`/s/${summonsId}`)).text();
  assert.match(html, /data-copy="# 📨 OFFICIAL SUMMONS/);
  assert.match(html, /my cat scheduled a meeting with me/);
  assert.match(html, /Extension granted/);
  assert.match(html, /Case file/);
});

await step("/bureau shows unanswered summonses", async () => {
  const r = await interact({ type: 2, data: { name: "bureau" }, user: user(IDS.alice) });
  assert.equal(r.json.data.flags, 64);
  assert.match(r.json.data.content, /record is clean/); // Andrei already responded
});

let second;
await step("escalation: silence earns a second notice, then a final one", async () => {
  const r = await api("/api/summons", {
    ...baseDraft,
    title: "League of Legends Competitive Deployment",
    recipients: [IDS.alice],
    startsAt: Date.now() + 5 * 3_600_000,
    escalation: "standard",
    createScheduledEvent: false,
  });
  second = r.json.id;
  const before = dmsTo(IDS.alice).length;
  await tick(46 * 60_000);
  const notice = dmsTo(IDS.alice).at(-1);
  assert.equal(dmsTo(IDS.alice).length, before + 1);
  assert.match(notice.content, /SECOND NOTICE/);
  assertValidMessage(notice, "nudge");
  assert.equal(notice.components[0].components[0].style, 5); // jump link
  await tick(92 * 60_000);
  await tick(138 * 60_000);
  assert.match(dmsTo(IDS.alice).at(-1).content, /FINAL NOTICE/);
  await tick(184 * 60_000);
  assert.equal(dmsTo(IDS.alice).length, before + 3, "no more than 3 follow-ups on Standard");
});

await step("manual reminder from the dossier, with a cooldown", async () => {
  const r1 = await api(`/api/summons/${second}/nudge`);
  assert.equal(r1.json.ok, true);
  const r2 = await api(`/api/summons/${second}/nudge`);
  assert.equal(r2.status, 400);
  assert.match(r2.json.error, /minute/);
});

await step("pre-event reminder goes to accepted people and a briefing to the organizer", async () => {
  const third = await api("/api/summons", {
    ...baseDraft,
    title: "Gym",
    recipients: [IDS.alice],
    startsAt: Date.now() + 2 * 3_600_000,
    escalation: "off",
    remindBeforeMin: 15,
    createScheduledEvent: false,
  });
  const dm = dmsTo(IDS.alice).at(-1);
  await click(IDS.alice, dm, `r:${third.json.id}:yes`);
  await tick(106 * 60_000);
  assert.match(dmsTo(IDS.alice).at(-1).content, /T-minus 15 minutes/);
  assert.match(dmsTo(IDS.organizer).at(-1).content, /Pre-operation briefing/);
});

await step("files close when the event ends: buttons disabled", async () => {
  await tick(6 * 3_600_000);
  const dm = dmsTo(IDS.alice).find((m) => m.embeds?.[0]?.description?.includes("League of Legends"));
  assert.ok(dm.components[0].components.every((b) => b.disabled), "buttons disabled");
  assert.match(dm.content, /FILE CLOSED/);
  // A late click refreshes the message to its final state rather than leaving stale buttons.
  const r = await click(IDS.alice, dm, `r:${second}:yes`);
  assert.equal(r.json.type, 7);
  assert.match(r.json.data.content, /FILE CLOSED/);
  assert.ok(r.json.data.components[0].components.every((b) => b.disabled));
});

await step("cancelling withdraws the summons, notifies people, deletes the server event", async () => {
  const r = await api("/api/summons", { ...baseDraft, recipients: [IDS.alice], startsAt: Date.now() + 24 * 3_600_000 });
  const id = r.json.id;
  const c = await api(`/api/summons/${id}/cancel`);
  assert.equal(c.json.ok, true);
  await tick();
  assert.match(dmsTo(IDS.alice).at(-1).content, /Summons withdrawn/);
  const original = dmsTo(IDS.alice).find((m) => m.components?.[0]?.components?.[0]?.custom_id === `r:${id}:yes`);
  assert.match(original.content, /WITHDRAWN/);
  assert.equal(fake.state.deletedEvents.length, 1);
});

await step("channel delivery: one shared post, any recipient can answer", async () => {
  const r = await api("/api/summons", {
    ...baseDraft,
    title: "Movie night",
    recipients: [IDS.alice, IDS.bob],
    startsAt: Date.now() + 4 * 3_600_000,
    delivery: "channel",
    createScheduledEvent: false,
  });
  const post = messages().filter((m) => m.channel_id === IDS.general).at(-1);
  assert.match(post.content, new RegExp(`<@${IDS.alice}> <@${IDS.bob}>`));
  const answer = await click(IDS.bob, { ...post, dm_user: null }, `r:${r.json.id}:no`);
  assert.equal(answer.json.type, 7);
  assert.match(text(answer.json.data), /declined/);
});

await step("recipients can answer on the website too", async () => {
  const issued = await api("/api/summons", {
    ...baseDraft,
    title: "Caffeine Supply Chain Review",
    recipients: [IDS.alice],
    startsAt: Date.now() + 3 * 3_600_000,
    createScheduledEvent: false,
  });
  const webId = issued.json.id;
  await loginAs(IDS.alice);
  const r = await api("/api/summons", { ...baseDraft, recipients: [IDS.organizer], startsAt: Date.now() + 3_600_000, createScheduledEvent: false });
  assert.equal(r.status, 200, "anyone in the server can issue");
  const dossier = await (await web(`/s/${webId}`)).text();
  assert.match(dossier, /Your response/);
  const res = await api(`/api/summons/${webId}/respond`, { kind: "yes" });
  assert.equal(res.json.ok, true, res.json.error);
  const blank = await api(`/api/summons/${webId}/respond`, { kind: "excuse", note: "  " });
  assert.equal(blank.status, 400);
  await tick();
  const dm = dmsTo(IDS.alice).find((m) => m.components?.[0]?.components?.[0]?.custom_id === `r:${webId}:yes`);
  assert.match(text(dm), /ACCEPTED/, "Discord copy re-rendered after a web response");
});

await step("people can't open dossiers that aren't theirs", async () => {
  await loginAs(IDS.bob);
  const res = await web(`/s/${second}`);
  assert.equal(res.status, 404);
});

await step("dashboard lists summonses issued and received", async () => {
  await loginAs(IDS.organizer);
  const html = await (await web("/")).text();
  assert.match(html, /Issued by you/);
  assert.match(html, /BMA-\d{4}-0001/);
  assert.match(html, /Awaiting <em>your<\/em> response/);
});

// --- DM forwarding through the Gateway ---------------------------------------------------

await step("the bot keeps a live Gateway connection that only listens to DMs", async () => {
  await web("/setup");
  await waitFor("gateway session", () => [...fake.state.gateway.sockets].some((c) => c.ready));
  assert.equal(fake.state.gateway.intents, 1 << 12);
  assert.match(await (await web("/setup")).text(), /DM forwarding is live/);
});

let relaySummons;
await step("Andrei types in the bot's DM: it's forwarded to whoever summoned him", async () => {
  await loginAs(IDS.organizer);
  const r = await api("/api/summons", {
    ...baseDraft,
    title: "Relay test",
    recipients: [IDS.alice],
    startsAt: Date.now() + 3_600_000,
    createScheduledEvent: false,
  });
  relaySummons = r.json.id;
  const summonsDm = dmsTo(IDS.alice).find((m) => m.components?.[0]?.components?.[0]?.custom_id === `r:${relaySummons}:yes`);
  assert.match(summonsDm.content, /Reply to this message and the Bureau will pass it on to Mihai/);
  const typed = await typeDm(IDS.alice, "on my way, 10 min");
  const forwarded = await waitFor("forward to the organizer", () => dmsTo(IDS.organizer).find((m) => m.content?.includes("on my way, 10 min")));
  assert.match(forwarded.content, /💬 \*\*Andrei:\*\* on my way, 10 min/);
  assert.match(forwarded.content, /Reply to this message to answer/);
  await waitFor("📨 reaction", () => fake.state.messages.get(typed.id).reactions.includes("📨"));
});

await step("replying to a forwarded message sends the answer back", async () => {
  const forwarded = dmsTo(IDS.organizer).find((m) => m.content?.includes("on my way, 10 min"));
  await typeDm(IDS.organizer, "you have 5 minutes", { replyTo: forwarded.id });
  const back = await waitFor("forward to Andrei", () => dmsTo(IDS.alice).find((m) => m.content?.includes("you have 5 minutes")));
  assert.match(back.content, /💬 \*\*Mihai:\*\*/);
});

await step("replying to the summons itself reaches its issuer", async () => {
  const summonsDm = dmsTo(IDS.alice).find((m) => m.components?.[0]?.components?.[0]?.custom_id === `r:${relaySummons}:yes`);
  await typeDm(IDS.alice, "is the Pepsi included?", { replyTo: summonsDm.id });
  const forwarded = await waitFor("forward", () => dmsTo(IDS.organizer).find((m) => m.content?.includes("is the Pepsi included?")));
  assert.match(forwarded.content, /re: BMA-/);
});

await step("a redelivered event is never forwarded twice; the bot's own messages are ignored", async () => {
  const typed = await typeDm(IDS.alice, "only once please");
  await waitFor("forward", () => dmsTo(IDS.organizer).find((m) => m.content?.includes("only once please")));
  await control("/__gateway", {
    dispatch: {
      t: "MESSAGE_CREATE",
      d: { id: typed.id, channel_id: typed.channel_id, type: 0, author: { id: IDS.alice, username: "andrei", global_name: "Andrei" }, content: "only once please" },
    },
  });
  await sleep(800);
  assert.equal(dmsTo(IDS.organizer).filter((m) => m.content?.includes("only once please")).length, 1);
  assert.equal(dmsTo(IDS.organizer).filter((m) => m.content?.startsWith("💬 **Bureau")).length, 0);
});

await step("strangers with no summons get a short explanation instead", async () => {
  await typeDm(IDS.stranger, "hello?");
  await waitFor("help", () => dmsTo(IDS.stranger).find((m) => m.content?.includes("isn't sure who this is for")));
});

await step("after a dropped connection the bot resumes and keeps forwarding", async () => {
  const resumes = fake.state.gateway.resumes;
  await control("/__gateway", { close: 4000 });
  await waitFor("resume", () => fake.state.gateway.resumes > resumes && [...fake.state.gateway.sockets].some((c) => c.ready));
  await typeDm(IDS.alice, "still there?");
  await waitFor("forward after resume", () => dmsTo(IDS.organizer).find((m) => m.content?.includes("still there?")));
});

await step("messages typed while disconnected are caught up after a new session", async () => {
  const identifies = fake.state.gateway.identifies;
  await control("/__gateway", { close: 4009 }); // session timed out: has to start over, missing events
  await typeDm(IDS.alice, "sent while you were away", { quiet: true });
  await waitFor("new session", () => fake.state.gateway.identifies > identifies);
  await waitFor("caught-up forward", () => dmsTo(IDS.organizer).find((m) => m.content?.includes("sent while you were away")));
});

await step("summoning yourself never echoes your own messages back to you", async () => {
  const self = await api("/api/summons", {
    ...baseDraft,
    title: "Self test",
    recipients: [IDS.organizer],
    startsAt: Date.now() + 3_600_000,
    createScheduledEvent: false,
  });
  assert.equal(self.status, 200);
  const selfDm = dmsTo(IDS.organizer).find((m) => m.components?.[0]?.components?.[0]?.custom_id === `r:${self.json.id}:yes`);
  await typeDm(IDS.organizer, "testing the relay", { replyTo: selfDm.id });
  // Goes to the last person who sent Mihai something (Andrei), never back to Mihai.
  await waitFor("forward to Andrei", () => dmsTo(IDS.alice).find((m) => m.content?.includes("testing the relay")));
  await sleep(500);
  assert.equal(dmsTo(IDS.organizer).filter((m) => m.content?.includes("testing the relay")).length, 0);
});

await step("people are told who their messages go to whenever that changes", async () => {
  const notices = dmsTo(IDS.alice).filter((m) => m.content?.startsWith("↪️"));
  assert.ok(notices.length >= 1);
  assert.match(notices[0].content, /passing your messages to \*\*Mihai\*\*/);
  const before = notices.length;
  await typeDm(IDS.alice, "same person again");
  await waitFor("forward", () => dmsTo(IDS.organizer).find((m) => m.content?.includes("same person again")));
  assert.equal(dmsTo(IDS.alice).filter((m) => m.content?.startsWith("↪️")).length, before, "no repeat notice");
});

await step("forwarding can be switched off and back on from the setup page", async () => {
  assert.equal((await api("/setup/relay-off")).json.ok, true);
  await waitFor("disconnect", () => fake.state.gateway.sockets.size === 0);
  assert.match(await (await web("/setup")).text(), /DM forwarding is off/);
  await typeDm(IDS.alice, "nobody is listening", { quiet: true });
  assert.equal((await api("/setup/relay-on")).json.ok, true);
  await waitFor("reconnect", () => [...fake.state.gateway.sockets].some((c) => c.ready));
  await sleep(800);
  assert.equal(dmsTo(IDS.organizer).filter((m) => m.content?.includes("nobody is listening")).length, 0, "not replayed later");
  await typeDm(IDS.alice, "back online");
  await waitFor("forward", () => dmsTo(IDS.organizer).find((m) => m.content?.includes("back online")));
});

// --- /summon in a personal DM -------------------------------------------------------------

await step("setup: one tap allows /summon in personal DMs and re-registers the commands", async () => {
  assert.match(await (await web("/setup")).text(), /\/summon allowed in personal DMs/);
  const r = await api("/setup/user-install");
  assert.equal(r.json.ok, true, r.json.message);
  assert.ok("1" in fake.state.app.integration_types_config);
  const summon = fake.state.commands.find((c) => c.name === "summon");
  assert.deepEqual(summon.integration_types, [0, 1]);
  assert.deepEqual(summon.contexts, [0, 1, 2]);
  assert.match(await (await web("/setup")).text(), /Add to my account/);
});

const andrei = { id: IDS.alice, username: "andrei", global_name: "Andrei", avatar: null };
const bogdan = { id: IDS.bob, username: "bogdan", global_name: "Bogdan", avatar: null };
const slash = (from, options, extra = {}) =>
  interact({
    type: 2,
    context: 2,
    channel_id: IDS.personalDm,
    user: user(from),
    data: {
      name: "summon",
      type: 1,
      options: Object.entries(options).map(([name, value]) => ({ name, value, type: name === "who" ? 6 : 3 })),
      resolved: { users: { [IDS.alice]: andrei, [IDS.bob]: bogdan } },
    },
    ...extra,
  });

let chatSummons;
let chatMessage;
await step("/summon in your DM with a friend posts the summons right there", async () => {
  const r = await slash(IDS.organizer, { who: IDS.alice, what: "gaming" });
  assert.equal(r.json.type, 4);
  assertValidMessage(r.json.data, "/summon response");
  assert.match(r.json.data.content, new RegExp(`<@${IDS.alice}>`));
  const rows = r.json.data.components;
  assert.equal(rows.length, 2);
  assert.ok(rows[1].components[0].custom_id.startsWith("n:"), "🔔 row");
  chatSummons = rows[0].components[0].custom_id.split(":")[1];
  chatMessage = messages().find((m) => m.channel_id === IDS.personalDm && m.components?.[0]?.components?.[0]?.custom_id === `r:${chatSummons}:yes`);
  assert.ok(chatMessage, "posted in the personal DM");
});

await step("silence: automatic notices land in the same chat during the first 15 minutes", async () => {
  await tick(4 * 60_000 + 2_000);
  assert.equal(inChat(/NOTICE/).length, 1);
  assert.match(inChat(/NOTICE/)[0].content, /SECOND NOTICE/);
  assert.match(inChat(/NOTICE/)[0].content, new RegExp(`<@${IDS.alice}>`));
  await tick(8 * 60_000 + 4_000);
  await tick(12 * 60_000 + 6_000);
  assert.equal(inChat(/NOTICE/).length, 3, "three notices per 15-minute window");
  await tick(13 * 60_000);
  assert.equal(inChat(/NOTICE/).length, 3);
});

await step("only the issuer can ring the 🔔; it posts a notice and starts a new round", async () => {
  const denied = await click(IDS.alice, chatMessage, `n:${chatSummons}`);
  assert.match(denied.json.data.content, /Only the issuing officer/);
  const before = inChat(/NOTICE/).length;
  const rung = await click(IDS.organizer, chatMessage, `n:${chatSummons}`);
  assert.equal(rung.json.type, 7);
  await tick();
  assert.equal(inChat(/NOTICE/).length, before + 1);
  const again = await click(IDS.organizer, chatMessage, `n:${chatSummons}`);
  assert.match(again.json.data.content, /still ringing/);
});

await step("Andrei answers in the chat and the issuer is told right there", async () => {
  const r = await click(IDS.alice, chatMessage, `r:${chatSummons}:yes`);
  assert.equal(r.json.type, 7);
  assert.match(text(r.json.data), /ACCEPTED/);
  assert.equal(r.json.data.components.length, 1, "no bell once answered");
  await tick();
  const told = inChat(/answered/).at(-1);
  assert.match(told.content, new RegExp(`📬 <@${IDS.organizer}> — \\*\\*Andrei\\*\\* answered`));
});

await step("extension requests are granted right in the chat", async () => {
  const r = await slash(IDS.organizer, { who: IDS.alice, what: "food", when: "30", title: "Operation Pizza", note: "bring cash" });
  const id = r.json.data.components[0].components[0].custom_id.split(":")[1];
  assert.match(text(r.json.data), /Operation Pizza/);
  assert.match(text(r.json.data), /bring cash/);
  const msg = messages().find((m) => m.channel_id === IDS.personalDm && m.components?.[0]?.components?.[0]?.custom_id === `r:${id}:yes`);
  const submitted = await submitModal(IDS.alice, msg, `m:${id}:extend`, "20 more minutes");
  assert.equal(submitted.json.type, 7);
  const grant = submitted.json.data.components[1].components.find((b) => b.custom_id?.startsWith("xs:"));
  assert.ok(grant, "grant button on the summons");
  const notMine = await click(IDS.alice, msg, grant.custom_id);
  assert.match(notMine.json.data.content, /Only the issuing officer/);
  const granted = await click(IDS.organizer, msg, grant.custom_id);
  assert.equal(granted.json.type, 7);
  assert.match(text(granted.json.data), /GRANTED/);
  await tick();
  assert.match(inChat(/extension request/).at(-1).content, /\*\*GRANTED\*\*/);
});

await step("/summon in the bot's own DM delivers it to them by DM instead", async () => {
  const r = await interact({
    type: 2,
    context: 1,
    channel_id: fake.dmChannelFor(IDS.organizer),
    user: user(IDS.organizer),
    data: {
      name: "summon",
      type: 1,
      options: [
        { name: "who", type: 6, value: IDS.alice },
        { name: "what", type: 3, value: "coffee" },
      ],
      resolved: { users: { [IDS.alice]: andrei } },
    },
  });
  assert.equal(r.json.type, 5);
  await waitFor("the deferred reply is filled in", () => {
    const hook = fake.state.webhooks.get(r.token);
    return fake.state.messages.get(hook?.originalId)?.content?.includes("delivered to **Andrei** by DM");
  });
});

await step("when someone blocks the bot, notices stop and the issuer is told", async () => {
  const r = await api("/api/summons", {
    ...baseDraft,
    title: "Blocked test",
    recipients: [IDS.alice],
    startsAt: Date.now() + 6 * 3_600_000,
    channelId: null,
    createScheduledEvent: false,
  });
  assert.equal(r.json.deliveries[0].deliveredVia, "dm");
  fake.state.dmClosed.add(IDS.alice);
  const warnings = () => dmsTo(IDS.organizer).filter((m) => m.content?.includes("can't reach Andrei any more"));
  const attempts = () =>
    fake.state.requests.filter(
      (q) => q.method === "POST" && q.path.endsWith("/messages") && /NOTICE/.test(q.body?.content ?? "") && JSON.stringify(q.body).includes("Blocked test"),
    ).length;
  try {
    await tick(46 * 60_000); // the second notice bounces: Andrei blocked the bot
    await tick(46 * 60_000 + 1_000); // the warning to the issuer goes out on the next pass
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0].content, /notices are stopped|Further notices are stopped/);
    const tried = attempts();
    await tick(92 * 60_000);
    await tick(138 * 60_000);
    assert.equal(warnings().length, 1, "warned once");
    assert.equal(attempts(), tried, "no further notices attempted");
    const dossier = await (await web(`/s/${r.json.id}`)).text();
    assert.match(dossier, /notices stopped/);
  } finally {
    fake.state.dmClosed.delete(IDS.alice);
  }
});

// --- designed on the website, posted with /summon ------------------------------------------------

const design = {
  ...baseDraft,
  title: "Operation Website",
  options: [
    { kind: "yes", label: "On my way", emoji: "🚀" },
    { kind: "no", label: "Not today", emoji: "😴" },
  ],
  startsAt: Date.now() + 2 * 3_600_000,
  createScheduledEvent: false,
};
const otherDm = "1400000000000000098"; // the organizer's DM with Bogdan

await step("website: 'Post it with /summon' saves a design for exactly one person", async () => {
  assert.match(await (await web("/new")).text(), /Post it with \/summon/);
  let r = await api("/api/summons/prepare", { ...design, recipients: [IDS.alice, IDS.bob] });
  assert.equal(r.status, 400);
  assert.equal(r.json.field, "recipients");
  r = await api("/api/summons/prepare", { ...design, recipients: [IDS.alice] });
  assert.equal(r.json.ok, true, r.json.error);
  assert.equal(r.json.name, "Andrei");
  assert.match(r.json.userInstallUrl, /integration_type=1/);
});

await step("/summon with nothing filled in posts that design right in the chat", async () => {
  const r = await slash(IDS.organizer, {});
  assert.equal(r.json.type, 4, JSON.stringify(r.json));
  assertValidMessage(r.json.data, "prepared /summon");
  assert.match(r.json.data.content, new RegExp(`<@${IDS.alice}>`));
  assert.match(text(r.json.data), /Operation Website/);
  const buttons = r.json.data.components[0].components;
  assert.deepEqual(buttons.map((b) => b.label), ["On my way", "Not today"]);
  assert.ok(r.json.data.components[1].components[0].custom_id.startsWith("n:"), "🔔 row");
  const id = buttons[0].custom_id.split(":")[1];
  assert.ok(messages().find((m) => m.channel_id === IDS.personalDm && m.components?.[0]?.components?.[0]?.custom_id === `r:${id}:yes`));
  const answered = await click(IDS.alice, messages().find((m) => m.components?.[0]?.components?.[0]?.custom_id === `r:${id}:yes`), `r:${id}:yes`);
  assert.match(text(answered.json.data), /ACCEPTED/);
});

await step("a design is posted once: the next /summon says nothing is waiting", async () => {
  const r = await slash(IDS.organizer, {});
  assert.equal(r.json.type, 4);
  assert.ok(r.json.data.flags & 64, "only the issuer sees it");
  assert.match(r.json.data.content, /no summons waiting/);
  assert.match(r.json.data.components[0].components[0].url, /\/new$/);
});

await step("'who' sends the design to someone else; with nothing saved it posts a generic summons", async () => {
  await api("/api/summons/prepare", { ...design, title: "Operation Redirect", recipients: [IDS.alice] });
  let r = await slash(IDS.organizer, { who: IDS.bob }, { channel_id: otherDm });
  assert.equal(r.json.type, 4);
  assert.match(r.json.data.content, new RegExp(`<@${IDS.bob}>`));
  assert.match(text(r.json.data), /Operation Redirect/);
  r = await slash(IDS.organizer, { who: IDS.alice });
  assert.equal(r.json.type, 4);
  assert.ok(!((r.json.data.flags ?? 0) & 64));
  assert.match(text(r.json.data), /Unspecified Operation/);
});

await step("when Discord says who's in the DM, the design goes to them", async () => {
  await api("/api/summons/prepare", { ...design, title: "Operation Partner", recipients: [IDS.alice] });
  const r = await slash(IDS.organizer, {}, { channel_id: otherDm, channel: { id: otherDm, type: 1, recipients: [bogdan] } });
  assert.equal(r.json.type, 4);
  assert.match(r.json.data.content, new RegExp(`<@${IDS.bob}>`));
  assert.match(text(r.json.data), /Operation Partner/);
});

await step("in the bot's own DM, /summon with nothing filled in has the bot DM the design", async () => {
  await api("/api/summons/prepare", { ...design, title: "Operation Courier", recipients: [IDS.alice] });
  const r = await interact({
    type: 2,
    context: 1,
    channel_id: fake.dmChannelFor(IDS.organizer),
    user: user(IDS.organizer),
    data: { name: "summon", type: 1 },
  });
  assert.equal(r.json.type, 5);
  await waitFor("the deferred reply is filled in", () => {
    const hook = fake.state.webhooks.get(r.token);
    return fake.state.messages.get(hook?.originalId)?.content?.includes("delivered to **Andrei** by DM");
  });
  assert.ok(dmsTo(IDS.alice).some((m) => text(m).includes("Operation Courier")));
});

await step("the 5-minute job updates commands registered by an older version", async () => {
  const summon = () => fake.state.commands.find((c) => c.name === "summon");
  assert.equal(summon().options.find((o) => o.name === "who").required, undefined, "stored like Discord: no required:false");
  summon().options.find((o) => o.name === "who").required = true; // what the previous version registered
  assert.match(await (await web("/setup")).text(), /Update them/);
  const cron = await fetch(`${WORKER}/cdn-cgi/handler/scheduled`);
  assert.equal(cron.status, 200, await cron.text());
  await waitFor("commands re-registered", () => !summon().options.find((o) => o.name === "who").required);
  assert.doesNotMatch(await (await web("/setup")).text(), /Update them/);
});

console.log(`\nAll ${passed} end-to-end checks passed.`);
shutdown();
process.exit(0);

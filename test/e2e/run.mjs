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

let interactionSeq = 0;
async function interact(payload, { badSignature = false } = {}) {
  const body = JSON.stringify({ id: String(++interactionSeq), application_id: IDS.app, token: "t", version: 1, ...payload });
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
  return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : text };
}
const user = (id) => ({ id, username: `u${id.slice(-2)}`, global_name: null });
function click(userId, message, customId) {
  const inGuild = !message.dm_user;
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
const dmsTo = (uid) => messages().filter((m) => m.dm_user === uid);
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

await step("live preview renders a valid Discord message", async () => {
  const r = await api("/api/preview", { title: "Preview", recipients: [IDS.alice] });
  assert.equal(r.status, 200);
  assertValidMessage(r.json.message, "preview");
  assert.match(text(r.json.message), /OFFICIAL SUMMONS/);
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
  const r = await click(IDS.alice, dm, `r:${second}:yes`);
  assert.match(r.json.data.content, /file is closed/);
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

console.log(`\nAll ${passed} end-to-end checks passed.`);
shutdown();
process.exit(0);

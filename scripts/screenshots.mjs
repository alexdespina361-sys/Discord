// Seeds the local stack with sample summonses and screenshots every page at phone and desktop sizes.
// Usage: node scripts/screenshots.mjs [outDir]   (needs Playwright + Chromium)
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { IDS } from "../test/e2e/fake-discord.mjs";
import { startStack } from "../test/e2e/harness.mjs";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}

const out = process.argv[2] ?? new URL("../test/e2e/.tmp/shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const stack = await startStack({ fakePort: 8791, workerPort: 8788, tmpName: ".tmp-shots" });
const { fake, worker } = stack;
fake.state.app.redirect_uris = [`${worker}/auth/callback`];
fake.state.app.flags = 1 << 15;
fake.state.app.interactions_endpoint_url = `${worker}/interactions`;
fake.state.authorized = new Set([IDS.organizer, IDS.alice, IDS.bob]);

// --- log in through the fake OAuth flow and seed data -------------------------------------
async function sessionFor(userId) {
  fake.state.browserUser = userId;
  const start = await fetch(`${worker}/auth/login`, { redirect: "manual" });
  const oauth = start.headers.getSetCookie()[0].split(";")[0];
  const authorize = await fetch(start.headers.get("location"), { redirect: "manual" });
  const back = await fetch(authorize.headers.get("location"), { redirect: "manual", headers: { cookie: oauth } });
  return back.headers.getSetCookie().find((c) => c.startsWith("bma_session=")).split(";")[0].split("=")[1];
}
const organizer = await sessionFor(IDS.organizer);
const alice = await sessionFor(IDS.alice);

async function post(path, body, session = organizer) {
  const res = await fetch(`${worker}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: worker, cookie: `bma_session=${session}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

const base = {
  guildId: IDS.guild,
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
};
const lidl = await post("/api/summons", {
  ...base,
  recipients: [IDS.alice, IDS.bob],
  classification: "MANDATORY LOGISTICS OPERATION",
  title: "Procurement Run — LIDL",
  objective: "Procurement of Pepsi, chips and questionable bakery items.",
  location: "Lidl",
  startsAt: Date.now() + 2 * 3_600_000,
  durationMin: 45,
  priority: "elevated",
  dressCode: "Civilian attire",
  signatureTitle: "Chief Logistics Officer",
});
await post("/api/summons", {
  ...base,
  recipients: [IDS.alice],
  classification: "COMBAT READINESS ORDER",
  title: "League of Legends Competitive Deployment",
  objective: "The team is critically understaffed. Your presence on the Rift is required to restore morale and secure LP.",
  location: "Summoner's Rift (Discord voice)",
  startsAt: Date.now() + 6 * 3_600_000,
  durationMin: 180,
  priority: "high",
  signatureTitle: "Supreme Commander of the Bot Lane",
});
await post(`/api/summons/${lidl.id}/respond`, { kind: "excuse", note: "my cat scheduled a meeting with me" }, alice);
await post("/api/summons", {
  ...base,
  recipients: [IDS.organizer],
  classification: "EMERGENCY NUTRITION SUMMIT",
  title: "Operation Full Stomach",
  objective: "A critical caloric deficit has been detected.",
  location: "The usual place",
  startsAt: Date.now() + 3_600_000,
  durationMin: 60,
  priority: "critical",
  signatureTitle: "Minister of Snacks",
}, alice);
await post("/dev/tick?advanceMs=2000", {});

// --- screenshots ------------------------------------------------------------------------------
const browser = await playwright.chromium.launch();
const shots = [
  { name: "landing", path: "/", session: null },
  { name: "dashboard", path: "/", session: organizer },
  { name: "compose", path: "/new", session: organizer, wait: ".dc-embed" },
  { name: "dossier", path: `/s/${lidl.id}`, session: organizer },
  { name: "dossier-recipient", path: `/s/${lidl.id}`, session: alice },
  { name: "setup", path: "/setup", session: organizer },
];
const viewports = [
  { tag: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { tag: "desktop", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
];

for (const vp of viewports) {
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ ...vp, colorScheme: scheme, ignoreHTTPSErrors: true });
    for (const shot of shots) {
      if (scheme === "dark" && !["landing", "compose", "dossier"].includes(shot.name)) continue;
      if (shot.session) await context.addCookies([{ name: "bma_session", value: shot.session, url: worker }]);
      else await context.clearCookies();
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(`${worker}${shot.path}`, { waitUntil: "networkidle" });
      if (shot.wait) await page.waitForSelector(shot.wait, { timeout: 10_000 });
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const file = `${out}/${shot.name}-${vp.tag}-${scheme}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log(`${file}${overflow > 0 ? `  ⚠️ horizontal overflow ${overflow}px` : ""}${errors.length ? `  ⚠️ ${errors.join(" | ")}` : ""}`);
      await page.close();
    }
    await context.close();
  }
}
await browser.close();
stack.stop();
process.exit(0);

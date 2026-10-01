// Renders public/static/seal.svg to the PNG Discord embeds use (Discord can't display SVG).
// Usage: node scripts/render-seal.mjs   (needs Playwright; not part of the deploy)
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}

const svg = readFileSync(new URL("../public/static/seal.svg", import.meta.url), "utf8");
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 2 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator("svg").screenshot({ path: new URL("../public/static/seal.png", import.meta.url).pathname, omitBackground: true });
await browser.close();
console.log("wrote public/static/seal.png");

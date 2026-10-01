// Starts the fake Discord API and the Worker (wrangler dev) wired to each other.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { IDS, createFakeDiscord, generateKeys, sign } from "./fake-discord.mjs";

export async function startStack({ fakePort = 8790, workerPort = 8787, tmpName = ".tmp" } = {}) {
  const worker = `http://127.0.0.1:${workerPort}`;
  const tmp = new URL(`./${tmpName}/`, import.meta.url).pathname;
  const keys = generateKeys();
  const fake = createFakeDiscord(keys);
  await fake.listen(fakePort);

  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(
    `${tmp}/test.env`,
    [
      `DISCORD_APPLICATION_ID=${IDS.app}`,
      `DISCORD_PUBLIC_KEY=${keys.publicKeyHex}`,
      `DISCORD_BOT_TOKEN=${fake.state.botToken}`,
      `DISCORD_CLIENT_SECRET=${fake.state.clientSecret}`,
      `DISCORD_API_BASE=http://127.0.0.1:${fakePort}/api/v10`,
      `DISCORD_WEB_BASE=http://127.0.0.1:${fakePort}`,
      "DEV_MODE=1",
    ].join("\n"),
  );

  const child = spawn(
    "npx",
    [
      "wrangler", "dev",
      "--port", String(workerPort),
      "--ip", "127.0.0.1",
      "--persist-to", `${tmp}/state`,
      "--env-file", `${tmp}/test.env`,
      "--show-interactive-dev-session=false",
      "--log-level", "warn",
    ],
    { cwd: new URL("../..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    fake.close();
  };
  process.on("exit", stop);

  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${worker}/healthz`)).ok) break;
    } catch {}
    if (i > 120) {
      stop();
      throw new Error(`Worker did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return { worker, fake, keys, stop, log: () => log, sign: (ts, body) => sign(keys.privateKey, ts, body) };
}

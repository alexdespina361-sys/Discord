import type { Bureau } from "./bureau";
import type { Gateway } from "./gateway";

export interface Env {
  BUREAU: DurableObjectNamespace<Bureau>;
  GATEWAY: DurableObjectNamespace<Gateway>;
  ASSETS: Fetcher;

  // Set these four as secrets in the Cloudflare dashboard.
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CLIENT_SECRET?: string;

  // Optional.
  SESSION_SECRET?: string;
  /** Comma-separated Discord user IDs allowed to issue summons. Empty = anyone in a server with the bot. */
  ALLOWED_USER_IDS?: string;
  BUREAU_NAME?: string;

  // Test/dev only.
  DISCORD_API_BASE?: string;
  DISCORD_WEB_BASE?: string;
  DISCORD_GATEWAY_URL?: string;
  DEV_MODE?: string;
}

export const DEFAULT_BUREAU_NAME = "Bureau of Mandatory Attendance";

export function bureauName(env: Env): string {
  return env.BUREAU_NAME?.trim() || DEFAULT_BUREAU_NAME;
}

export function apiBase(env: Env): string {
  return (env.DISCORD_API_BASE || "https://discord.com/api/v10").replace(/\/+$/, "");
}

export function webBase(env: Env): string {
  return (env.DISCORD_WEB_BASE || "https://discord.com").replace(/\/+$/, "");
}

export function gatewayBase(env: Env): string {
  return (env.DISCORD_GATEWAY_URL || "wss://gateway.discord.gg").replace(/\/+$/, "");
}

export function isDevMode(env: Env): boolean {
  return env.DEV_MODE === "1";
}

export type ConfigKey =
  | "DISCORD_APPLICATION_ID"
  | "DISCORD_PUBLIC_KEY"
  | "DISCORD_BOT_TOKEN"
  | "DISCORD_CLIENT_SECRET";

export const REQUIRED_KEYS: ConfigKey[] = [
  "DISCORD_APPLICATION_ID",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_SECRET",
];

export function missingConfig(env: Env): ConfigKey[] {
  return REQUIRED_KEYS.filter((k) => !env[k]?.trim());
}

/** Values pasted from the portal sometimes carry stray whitespace or a "Bot " prefix. */
export function cfg(env: Env, key: ConfigKey): string {
  const raw = env[key]?.trim() ?? "";
  if (key === "DISCORD_BOT_TOKEN") return raw.replace(/^Bot\s+/i, "");
  return raw;
}

export function allowedOrganizers(env: Env): Set<string> | null {
  const ids = (env.ALLOWED_USER_IDS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

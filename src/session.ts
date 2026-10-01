import { cfg, type Env } from "./env";
import { hmacSign, openToken, sealToken } from "./crypto";

export interface Session {
  uid: string;
  name: string;
  avatar: string | null;
  exp: number;
}

export const SESSION_COOKIE = "bma_session";
export const OAUTH_COOKIE = "bma_oauth";
const SESSION_TTL_S = 30 * 24 * 3600;

/** Without an explicit SESSION_SECRET, derive one from the bot token so there's one less thing to configure. */
export async function sessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET?.trim()) return env.SESSION_SECRET.trim();
  const token = cfg(env, "DISCORD_BOT_TOKEN") || cfg(env, "DISCORD_CLIENT_SECRET");
  if (!token) throw new Error("No secret available for sessions");
  return hmacSign(token, "summons-bureau/session/v1");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function getSession(request: Request, env: Env): Promise<Session | null> {
  let secret: string;
  try {
    secret = await sessionSecret(env);
  } catch {
    return null;
  }
  const session = await openToken<Session>(secret, readCookie(request, SESSION_COOKIE));
  if (!session || typeof session.uid !== "string" || session.exp * 1000 < Date.now()) return null;
  return session;
}

export async function createSessionCookie(
  env: Env,
  user: { id: string; name: string; avatar: string | null },
  secure: boolean,
): Promise<string> {
  const session: Session = {
    uid: user.id,
    name: user.name,
    avatar: user.avatar,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
  };
  return cookieHeader(SESSION_COOKIE, await sealToken(await sessionSecret(env), session), SESSION_TTL_S, secure);
}

export function clearCookie(name: string, secure: boolean): string {
  return cookieHeader(name, "", 0, secure);
}

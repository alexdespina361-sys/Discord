import { DiscordApi, DiscordError, authorizeUrl, avatarUrl, exchangeCode, inviteUrl } from "./discord";
import { isDevMode, missingConfig, type Env } from "./env";
import { openToken, randomId, sealToken } from "./crypto";
import { handleInteraction } from "./interactions";
import {
  OAUTH_COOKIE,
  clearCookie,
  cookieHeader,
  createSessionCookie,
  getSession,
  readCookie,
  sessionSecret,
  SESSION_COOKIE,
  type Session,
} from "./session";
import { SETUP_ACTIONS, redirectUrl, runAction, runChecks, syncCommands, type SetupAction } from "./setup";
import { bureauStub, gatewayStub } from "./stub";
import { createSummons, directory, jsonError, organizerAction, prepareSummons, preview, respondOnWeb, searchMembers, sharedGuilds } from "./web/api";
import { composePage, dashboardPage, dossierPage, landingPage, messagePage, prefillFrom, setupPage } from "./web/pages";

export { Bureau } from "./bureau";
export { Gateway } from "./gateway";

interface Ctx {
  env: Env;
  origin: string;
  session: Session | null;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** Rejects cross-site form/API posts. Browsers always send Origin on POST. */
function sameOrigin(request: Request, origin: string): boolean {
  const o = request.headers.get("origin");
  if (o) return o === origin;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface OAuthState {
  state: string;
  next: string;
  exp: number;
  consent?: boolean;
}

async function login(request: Request, c: Ctx): Promise<Response> {
  if (missingConfig(c.env).length) return redirect("/setup");
  const url = new URL(request.url);
  const state = randomId(24);
  const consent = url.searchParams.get("consent") === "1";
  const token = await sealToken(await sessionSecret(c.env), {
    state,
    next: safeNext(url.searchParams.get("next")),
    exp: Date.now() + 10 * 60_000,
    consent,
  } satisfies OAuthState);
  const secure = url.protocol === "https:";
  return redirect(authorizeUrl(c.env, redirectUrl(c.origin), state, !consent), [cookieHeader(OAUTH_COOKIE, token, 600, secure)]);
}

async function callback(request: Request, c: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const pending = await openToken<OAuthState>(await sessionSecret(c.env), readCookie(request, OAUTH_COOKIE));
  const retry = { href: "/auth/login", label: "Try again" };

  const error = url.searchParams.get("error");
  if (error) {
    // The quiet flow can be refused for first-time users; ask again with Discord's approval screen.
    if (error !== "access_denied" && pending && !pending.consent) {
      return redirect(`/auth/login?consent=1&next=${encodeURIComponent(pending.next)}`);
    }
    return messagePage(c, "Login cancelled", "Discord didn't confirm the login. No hard feelings.", 400, retry);
  }
  const code = url.searchParams.get("code");
  if (!code || !pending || pending.state !== url.searchParams.get("state") || pending.exp < Date.now()) {
    return messagePage(c, "Login expired", "That login link is stale. Start again from the Bureau.", 400, retry);
  }

  let accessToken: string;
  try {
    accessToken = await exchangeCode(c.env, code, redirectUrl(c.origin));
  } catch (e) {
    const body = e instanceof DiscordError ? JSON.stringify(e.body) : "";
    const hint = body.includes("invalid_client")
      ? "Discord rejected DISCORD_CLIENT_SECRET (or DISCORD_APPLICATION_ID). Reset the secret on the OAuth2 page and update it in Cloudflare."
      : body.includes("redirect_uri")
        ? `Add ${redirectUrl(c.origin)} under Redirects on the Discord OAuth2 page.`
        : `Discord said: ${e instanceof Error ? e.message : String(e)}`;
    return messagePage(c, "Login failed", hint, 502, { href: "/setup", label: "Open setup" });
  }

  const user = await DiscordApi.bearer(c.env, accessToken).me();
  const session = await createSessionCookie(
    c.env,
    { id: user.id, name: user.global_name || user.username, avatar: avatarUrl(user) },
    secure,
  );
  return redirect(pending.next, [session, clearCookie(OAUTH_COOKIE, secure)]);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const origin = url.origin;

  if (path === "/interactions" && method === "POST") return handleInteraction(request, env, ctx);
  if (path === "/healthz") return new Response("ok");

  const session = await getSession(request, env);
  const c: Ctx = { env, origin, session };
  const isPost = method === "POST";
  if (isPost && !sameOrigin(request, origin)) return jsonError(403, "Cross-site request refused.");

  if (path === "/auth/login") return login(request, c);
  if (path === "/auth/callback") return callback(request, c);
  if (path === "/auth/logout" && isPost) return redirect("/", [clearCookie(SESSION_COOKIE, url.protocol === "https:")]);

  if (path === "/setup" && method === "GET") return setupPage(c, await runChecks(env, origin, session));
  const setupAction = path.match(/^\/setup\/([a-z-]+)$/);
  if (setupAction && isPost && SETUP_ACTIONS.includes(setupAction[1] as SetupAction)) {
    return Response.json(await runAction(setupAction[1] as SetupAction, env, origin, session));
  }

  if (path === "/dev/tick" && isPost && isDevMode(env)) {
    await bureauStub(env).tick(Date.now() + Number(url.searchParams.get("advanceMs") ?? 0));
    return Response.json({ ok: true });
  }

  if (path === "/" && method === "GET") {
    if (!session) return landingPage(c);
    return dashboardPage({ ...c, session }, await bureauStub(env).dashboard(session.uid));
  }

  // Everything below needs a logged-in user.
  const isApi = path.startsWith("/api/");
  if (!session) {
    if (isApi) return jsonError(401, "Log in first.");
    if (path === "/new" || path.startsWith("/s/")) return redirect(`/auth/login?next=${encodeURIComponent(path + url.search)}`);
    return messagePage(c, "Not found", "The Bureau has no record of that page.", 404);
  }
  const sc = { ...c, session };

  if (path === "/new" && method === "GET") {
    if (missingConfig(env).length) return redirect("/setup");
    const guilds = await sharedGuilds(env, session.uid);
    let prefill = null;
    const from = url.searchParams.get("from");
    if (from) {
      const d = await bureauStub(env).get(from);
      if (d && d.summons.organizer.id === session.uid) prefill = prefillFrom(d.summons, d.invites);
    }
    return composePage(sc, guilds, inviteUrl(env), prefill);
  }

  const dossier = path.match(/^\/s\/([A-Za-z0-9]{4,32})$/);
  if (dossier && method === "GET") {
    const d = await bureauStub(env).get(dossier[1]!);
    const allowed = d && (d.summons.organizer.id === session.uid || d.invites.some((i) => i.recipient.id === session.uid));
    if (!d || !allowed) return messagePage(c, "File not found", "Either this summons doesn't exist or it isn't addressed to you.", 404);
    return dossierPage(sc, d);
  }

  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/guilds\/(\d{15,21})\/directory$/)) && method === "GET") return directory(env, session, m[1]!);
  if ((m = path.match(/^\/api\/guilds\/(\d{15,21})\/search$/)) && method === "GET") {
    return searchMembers(env, session, m[1]!, url.searchParams.get("q") ?? "");
  }
  if (path === "/api/preview" && isPost) return preview(env, session, await readJson(request), origin);
  if (path === "/api/summons" && isPost) return createSummons(env, session, await readJson(request), origin);
  if (path === "/api/summons/prepare" && isPost) return prepareSummons(env, session, await readJson(request), origin);
  if ((m = path.match(/^\/api\/summons\/([A-Za-z0-9]{4,32})\/(cancel|nudge|respond)$/)) && isPost) {
    if (m[2] === "respond") return respondOnWeb(env, session, m[1]!, await readJson(request));
    return organizerAction(env, session, m[1]!, m[2] as "cancel" | "nudge");
  }

  if (isApi) return jsonError(404, "Unknown endpoint.");
  return messagePage(c, "Not found", "The Bureau has no record of that page.", 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error("request failed", e);
      const message = e instanceof Error ? e.message : String(e);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/setup/")) return jsonError(500, message);
      return messagePage(
        { env, origin: url.origin, session: null },
        "The Bureau's filing system jammed",
        message,
        500,
        { href: "/setup", label: "Check setup" },
      );
    }
  },

  /**
   * Every 5 minutes: make sure the Gateway connection that hears DMs is up (it also has its own watchdog),
   * and bring the slash commands up to date after a deploy changed them.
   */
  async scheduled(_controller, env, ctx): Promise<void> {
    if (missingConfig(env).length) return;
    ctx.waitUntil(
      gatewayStub(env)
        .ensure()
        .then(() => undefined)
        .catch((e) => console.error("gateway watchdog failed", e)),
    );
    ctx.waitUntil(syncCommands(env).catch((e) => console.error("command sync failed", e)));
  },
} satisfies ExportedHandler<Env>;

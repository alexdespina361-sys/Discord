import { apiBase, cfg, webBase, type Env } from "./env";

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

export interface DiscordMember {
  user?: DiscordUser;
  nick?: string | null;
  avatar?: string | null;
  roles?: string[];
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon?: string | null;
  owner_id?: string;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  position?: number;
  parent_id?: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
}

/** A message as Discord sends it in history listings and Gateway events (only the fields we read). */
export interface DiscordFullMessage extends DiscordMessage {
  type?: number;
  guild_id?: string;
  author?: DiscordUser;
  content?: string;
  attachments?: { url: string; filename: string }[];
  sticker_items?: { name: string }[];
  message_reference?: { message_id?: string };
}

export interface DiscordApplication {
  id: string;
  name: string;
  icon?: string | null;
  verify_key: string;
  flags?: number;
  redirect_uris?: string[];
  interactions_endpoint_url?: string | null;
  owner?: DiscordUser;
  team?: { owner_user_id?: string; members?: { user: DiscordUser }[] } | null;
  bot_public?: boolean;
  bot?: DiscordUser;
  /** Keys are the install contexts the app supports: "0" = servers, "1" = user accounts. */
  integration_types_config?: Record<string, { oauth2_install_params?: { scopes: string[]; permissions: string } }>;
}

export interface DiscordCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  max_length?: number;
  choices?: { name: string; value: string }[];
}

export interface DiscordCommand {
  id?: string;
  name: string;
  description: string;
  type?: number;
  integration_types?: number[];
  contexts?: number[];
  options?: DiscordCommandOption[];
}

export const CHANNEL_TYPE_GUILD_TEXT = 0;
export const CHANNEL_TYPE_GUILD_ANNOUNCEMENT = 5;

/** Discord error codes we react to. */
export const ERR_UNKNOWN_MEMBER = 10007;
export const ERR_UNKNOWN_MESSAGE = 10008;
export const ERR_CANNOT_DM = 50007;
export const ERR_NO_MUTUAL_GUILDS = 50278;
export const ERR_INVALID_FORM = 50035;
export const ERR_MISSING_ACCESS = 50001;
export const ERR_MISSING_PERMISSIONS = 50013;

export const FLAG_GATEWAY_GUILD_MEMBERS = 1 << 14;
export const FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "DiscordError";
  }

  get cannotDm(): boolean {
    return this.code === ERR_CANNOT_DM || this.code === ERR_NO_MUTUAL_GUILDS;
  }
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: Query;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DiscordApi {
  constructor(
    private readonly base: string,
    private readonly authorization: string,
  ) {}

  static bot(env: Env): DiscordApi {
    return new DiscordApi(apiBase(env), `Bot ${cfg(env, "DISCORD_BOT_TOKEN")}`);
  }

  static bearer(env: Env, accessToken: string): DiscordApi {
    return new DiscordApi(apiBase(env), `Bearer ${accessToken}`);
  }

  /** Interaction webhooks are authorized by the token in their URL. */
  static webhooks(env: Env): DiscordApi {
    return new DiscordApi(apiBase(env), "");
  }

  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      "user-agent": "DiscordBot (https://github.com/alexdespina361-sys/Discord, 1.0)",
      ...opts.headers,
    };
    if (this.authorization) headers.authorization = this.authorization;
    let payload: string | undefined;
    if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(opts.form).toString();
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url.toString(), { method, headers, body: payload });
      if (res.status === 429 && attempt < 2) {
        const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const wait = Math.ceil((data.retry_after ?? 1) * 1000);
        if (wait <= 5000) {
          await sleep(wait);
          continue;
        }
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const err = (data ?? {}) as { code?: number; message?: string; error?: string; error_description?: string };
        const message = err.message ?? err.error_description ?? err.error ?? `HTTP ${res.status}`;
        throw new DiscordError(res.status, err.code ?? 0, `${method} ${path}: ${message}`, data);
      }
      return data as T;
    }
  }

  // --- users & guilds -------------------------------------------------------

  me() {
    return this.request<DiscordUser>("GET", "/users/@me");
  }

  myGuilds() {
    return this.request<DiscordGuild[]>("GET", "/users/@me/guilds", undefined, { query: { limit: 200 } });
  }

  guild(guildId: string) {
    return this.request<DiscordGuild>("GET", `/guilds/${guildId}`);
  }

  member(guildId: string, userId: string) {
    return this.request<DiscordMember>("GET", `/guilds/${guildId}/members/${userId}`);
  }

  /** Requires the Server Members privileged intent. */
  listMembers(guildId: string) {
    return this.request<DiscordMember[]>("GET", `/guilds/${guildId}/members`, undefined, { query: { limit: 1000 } });
  }

  searchMembers(guildId: string, query: string) {
    return this.request<DiscordMember[]>("GET", `/guilds/${guildId}/members/search`, undefined, {
      query: { query, limit: 25 },
    });
  }

  channels(guildId: string) {
    return this.request<DiscordChannel[]>("GET", `/guilds/${guildId}/channels`);
  }

  // --- messages -------------------------------------------------------------

  openDm(userId: string) {
    return this.request<DiscordChannel>("POST", "/users/@me/channels", { recipient_id: userId });
  }

  sendMessage(channelId: string, message: object) {
    return this.request<DiscordMessage>("POST", `/channels/${channelId}/messages`, message);
  }

  editMessage(channelId: string, messageId: string, message: object) {
    return this.request<DiscordMessage>("PATCH", `/channels/${channelId}/messages/${messageId}`, message);
  }

  async sendDm(userId: string, message: object): Promise<DiscordMessage> {
    const channel = await this.openDm(userId);
    return this.sendMessage(channel.id, message);
  }

  /** Messages after `after` (oldest first is not guaranteed; callers sort). */
  channelMessages(channelId: string, after: string, limit = 20) {
    return this.request<DiscordFullMessage[]>("GET", `/channels/${channelId}/messages`, undefined, { query: { after, limit } });
  }

  addReaction(channelId: string, messageId: string, emoji: string) {
    return this.request<void>("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  // --- interaction webhooks (valid for 15 minutes after the interaction) -------------

  followup(applicationId: string, token: string, message: object) {
    return this.request<DiscordMessage>("POST", `/webhooks/${applicationId}/${token}`, message);
  }

  editOriginal(applicationId: string, token: string, message: object) {
    return this.request<DiscordMessage>("PATCH", `/webhooks/${applicationId}/${token}/messages/@original`, message);
  }

  // --- scheduled events -----------------------------------------------------

  createScheduledEvent(guildId: string, body: object) {
    return this.request<{ id: string }>("POST", `/guilds/${guildId}/scheduled-events`, body);
  }

  deleteScheduledEvent(guildId: string, eventId: string) {
    return this.request<void>("DELETE", `/guilds/${guildId}/scheduled-events/${eventId}`);
  }

  // --- application ----------------------------------------------------------

  application() {
    return this.request<DiscordApplication>("GET", "/applications/@me");
  }

  editApplication(body: Partial<Pick<DiscordApplication, "interactions_endpoint_url" | "flags" | "integration_types_config">>) {
    return this.request<DiscordApplication>("PATCH", "/applications/@me", body);
  }

  commands(applicationId: string) {
    return this.request<DiscordCommand[]>("GET", `/applications/${applicationId}/commands`);
  }

  putCommands(applicationId: string, commands: DiscordCommand[]) {
    return this.request<DiscordCommand[]>("PUT", `/applications/${applicationId}/commands`, commands);
  }
}

// --- OAuth2 -------------------------------------------------------------------

/** `quiet` skips Discord's approval screen for people who already authorized the app. */
export function authorizeUrl(env: Env, redirectUri: string, state: string, quiet = true): string {
  const u = new URL(webBase(env) + "/oauth2/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg(env, "DISCORD_APPLICATION_ID"));
  u.searchParams.set("scope", "identify");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  if (quiet) u.searchParams.set("prompt", "none");
  return u.toString();
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string> {
  const basic = btoa(`${cfg(env, "DISCORD_APPLICATION_ID")}:${cfg(env, "DISCORD_CLIENT_SECRET")}`);
  const api = new DiscordApi(apiBase(env), `Basic ${basic}`);
  const token = await api.request<{ access_token: string }>("POST", "/oauth2/token", undefined, {
    form: { grant_type: "authorization_code", code, redirect_uri: redirectUri },
  });
  return token.access_token;
}

/** View Channel, Send Messages, Embed Links, Read Message History, Create Events. */
export const BOT_PERMISSIONS = ((1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n) | (1n << 44n)).toString();

export function inviteUrl(env: Env, guildId?: string): string {
  const u = new URL(webBase(env) + "/oauth2/authorize");
  u.searchParams.set("client_id", cfg(env, "DISCORD_APPLICATION_ID"));
  u.searchParams.set("scope", "bot applications.commands");
  u.searchParams.set("permissions", BOT_PERMISSIONS);
  u.searchParams.set("integration_type", "0");
  if (guildId) u.searchParams.set("guild_id", guildId);
  return u.toString();
}

/** Lets someone add the app to their own Discord account, so /summon works in their DMs. */
export function userInstallUrl(env: Env): string {
  const u = new URL(webBase(env) + "/oauth2/authorize");
  u.searchParams.set("client_id", cfg(env, "DISCORD_APPLICATION_ID"));
  u.searchParams.set("integration_type", "1");
  u.searchParams.set("scope", "applications.commands");
  return u.toString();
}

export function portalUrl(env: Env, page: "information" | "oauth2" | "bot" | "installation" = "information"): string {
  const id = cfg(env, "DISCORD_APPLICATION_ID");
  return id ? `https://discord.com/developers/applications/${id}/${page}` : "https://discord.com/developers/applications";
}

// --- helpers ------------------------------------------------------------------

export function displayName(user: DiscordUser, member?: DiscordMember | null): string {
  return member?.nick || user.global_name || user.username;
}

export function avatarUrl(user: Pick<DiscordUser, "id" | "avatar">): string {
  if (user.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=64`;
  }
  let index = 0;
  try {
    index = Number((BigInt(user.id) >> 22n) % 6n);
  } catch {
    // non-numeric test IDs
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function messageLink(guildId: string | null, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

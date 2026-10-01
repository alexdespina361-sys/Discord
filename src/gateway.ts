import { DurableObject } from "cloudflare:workers";
import type { DiscordFullMessage } from "./discord";
import { cfg, gatewayBase, type Env } from "./env";
import { toIncomingDm } from "./relay";
import { bureauStub } from "./stub";

/**
 * Keeps one live connection to Discord's Gateway so the bot hears DMs people send it.
 * Interactions (buttons, forms, slash commands) still arrive over HTTP; this is only for chat messages.
 *
 * An open outbound WebSocket keeps this object in memory, and a watchdog alarm every minute
 * restarts the connection if Cloudflare ever evicts it (e.g. after a deploy).
 */

const INTENT_DIRECT_MESSAGES = 1 << 12;
const WATCHDOG_MS = 60_000;
const STUCK_CONNECTING_MS = 30_000;
/** Discord won't accept these again without a fix on our side (bad token, intents). */
const FATAL_CLOSE: Record<number, string> = {
  4004: "Discord rejected the bot token",
  4010: "Invalid shard",
  4011: "Sharding required",
  4012: "Invalid API version",
  4013: "Invalid intents",
  4014: "Discord refused the requested intents",
};
/** These end the session: start a new one instead of resuming. */
const NEW_SESSION_CLOSE = new Set([1000, 1001, 4007, 4009]);

export type GatewayState = "off" | "connecting" | "connected" | "reconnecting" | "error";

export interface GatewayStatus {
  enabled: boolean;
  state: GatewayState;
  since: number | null;
  error: string | null;
}

interface Saved {
  enabled: boolean;
  sessionId: string | null;
  resumeUrl: string | null;
  seq: number | null;
  fatal: string | null;
  fatalAt: number;
}

const DEFAULTS: Saved = { enabled: true, sessionId: null, resumeUrl: null, seq: null, fatal: null, fatalAt: 0 };

interface Frame {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

export class Gateway extends DurableObject<Env> {
  private saved: Saved = { ...DEFAULTS };
  private ws: WebSocket | null = null;
  private beatTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private acked = true;
  private state: GatewayState = "off";
  private since: number | null = null;
  private error: string | null = null;
  private attempts = 0;
  private connectingSince = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.saved = { ...DEFAULTS, ...((await ctx.storage.get<Saved>("gateway")) ?? {}) };
    });
  }

  // --- RPC ---------------------------------------------------------------------------

  /** Connects if we should be connected and aren't. Called by the watchdog alarm, the cron trigger and the setup page. */
  async ensure(force = false): Promise<GatewayStatus> {
    if (!this.saved.enabled || !cfg(this.env, "DISCORD_BOT_TOKEN")) {
      this.shutdown();
      await this.ctx.storage.deleteAlarm();
      return this.status();
    }
    if (force && this.saved.fatal) {
      this.saved.fatal = null;
      await this.persist();
    }
    // After a fatal close, retry at most hourly unless someone asks explicitly.
    const coolingDown = this.saved.fatal && Date.now() - this.saved.fatalAt < 3_600_000;
    if (!coolingDown) {
      const stuck = this.state === "connecting" && Date.now() - this.connectingSince > STUCK_CONNECTING_MS;
      if ((!this.ws && !this.retryTimer) || stuck) await this.openSocket();
    }
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    return this.status();
  }

  async setEnabled(enabled: boolean): Promise<GatewayStatus> {
    this.saved.enabled = enabled;
    this.saved.fatal = null;
    await this.persist();
    return this.ensure(true);
  }

  status(): GatewayStatus {
    return {
      enabled: this.saved.enabled,
      state: this.saved.fatal ? "error" : this.state,
      since: this.since,
      error: this.saved.fatal ?? (this.state === "connected" ? null : this.error),
    };
  }

  override async alarm(): Promise<void> {
    await this.ensure();
  }

  // --- connection --------------------------------------------------------------------

  private async openSocket(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardown(4000);
    const resuming = Boolean(this.saved.sessionId && this.saved.resumeUrl);
    this.state = resuming ? "reconnecting" : "connecting";
    this.connectingSince = Date.now();
    const base = resuming ? this.saved.resumeUrl! : gatewayBase(this.env);
    // Workers open WebSockets with fetch(); it wants http(s) URLs.
    const url = `${base.replace(/^ws/i, "http").replace(/\/+$/, "")}/?v=10&encoding=json`;
    try {
      const res = await fetch(url, { headers: { Upgrade: "websocket" } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`Discord refused the connection (HTTP ${res.status})`);
      ws.accept();
      this.ws = ws;
      this.acked = true;
      ws.addEventListener("message", (e) => this.onFrame(ws, e.data));
      ws.addEventListener("close", (e) => this.onClose(ws, e.code, e.reason));
      ws.addEventListener("error", () => this.onClose(ws, 1006, "socket error"));
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.scheduleReconnect();
    }
  }

  private onFrame(ws: WebSocket, data: unknown): void {
    if (ws !== this.ws) return;
    let frame: Frame;
    try {
      frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer)) as Frame;
    } catch {
      return;
    }
    if (typeof frame.s === "number") this.saved.seq = frame.s;
    switch (frame.op) {
      case 10: // Hello
        this.startHeartbeat((frame.d as { heartbeat_interval: number }).heartbeat_interval);
        this.identifyOrResume();
        break;
      case 11: // Heartbeat ACK
        this.acked = true;
        break;
      case 1: // Heartbeat request
        this.beat();
        break;
      case 7: // Reconnect
        this.reconnect("Discord asked for a reconnect");
        break;
      case 9: // Invalid session
        if (!frame.d) this.clearSession();
        this.teardown(4000);
        this.scheduleReconnect(1000 + Math.floor(Math.random() * 4000));
        break;
      case 0: // Dispatch
        void this.dispatch(frame.t ?? "", frame.d);
        break;
    }
  }

  private identifyOrResume(): void {
    const token = cfg(this.env, "DISCORD_BOT_TOKEN");
    if (this.saved.sessionId && this.saved.seq !== null) {
      this.send({ op: 6, d: { token, session_id: this.saved.sessionId, seq: this.saved.seq } });
    } else {
      this.send({
        op: 2,
        d: {
          token,
          intents: INTENT_DIRECT_MESSAGES,
          properties: { os: "linux", browser: "summons-bureau", device: "summons-bureau" },
        },
      });
    }
  }

  private async dispatch(type: string, data: unknown): Promise<void> {
    switch (type) {
      case "READY": {
        const d = data as { session_id: string; resume_gateway_url: string };
        this.saved.sessionId = d.session_id;
        this.saved.resumeUrl = d.resume_gateway_url;
        this.markConnected();
        await this.persist();
        // A fresh session doesn't replay what we missed while disconnected; fetch it instead.
        await bureauStub(this.env)
          .relayCatchUp()
          .catch((e) => console.error("relay catch-up failed", e));
        break;
      }
      case "RESUMED":
        this.markConnected();
        await this.persist();
        break;
      case "MESSAGE_CREATE": {
        await this.persist();
        const dm = toIncomingDm(data as DiscordFullMessage);
        if (dm) await bureauStub(this.env).relayIncoming(dm).catch((e) => console.error("relay failed", e));
        break;
      }
    }
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    const tick = () => {
      if (!this.acked) {
        this.reconnect("Discord stopped answering heartbeats");
        return;
      }
      this.beat();
      this.beatTimer = setTimeout(tick, interval);
    };
    this.beatTimer = setTimeout(tick, Math.floor(interval * Math.random()));
  }

  private beat(): void {
    this.acked = false;
    this.send({ op: 1, d: this.saved.seq });
  }

  private send(payload: object): void {
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (e) {
      console.error("gateway send failed", e);
    }
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopHeartbeat();
    const fatal = FATAL_CLOSE[code];
    if (fatal) {
      this.state = "error";
      this.saved.fatal = `${fatal} (close code ${code})`;
      this.saved.fatalAt = Date.now();
      this.clearSession();
      void this.persist();
      return;
    }
    if (NEW_SESSION_CLOSE.has(code)) this.clearSession();
    this.error = `Connection closed (${code}${reason ? `: ${reason}` : ""})`;
    this.scheduleReconnect();
  }

  private reconnect(reason: string): void {
    this.error = reason;
    this.teardown(4000); // a non-1000 code keeps the session resumable
    this.scheduleReconnect(500);
  }

  private scheduleReconnect(delay?: number): void {
    if (this.retryTimer) return;
    this.state = "reconnecting";
    const wait = delay ?? Math.min(60_000, 1000 * 2 ** this.attempts++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.openSocket();
    }, wait);
  }

  private markConnected(): void {
    this.state = "connected";
    this.since = Date.now();
    this.attempts = 0;
    this.error = null;
  }

  private teardown(code: number): void {
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, "reconnecting");
      } catch {
        // already closed
      }
    }
  }

  private shutdown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(1000);
    this.clearSession();
    this.state = "off";
    this.since = null;
  }

  private stopHeartbeat(): void {
    if (this.beatTimer) clearTimeout(this.beatTimer);
    this.beatTimer = null;
  }

  private clearSession(): void {
    this.saved.sessionId = null;
    this.saved.resumeUrl = null;
    this.saved.seq = null;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("gateway", this.saved);
  }
}

// A small stand-in for the Discord API, good enough to drive the Bureau end to end.
// It enforces Discord's payload limits so we catch messages the real API would reject.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

export const IDS = {
  app: "1400000000000000001",
  bot: "1400000000000000002",
  guild: "1400000000000000003",
  general: "1400000000000000004",
  voice: "1400000000000000005",
  organizer: "1400000000000000010",
  alice: "1400000000000000011",
  bob: "1400000000000000012", // has DMs closed
  stranger: "1400000000000000013", // not in the guild
  personalDm: "1400000000000000099", // the organizer's own DM with Andrei (the bot isn't in it)
};

const USERS = {
  [IDS.bot]: { id: IDS.bot, username: "bureau", global_name: "Bureau", avatar: null, bot: true },
  [IDS.organizer]: { id: IDS.organizer, username: "mihai", global_name: "Mihai", avatar: null },
  [IDS.alice]: { id: IDS.alice, username: "andrei", global_name: "Andrei", avatar: null },
  [IDS.bob]: { id: IDS.bob, username: "bogdan", global_name: "Bogdan", avatar: null },
  [IDS.stranger]: { id: IDS.stranger, username: "stranger", global_name: "Stranger", avatar: null },
};

export function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKeyHex: raw.toString("hex"), privateKey };
}

export function sign(privateKey, timestamp, body) {
  return crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
}

// --- payload validation (Discord's documented limits) -------------------------------

function validateMessage(p) {
  const errors = [];
  const len = (s) => [...(s ?? "")].length;
  if (p.content !== undefined && len(p.content) > 2000) errors.push("content > 2000");
  const embeds = p.embeds ?? [];
  if (embeds.length > 10) errors.push("embeds > 10");
  let total = 0;
  for (const e of embeds) {
    if (len(e.title) > 256) errors.push("embed.title > 256");
    if (len(e.description) > 4096) errors.push("embed.description > 4096");
    if (len(e.author?.name) > 256) errors.push("embed.author.name > 256");
    if (len(e.footer?.text) > 2048) errors.push("embed.footer.text > 2048");
    if ((e.fields ?? []).length > 25) errors.push("embed.fields > 25");
    for (const f of e.fields ?? []) {
      if (!f.name || len(f.name) > 256) errors.push(`field name invalid: ${f.name}`);
      if (!f.value || len(f.value) > 1024) errors.push(`field value invalid (${len(f.value)}) for ${f.name}`);
      total += len(f.name) + len(f.value);
    }
    total += len(e.title) + len(e.description) + len(e.author?.name) + len(e.footer?.text);
    if (e.color !== undefined && (e.color < 0 || e.color > 0xffffff)) errors.push("embed.color");
    if (e.timestamp && Number.isNaN(Date.parse(e.timestamp))) errors.push("embed.timestamp");
  }
  if (total > 6000) errors.push(`embeds total ${total} > 6000`);
  const rows = p.components ?? [];
  if (rows.length > 5) errors.push("components > 5 rows");
  for (const row of rows) {
    if (row.type !== 1) errors.push("top-level component must be an action row");
    if ((row.components ?? []).length < 1 || row.components.length > 5) errors.push("row must have 1-5 buttons");
    for (const b of row.components ?? []) {
      if (b.type !== 2) errors.push("expected button");
      if (len(b.label) > 80) errors.push("button.label > 80");
      if (b.style === 5) {
        if (!b.url || b.custom_id) errors.push("link button needs url and no custom_id");
      } else if (!b.custom_id || len(b.custom_id) > 100) errors.push("button.custom_id invalid");
    }
  }
  if (!p.content && !embeds.length && !rows.length) errors.push("empty message");
  return errors;
}

export function validateModal(m) {
  const errors = [];
  if (!m.custom_id || m.custom_id.length > 100) errors.push("modal.custom_id");
  if (!m.title || [...m.title].length > 45) errors.push(`modal.title (${m.title})`);
  if (!m.components?.length || m.components.length > 5) errors.push("modal needs 1-5 components");
  for (const c of m.components ?? []) {
    if (c.type === 18) {
      if (!c.label || [...c.label].length > 45) errors.push(`label.label > 45: ${c.label}`);
      if (c.description && [...c.description].length > 100) errors.push("label.description > 100");
      if (c.component?.type !== 4) errors.push("label must wrap a text input here");
      if ((c.component?.placeholder ?? "").length > 100) errors.push("placeholder > 100");
    } else if (c.type !== 10) {
      errors.push(`unexpected modal component ${c.type}`);
    }
  }
  return errors;
}

export { validateMessage };

// --- server ------------------------------------------------------------------------------

const DISCORD_EPOCH = 1420070400000n;

export function createFakeDiscord({ publicKeyHex, privateKey }) {
  // Real snowflakes: milliseconds since Discord's epoch, shifted left 22 bits.
  let last = 0n;
  const nextId = () => {
    let id = (BigInt(Date.now()) - DISCORD_EPOCH) << 22n;
    if (id <= last) id = last + 1n;
    last = id;
    return String(id);
  };
  const dmChannels = new Map(); // userId -> channelId
  const state = {
    app: {
      id: IDS.app,
      name: "Test Bureau",
      verify_key: publicKeyHex,
      flags: 0,
      redirect_uris: [],
      interactions_endpoint_url: null,
      owner: USERS[IDS.organizer],
      bot: USERS[IDS.bot],
      integration_types_config: { 0: {} }, // new apps only support server installs
    },
    members: [IDS.organizer, IDS.alice, IDS.bob, IDS.bot],
    dmClosed: new Set([IDS.bob]),
    messages: new Map(), // id -> message
    events: [],
    deletedEvents: [],
    commands: [],
    requests: [],
    browserUser: IDS.organizer,
    authorized: new Set(), // users who approved the app before (prompt=none only works for them)
    clientSecret: "test-client-secret",
    botToken: "test-bot-token",
    webhooks: new Map(), // interaction token -> { channelId, originalId, followups }
    gateway: { heartbeatInterval: 2000, connections: 0, identifies: 0, resumes: 0, intents: null, session: null, sockets: new Set() },
    port: 0,
  };

  function dmChannelFor(userId) {
    if (!dmChannels.has(userId)) dmChannels.set(userId, nextId());
    return dmChannels.get(userId);
  }

  function dmUserOf(channelId) {
    return [...dmChannels.entries()].find(([, cid]) => cid === channelId)?.[0] ?? null;
  }

  // --- Gateway ---------------------------------------------------------------------------
  function gatewayDispatch(t, d) {
    const session = state.gateway.session;
    if (!session) return;
    const frame = { op: 0, t, d, s: ++session.seq };
    session.buffer.push(frame);
    for (const conn of state.gateway.sockets) if (conn.ready) conn.ws.send(JSON.stringify(frame));
  }

  function onGatewaySocket(ws) {
    state.gateway.connections++;
    const conn = { ws, ready: false };
    state.gateway.sockets.add(conn);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: state.gateway.heartbeatInterval } }));
    ws.on("message", (raw) => {
      const p = JSON.parse(String(raw));
      if (p.op === 1) {
        ws.send(JSON.stringify({ op: 11 }));
      } else if (p.op === 2) {
        if (p.d.token !== state.botToken) return ws.close(4004, "Authentication failed.");
        state.gateway.identifies++;
        state.gateway.intents = p.d.intents;
        state.gateway.session = { id: `sess-${nextId()}`, seq: 0, buffer: [] };
        conn.ready = true;
        gatewayDispatch("READY", {
          v: 10,
          user: USERS[IDS.bot],
          session_id: state.gateway.session.id,
          resume_gateway_url: `ws://127.0.0.1:${state.port}`,
          guilds: [],
          application: { id: IDS.app },
        });
      } else if (p.op === 6) {
        state.gateway.resumes++;
        const session = state.gateway.session;
        if (!session || p.d.session_id !== session.id) return ws.send(JSON.stringify({ op: 9, d: false }));
        conn.ready = true;
        for (const frame of session.buffer.filter((f) => f.s > p.d.seq)) ws.send(JSON.stringify(frame));
        ws.send(JSON.stringify({ op: 0, t: "RESUMED", d: {}, s: ++session.seq }));
      }
    });
    ws.on("close", () => state.gateway.sockets.delete(conn));
  }

  function storeMessage(channelId, payload, author) {
    const dmUser = dmUserOf(channelId);
    const msg = {
      id: nextId(),
      channel_id: channelId,
      dm_user: dmUser,
      author,
      type: payload.message_reference ? 19 : 0,
      ...payload,
      edits: 0,
      reactions: [],
    };
    state.messages.set(msg.id, msg);
    // Discord tells the bot about every DM message, including its own.
    if (dmUser) {
      gatewayDispatch("MESSAGE_CREATE", {
        id: msg.id,
        channel_id: channelId,
        type: msg.type,
        author,
        content: msg.content ?? "",
        attachments: msg.attachments ?? [],
        sticker_items: msg.sticker_items,
        message_reference: msg.message_reference,
      });
    }
    return msg;
  }

  const member = (id) => ({ user: USERS[id], nick: null, roles: [] });
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const invalid = (res, errors) => send(res, 400, { code: 50035, message: "Invalid Form Body", errors: { _errors: errors } });

  async function verifyEndpoint(url) {
    const ping = JSON.stringify({ type: 1, id: nextId(), application_id: IDS.app, token: "t", version: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    const good = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature-ed25519": sign(privateKey, ts, ping), "x-signature-timestamp": ts },
      body: ping,
    });
    const goodBody = await good.json().catch(() => null);
    if (good.status !== 200 || goodBody?.type !== 1) return false;
    const bad = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": ts },
      body: ping,
    });
    return bad.status === 401;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const ctype = req.headers["content-type"] ?? "";
    let body = null;
    if (raw && ctype.includes("json")) body = JSON.parse(raw);
    else if (raw && ctype.includes("form")) body = Object.fromEntries(new URLSearchParams(raw));
    const auth = req.headers.authorization ?? "";
    const path = url.pathname;
    const method = req.method;
    state.requests.push({ method, path, body });

    // test control: what Discord does with an interaction response
    if (path === "/__interaction" && method === "POST") {
      const { token, channelId, messageId, create, update, deferred } = body;
      let originalId = messageId ?? null;
      if (create || deferred) originalId = storeMessage(channelId, create ?? { content: "…", flags: 64 }, USERS[IDS.bot]).id;
      if (update && messageId) {
        const msg = state.messages.get(messageId);
        if (msg) Object.assign(msg, update, { edits: msg.edits + 1 });
      }
      state.webhooks.set(token, { channelId, originalId, followups: 0 });
      return send(res, 200, { originalId });
    }
    // test control: someone types in their DM with the bot (optionally without telling the Gateway)
    if (path === "/__dm" && method === "POST") {
      const { from, content, replyTo, quiet } = body;
      const channelId = dmChannelFor(from);
      const payload = { content };
      if (replyTo) payload.message_reference = { message_id: replyTo };
      if (quiet) {
        const session = state.gateway.session;
        state.gateway.session = null; // stored but not dispatched
        const msg = storeMessage(channelId, payload, USERS[from]);
        state.gateway.session = session;
        return send(res, 200, msg);
      }
      return send(res, 200, storeMessage(channelId, payload, USERS[from]));
    }
    if (path === "/__gateway" && method === "POST") {
      if (body.close) for (const conn of state.gateway.sockets) conn.ws.close(body.close, "test");
      if (body.dispatch) gatewayDispatch(body.dispatch.t, body.dispatch.d);
      return send(res, 200, { ok: true });
    }

    if (path === "/__state") {
      if (method === "POST") Object.assign(state, body);
      return send(res, 200, {
        app: state.app,
        messages: [...state.messages.values()],
        events: state.events,
        deletedEvents: state.deletedEvents,
        commands: state.commands,
      });
    }

    // browser-facing OAuth page: approve instantly as `browserUser`
    if (path === "/oauth2/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (url.searchParams.get("prompt") === "none" && !state.authorized.has(state.browserUser)) {
        redirect.searchParams.set("error", "consent_required");
      } else {
        state.authorized.add(state.browserUser);
        redirect.searchParams.set("code", `code-${state.browserUser}`);
      }
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }

    if (!path.startsWith("/api/v10/")) return send(res, 404, { message: "404: Not Found", code: 0 });
    const p = path.slice("/api/v10".length);

    if (p === "/oauth2/token" && method === "POST") {
      const [id, secret] = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":");
      if (id !== IDS.app || secret !== state.clientSecret) return send(res, 401, { error: "invalid_client" });
      if (!state.app.redirect_uris.includes(body.redirect_uri)) {
        return send(res, 400, { error: "invalid_grant", error_description: 'Invalid "redirect_uri" in request.' });
      }
      const uid = String(body.code ?? "").replace(/^code-/, "");
      if (!USERS[uid]) return send(res, 400, { error: "invalid_grant" });
      return send(res, 200, { access_token: `tok-${uid}`, token_type: "Bearer", expires_in: 604800, scope: "identify" });
    }

    // interaction webhooks: authorized by the token in the URL
    let w;
    if ((w = p.match(/^\/webhooks\/(\d+)\/([^/]+)(\/messages\/@original)?$/))) {
      const hook = state.webhooks.get(w[2]);
      if (w[1] !== IDS.app || !hook) return send(res, 404, { code: 10015, message: "Unknown Webhook" });
      if (method === "POST" && !w[3]) {
        if (hook.followups >= 5) return send(res, 400, { code: 40094, message: "This interaction has hit the maximum number of follow up messages" });
        const errors = validateMessage(body);
        if (errors.length) return invalid(res, errors);
        hook.followups++;
        const msg = storeMessage(hook.channelId, body, USERS[IDS.bot]);
        return send(res, 200, { id: msg.id, channel_id: msg.channel_id });
      }
      if (w[3] && (method === "PATCH" || method === "GET")) {
        const msg = state.messages.get(hook.originalId);
        if (!msg) return send(res, 404, { code: 10008, message: "Unknown Message" });
        if (method === "PATCH") {
          const errors = validateMessage({ ...msg, ...body });
          if (errors.length) return invalid(res, errors);
          Object.assign(msg, body, { edits: msg.edits + 1 });
        }
        return send(res, 200, { id: msg.id, channel_id: msg.channel_id });
      }
    }

    // user (Bearer) endpoints
    if (auth.startsWith("Bearer ")) {
      const uid = auth.slice("Bearer tok-".length);
      if (p === "/users/@me" && USERS[uid]) return send(res, 200, USERS[uid]);
      return send(res, 401, { message: "401: Unauthorized", code: 0 });
    }

    if (auth !== `Bot ${state.botToken}`) return send(res, 401, { message: "401: Unauthorized", code: 0 });

    let m;
    if (p === "/users/@me") return send(res, 200, USERS[IDS.bot]);
    if (p === "/users/@me/guilds") return send(res, 200, [{ id: IDS.guild, name: "Friends HQ", icon: null }]);
    if (p === "/applications/@me" && method === "GET") return send(res, 200, state.app);
    if (p === "/applications/@me" && method === "PATCH") {
      if (body.interactions_endpoint_url !== undefined) {
        const ok = await verifyEndpoint(body.interactions_endpoint_url).catch(() => false);
        if (!ok) return invalid(res, ["interactions_endpoint_url could not be verified"]);
        state.app.interactions_endpoint_url = body.interactions_endpoint_url;
      }
      if (body.flags !== undefined) state.app.flags = body.flags;
      if (body.integration_types_config !== undefined) state.app.integration_types_config = body.integration_types_config;
      return send(res, 200, state.app);
    }
    if ((m = p.match(/^\/applications\/(\d+)\/commands$/))) {
      if (method === "PUT") {
        const supported = Object.keys(state.app.integration_types_config ?? {}).map(Number);
        const bad = body.filter((c) => (c.integration_types ?? [0]).some((t) => !supported.includes(t)));
        if (bad.length) return invalid(res, [`integration_types not supported by the app: ${bad.map((c) => c.name)}`]);
        for (const c of body) {
          if (c.description.length > 100) return invalid(res, [`description too long: ${c.name}`]);
          for (const o of c.options ?? []) {
            if (o.description.length > 100 || (o.choices ?? []).length > 25) return invalid(res, [`bad option ${o.name}`]);
            for (const ch of o.choices ?? []) if (ch.name.length > 100 || ch.value.length > 100) return invalid(res, [`bad choice ${ch.name}`]);
          }
        }
        // Like Discord, don't echo back options' required:false.
        state.commands = body.map((c) => ({
          ...c,
          id: nextId(),
          options: c.options?.map(({ required, ...o }) => (required ? { ...o, required } : o)),
        }));
      }
      return send(res, 200, state.commands);
    }
    if ((m = p.match(/^\/guilds\/(\d+)$/))) {
      return m[1] === IDS.guild ? send(res, 200, { id: IDS.guild, name: "Friends HQ" }) : send(res, 404, { code: 10004, message: "Unknown Guild" });
    }
    if ((m = p.match(/^\/guilds\/(\d+)\/members\/search$/))) {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      return send(res, 200, state.members.filter((id) => USERS[id].username.startsWith(q) || USERS[id].global_name?.toLowerCase().startsWith(q)).map(member));
    }
    if ((m = p.match(/^\/guilds\/(\d+)\/members\/(\d+)$/))) {
      return state.members.includes(m[2]) ? send(res, 200, member(m[2])) : send(res, 404, { code: 10007, message: "Unknown Member" });
    }
    if ((m = p.match(/^\/guilds\/(\d+)\/members$/))) {
      if (!(state.app.flags & ((1 << 14) | (1 << 15)))) return send(res, 403, { code: 50001, message: "Missing Access" });
      return send(res, 200, state.members.map(member));
    }
    if ((m = p.match(/^\/guilds\/(\d+)\/channels$/))) {
      return send(res, 200, [
        { id: IDS.general, type: 0, name: "general", position: 0 },
        { id: IDS.voice, type: 2, name: "Lounge", position: 1 },
      ]);
    }
    if ((m = p.match(/^\/guilds\/(\d+)\/scheduled-events$/)) && method === "POST") {
      const errors = [];
      if (!body.name || body.name.length > 100) errors.push("name");
      if ((body.description ?? "").length > 1000) errors.push("description");
      if (body.entity_type !== 3 || !body.entity_metadata?.location || !body.scheduled_end_time) errors.push("external event fields");
      if (Date.parse(body.scheduled_start_time) <= Date.now()) errors.push("start must be in the future");
      if (Date.parse(body.scheduled_end_time) <= Date.parse(body.scheduled_start_time)) errors.push("end before start");
      if (errors.length) return invalid(res, errors);
      const event = { ...body, id: nextId() };
      state.events.push(event);
      return send(res, 200, event);
    }
    if ((m = p.match(/^\/guilds\/(\d+)\/scheduled-events\/(\d+)$/)) && method === "DELETE") {
      state.deletedEvents.push(m[2]);
      return send(res, 204);
    }
    if (p === "/users/@me/channels" && method === "POST") {
      const uid = body.recipient_id;
      if (!USERS[uid]) return send(res, 400, { code: 50035, message: "Invalid Form Body" });
      return send(res, 200, { id: dmChannelFor(uid), type: 1, recipients: [USERS[uid]] });
    }
    if ((m = p.match(/^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/)) && method === "PUT") {
      const msg = state.messages.get(m[2]);
      if (!msg || msg.channel_id !== m[1]) return send(res, 404, { code: 10008, message: "Unknown Message" });
      msg.reactions.push(decodeURIComponent(m[3]));
      return send(res, 204);
    }
    if ((m = p.match(/^\/channels\/(\d+)\/messages$/)) && method === "GET") {
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const list = [...state.messages.values()]
        .filter((x) => x.channel_id === m[1] && BigInt(x.id) > after)
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
        .slice(0, limit);
      return send(res, 200, list);
    }
    if ((m = p.match(/^\/channels\/(\d+)\/messages$/)) && method === "POST") {
      const channelId = m[1];
      const dmUser = dmUserOf(channelId);
      if (dmUser && state.dmClosed.has(dmUser)) return send(res, 403, { code: 50007, message: "Cannot send messages to this user" });
      if (!dmUser && channelId !== IDS.general) return send(res, 404, { code: 10003, message: "Unknown Channel" });
      const errors = validateMessage(body);
      if (errors.length) return invalid(res, errors);
      const msg = storeMessage(channelId, body, USERS[IDS.bot]);
      return send(res, 200, { id: msg.id, channel_id: channelId });
    }
    if ((m = p.match(/^\/channels\/(\d+)\/messages\/(\d+)$/)) && method === "PATCH") {
      const msg = state.messages.get(m[2]);
      if (!msg || msg.channel_id !== m[1]) return send(res, 404, { code: 10008, message: "Unknown Message" });
      const errors = validateMessage({ ...msg, ...body });
      if (errors.length) return invalid(res, errors);
      Object.assign(msg, body, { edits: msg.edits + 1 });
      return send(res, 200, { id: msg.id, channel_id: msg.channel_id });
    }
    return send(res, 404, { code: 0, message: `fake: no route for ${method} ${p}` });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, onGatewaySocket));

  return {
    state,
    server,
    dmChannelFor,
    listen: (port) =>
      new Promise((resolve) => {
        state.port = port;
        server.listen(port, "127.0.0.1", resolve);
      }),
    close: () =>
      new Promise((resolve) => {
        for (const conn of state.gateway.sockets) conn.ws.terminate();
        wss.close();
        server.close(resolve);
      }),
  };
}

// Run standalone for manual testing / screenshots: node test/e2e/fake-discord.mjs <port>
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8790);
  const keys = generateKeys();
  const fake = createFakeDiscord(keys);
  await fake.listen(port);
  console.log(JSON.stringify({ port, publicKeyHex: keys.publicKeyHex }));
}

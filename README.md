# 📨 Bureau of Mandatory Attendance

Official summonses for your friends, delivered on Discord. A response is required.

Write “come play LoL” or “come to Lidl with me” on a website, and it becomes an official-looking summons in your friend's Discord DMs:

- **Four response buttons**: 🫡 Accept Mission · ❌ Decline Assignment · 🤡 Provide Weak Excuse · ⏳ Request Extension. You can rename them or turn some off.
- **Excuses must be written down.** A Discord form asks for the excuse or how much extra time they need, and you **grant or deny** extensions from your own DMs.
- **Silence is punished.** If they don't answer, they get a *Second notice*, then a *Third*, then a *Final notice* (you pick how pushy).
- **You get a DM** the moment anyone answers, a briefing before the event starts, and reminders go to everyone who accepted.
- **Templates** (gaming, groceries, food, gym, movie, coffee, drinks, walk) with a 🎲 re-roll for the wording, plus a **live preview** of what they'll see in Discord.
- Summon several people at once (each gets a DM with a live roster), or post one public summons in a channel that pings everyone.
- Optionally adds the summons to the server's **Events** tab too.
- **`/summon` in your own DM with a friend.** Type `/summon who:@friend what:Gaming` and the summons appears right in that chat. If they don't answer, up to 3 notices follow automatically in the first 15 minutes, and a 🔔 button (issuer only) starts another round.
- **Replies are forwarded.** Whatever your friend types to the bot is passed on to whoever last sent them something through the Bureau (usually whoever summoned them). Reply to a forwarded message and your answer goes back. Messages are never forwarded back to the person who wrote them, and the bot says who your messages go to whenever that changes.
- **Blocks are respected.** If someone blocks the bot (or closes their DMs), notices to them stop and you get one message saying so.
- **Or send it yourself.** Next to *Dispatch summons* there's *Copy to send it yourself*: it copies the summons as formatted Discord text (mentions and times included) to paste into your DM and send from your own account. The bot sends nothing; your friend answers by reacting with an emoji.

It runs for free on Cloudflare Workers. There's no server to keep running.

---

## Setup (about 15 minutes, works from a phone)

You'll need a Discord server that both you and your friend are in, where you can add bots. Creating a new server and inviting your friend works fine.

### 1. Create the Discord app

1. Open the **[Discord Developer Portal](https://discord.com/developers/applications)** → **New Application** → name it e.g. *Bureau of Mandatory Attendance* → Create.
2. **General Information** page: copy the **Application ID** and the **Public Key**.
3. **Bot** page: press **Reset Token** and copy the token.
4. **OAuth2** page: press **Reset Secret** and copy the **Client Secret**.

Keep these four values somewhere safe for a few minutes. Don't paste them into a chat.

### 2. Put the website on Cloudflare (free)

1. Create an account: **[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)**.
2. Go to **[Workers & Pages → Create](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)** → **Import a repository** → connect GitHub → pick **`alexdespina361-sys/Discord`**.
3. Set the project name to exactly **`summons-bureau`**, because it must match `wrangler.jsonc`. Leave the build command empty and keep the deploy command `npx wrangler deploy`. If it asks for a branch, use the one this code is on (`ccr-6da405ed-bjw3sn`, or `main` once merged).
4. Deploy. Your site will be at `https://summons-bureau.<your-subdomain>.workers.dev`.
5. Open the Worker → **Settings → Variables and Secrets** → add these four, each with type **Secret**:

   | Name | Value |
   |---|---|
   | `DISCORD_APPLICATION_ID` | Application ID |
   | `DISCORD_PUBLIC_KEY` | Public Key |
   | `DISCORD_BOT_TOKEN` | Bot token |
   | `DISCORD_CLIENT_SECRET` | Client Secret |

### 3. Finish on your site's setup page

Open `https://summons-bureau.<your-subdomain>.workers.dev/setup`. It checks everything and walks you through the rest:

- **Discord sends button clicks here** → press *Set it for me*.
- **“Log in with Discord” redirect** → copy the URL it shows, then on Discord's OAuth2 page press *Add Redirect*, paste it and **Save**.
- **Server Members Intent** → press *Enable it for me*. This lets you pick friends from a list.
- **Bot added to your server** → press *Add bot to a server* and choose the server you share with your friend. This is the Discord approval step.
- **/summon allowed in personal DMs** → press *Enable it for me*.
- **/summon and /bureau commands** → press *Register them* if it isn't already ticked.
- **Add the Bureau to your own Discord account** → open the link and press *Authorize*. Everyone who wants to use `/summon` in their DMs does this once; people being summoned don't need it.
- **DM forwarding is live** → nothing to do; it turns on by itself.
- **Log in**, then press *Send me a test DM*.

### 4. Summon someone

On the website: press **Issue a summons** and pick a template. Choose your friend, or **yourself first** to see exactly what they'll get. Then press **Dispatch summons**.

In Discord: open your DM with a friend and type `/summon`. Pick *who*, *what* (gaming, groceries, food…), and optionally *when*, your own *title* and a *note*.

---

## Good to know

- **The bot can only DM people it shares a server with**, and only if they allow DMs from that server's members. Otherwise it falls back to the channel you pick under *If someone's DMs are closed, post in*.
- **Nobody can actually be forced to respond.** The Bureau just makes ignoring it socially expensive.
- Each summons gets a dossier page on the website with the roster, every excuse, and a full case file. Recipients can answer there too.
- A summons closes when its event ends, and the buttons are disabled.
- **DM forwarding needs an always-on connection to Discord.** Keeping it open uses roughly 80% of Cloudflare's free daily allowance for always-on objects (Durable Objects). That's fine for one bot. If you ever hit the limit, turn forwarding off on the setup page, or move to Cloudflare's paid Workers plan.
- `/summon` can only post in a personal DM while Discord's 15-minute window for that command is open. Later notices and reminders come from the bot's own DM.

### Optional settings

Add these as variables or secrets on the Worker:

| Name | What it does |
|---|---|
| `ALLOWED_USER_IDS` | Comma-separated Discord user IDs allowed to *issue* summonses. Leave empty to allow anyone in a server with the bot. |
| `BUREAU_NAME` | Rename the Bureau, e.g. `Ministry of Snacks`. |
| `SESSION_SECRET` | Login cookie key. By default it's derived from the bot token. |

To stop strangers from adding your bot to their servers: in the Developer Portal, set **Installation → Install Link** to *None*, then turn off **Bot → Public Bot**.

---

## How it works

```
Website (Cloudflare Worker) ──REST──▶ Discord API ──DM──▶ your friend
      ▲                                                     │ clicks a button / fills a form / uses /summon
      └──────────── POST /interactions (signed) ◀───────────┘
      │
Bureau Durable Object (SQLite): summonses, responses, case log, forwarding routes,
and an alarm-driven scheduler for notices, reminders, closing files and re-syncing messages.

Gateway Durable Object: one live WebSocket to Discord that hears DMs sent to the bot
and hands them to the Bureau to forward. A 1-minute watchdog and a 5-minute cron keep it up.
```

- `src/index.ts`: routes for the website, login, JSON API, `/interactions`, and the cron watchdog.
- `src/interactions.ts`: button clicks, forms (Discord modals), extension verdicts, `/summon`, `/bureau`.
- `src/bureau.ts`: the Bureau Durable Object, holding storage, the scheduler and the DM forwarding rules.
- `src/gateway.ts`: the Gateway Durable Object (connect, heartbeat, resume, catch-up after reconnects).
- `src/messages.ts`: every Discord message and form the bot sends.
- `src/setup.ts`: the self-checking setup page.
- `public/static/`: CSS, the official seal, and the browser scripts (live Discord preview).

Buttons, forms and commands arrive as signed HTTP requests. Only DM forwarding uses the Gateway connection.

## Development

```sh
npm install
npm test            # unit tests: validation, signatures, Discord payload limits
npm run test:e2e    # whole flow in the real Workers runtime against a fake Discord API (REST + Gateway)
npm run typecheck
node scripts/screenshots.mjs   # phone and desktop screenshots of every page (needs Playwright)
```

For `npm run dev`, put the four `DISCORD_*` values in a `.dev.vars` file. That file is ignored by git.

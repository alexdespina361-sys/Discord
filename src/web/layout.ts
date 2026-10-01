import { bureauName, type Env } from "../env";
import { PRIORITY_INFO, type InviteStatus, type Person, type Summons, type SummonsStatus } from "../model";
import type { Session } from "../session";
import { html, raw, type SafeHtml } from "./html";

export interface PageOptions {
  env: Env;
  origin: string;
  session: Session | null;
  title: string;
  active?: "home" | "new" | "setup";
  body: SafeHtml;
  scripts?: string[];
  status?: number;
  headers?: HeadersInit;
}

const ASSET_VERSION = "1";

export function page(o: PageOptions): Response {
  const bureau = bureauName(o.env);
  const nav = (href: string, label: string, key: PageOptions["active"]) =>
    html`<a href="${href}" class="${o.active === key ? "is-active" : ""}">${label}</a>`;

  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${o.title} · ${bureau}</title>
<meta name="description" content="Official summonses for your friends, delivered on Discord. A response is required.">
<meta name="theme-color" content="#1b2a41">
<meta property="og:title" content="${bureau}">
<meta property="og:description" content="Official summonses for your friends, delivered on Discord. A response is required.">
<meta property="og:image" content="${o.origin}/static/seal.png">
<link rel="icon" type="image/png" href="/static/seal.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&display=swap">
<link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}">
</head>
<body>
<header class="topbar">
  <div class="topbar__inner">
    <a class="brand" href="/">
      <img src="/static/seal.svg" alt="" width="36" height="36">
      <span class="brand__text"><small>Official</small><span>${bureau}</span></span>
    </a>
    <nav class="topnav" aria-label="Main">
      ${o.session ? [nav("/", "Dossiers", "home"), nav("/new", "New summons", "new")] : null}
      ${nav("/setup", "Setup", "setup")}
    </nav>
    <div class="topbar__user">
      ${
        o.session
          ? html`<img class="avatar avatar--sm" src="${o.session.avatar ?? "/static/seal.png"}" alt="">
            <span class="topbar__name">${o.session.name}</span>
            <form method="post" action="/auth/logout"><button class="linkish" type="submit">Log out</button></form>`
          : html`<a class="btn btn--discord btn--sm" href="/auth/login">${discordLogo()} Log in</a>`
      }
    </div>
  </div>
</header>
<main class="wrap">
${o.body}
</main>
<footer class="footer">
  <p><strong>${bureau}</strong> · Form BMA-27 · This summons is legally meaningless but socially binding.</p>
</footer>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<script type="module" src="/static/app.js?v=${ASSET_VERSION}"></script>
${(o.scripts ?? []).map((s) => html`<script type="module" src="${s}?v=${ASSET_VERSION}"></script>`)}
</body>
</html>`;

  return new Response(doc.value, {
    status: o.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      ...o.headers,
    },
  });
}

export function discordLogo(): SafeHtml {
  return raw(
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" width="18" height="18"><path fill="currentColor" d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.9a.07.07 0 0 0-.08.04c-.21.38-.45.87-.61 1.25a18.3 18.3 0 0 0-5.47 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.47.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1 0-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08 0l.37.3a.08.08 0 0 1 0 .13c-.6.35-1.22.64-1.87.89a.08.08 0 0 0-.04.1c.36.7.77 1.36 1.23 2a.08.08 0 0 0 .08.02 19.8 19.8 0 0 0 6-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.1 2.16 2.42 0 1.33-.94 2.42-2.16 2.42Z"/></svg>`,
  );
}

// --- small shared components ------------------------------------------------------

export const STATUS_WORDS: Record<InviteStatus, { label: string; emoji: string }> = {
  pending: { label: "Awaiting response", emoji: "📭" },
  yes: { label: "Accepted", emoji: "✅" },
  no: { label: "Declined", emoji: "❌" },
  excuse: { label: "Excuse filed", emoji: "🤡" },
  extend: { label: "Wants more time", emoji: "⏳" },
};

export function statusChip(status: InviteStatus, emoji?: string): SafeHtml {
  const w = STATUS_WORDS[status];
  return html`<span class="chip chip--${status}"><span aria-hidden="true">${emoji || w.emoji}</span> ${w.label}</span>`;
}

export function stamp(status: SummonsStatus, startsAt?: number): SafeHtml {
  const label = status === "active" ? (startsAt && startsAt <= Date.now() ? "In progress" : "Active") : status === "cancelled" ? "Cancelled" : "Closed";
  return html`<span class="stamp stamp--${status}">${label}</span>`;
}

export function priorityBadge(s: Pick<Summons, "priority">): SafeHtml {
  const p = PRIORITY_INFO[s.priority];
  return html`<span class="priority priority--${s.priority}">${p.emoji} ${p.label}</span>`;
}

/** Rendered as UTC on the server, then localized by app.js. */
export function time(ms: number, style: "full" | "short" | "relative" | "time" = "full"): SafeHtml {
  const iso = new Date(ms).toISOString();
  return html`<time datetime="${iso}" data-ts="${ms}" data-style="${style}">${iso.slice(0, 16).replace("T", " ")} UTC</time>`;
}

export function avatar(p: Pick<Person, "avatar">, size: "sm" | "md" = "md"): SafeHtml {
  return html`<img class="avatar avatar--${size}" src="${p.avatar ?? "/static/seal.png"}" alt="" loading="lazy">`;
}

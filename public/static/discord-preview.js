// Renders a Discord message payload (content + embeds + buttons) as a Discord look-alike.
// All user text goes through text nodes; nothing is injected as HTML.
import { el, relativeTime } from "./lib.js";

const TS_FORMATS = {
  t: { hour: "numeric", minute: "2-digit" },
  T: { hour: "numeric", minute: "2-digit", second: "2-digit" },
  d: { year: "numeric", month: "2-digit", day: "2-digit" },
  D: { year: "numeric", month: "long", day: "numeric" },
  f: { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" },
  F: { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" },
};

function formatTs(seconds, style = "f") {
  const ms = seconds * 1000;
  if (style === "R") return relativeTime(ms);
  return new Date(ms).toLocaleString(undefined, TS_FORMATS[style] ?? TS_FORMATS.f);
}

function clock(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `Today at ${time}` : `${d.toLocaleDateString()} ${time}`;
}

const INLINE =
  /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|~~([\s\S]+?)~~|`([^`\n]+)`|<t:(-?\d+)(?::([tTdDfFR]))?>|<@!?(\d+)>|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;

function inline(text, ctx) {
  const re = new RegExp(INLINE.source, "g");
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(el("strong", {}, inline(m[1], ctx)));
    else if (m[2] !== undefined) out.push(el("u", {}, inline(m[2], ctx)));
    else if (m[3] !== undefined) out.push(el("em", {}, inline(m[3], ctx)));
    else if (m[4] !== undefined) out.push(el("s", {}, inline(m[4], ctx)));
    else if (m[5] !== undefined) out.push(el("code", { class: "dc-code" }, m[5]));
    else if (m[6] !== undefined) out.push(el("span", { class: "dc-ts" }, formatTs(Number(m[6]), m[7] || "f")));
    else if (m[8] !== undefined) out.push(el("span", { class: "dc-mention" }, `@${ctx.names?.[m[8]] || "Recipient"}`));
    else if (m[9] !== undefined) out.push(el("a", { class: "dc-link", href: m[10], target: "_blank", rel: "noopener" }, m[9]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function markdown(text, ctx) {
  const frag = document.createDocumentFragment();
  const lines = String(text).split("\n");
  let quote = null;
  lines.forEach((line, i) => {
    if (line === ">" || line.startsWith("> ")) {
      if (!quote) {
        quote = el("div", { class: "dc-quote" });
        frag.append(quote);
      } else {
        quote.append(el("br"));
      }
      quote.append(...inline(line.replace(/^> ?/, ""), ctx));
      return;
    }
    quote = null;
    if (line.startsWith("-# ")) {
      frag.append(el("div", { class: "dc-sub" }, inline(line.slice(3), ctx)));
      return;
    }
    frag.append(...inline(line, ctx));
    const next = lines[i + 1];
    if (next !== undefined && !(next === ">" || next.startsWith("> "))) frag.append(el("br"));
  });
  return frag;
}

function hex(color) {
  return `#${(color ?? 0x5865f2).toString(16).padStart(6, "0")}`;
}

function renderEmbed(e, ctx) {
  const body = el("div", { class: "dc-embed__body" });
  if (e.author) {
    body.append(el("div", { class: "dc-author" }, e.author.icon_url ? el("img", { src: e.author.icon_url, alt: "" }) : null, e.author.name));
  }
  if (e.title) {
    body.append(el("div", { class: "dc-title", style: e.url ? null : "color:#f2f3f5" }, inline(e.title, ctx)));
  }
  if (e.description) body.append(el("div", { class: "dc-desc" }, markdown(e.description, ctx)));
  if (e.fields?.length) {
    body.append(
      el(
        "div",
        { class: "dc-fields" },
        e.fields.map((f) =>
          el(
            "div",
            { class: `dc-field${f.inline ? "" : " dc-field--wide"}` },
            el("div", { class: "dc-field__name" }, inline(f.name, ctx)),
            el("div", {}, markdown(f.value, ctx)),
          ),
        ),
      ),
    );
  }
  if (e.footer || e.timestamp) {
    const parts = [e.footer?.text, e.timestamp ? clock(Date.parse(e.timestamp)) : null].filter(Boolean);
    body.append(el("div", { class: "dc-footer" }, parts.join(" • ")));
  }
  return el(
    "div",
    { class: "dc-embed", style: `border-left-color:${hex(e.color)}` },
    body,
    e.thumbnail ? el("img", { class: "dc-thumb", src: e.thumbnail.url, alt: "" }) : null,
  );
}

function renderRow(row) {
  return el(
    "div",
    { class: "dc-buttons" },
    row.components.map((b) =>
      el(
        "span",
        { class: `dc-btn dc-btn--${b.style}`, "aria-disabled": b.disabled ? "true" : null, style: b.disabled ? "opacity:.5" : null },
        b.emoji?.name ? el("span", { "aria-hidden": "true" }, b.emoji.name) : null,
        b.label,
        b.style === 5 ? " ↗" : null,
      ),
    ),
  );
}

export function renderMessage(payload, ctx = {}) {
  return el(
    "div",
    { class: "dc-msg" },
    el("img", { class: "dc-avatar", src: ctx.botAvatar || "/static/seal.png", alt: "" }),
    el(
      "div",
      { class: "dc-main" },
      el(
        "div",
        { class: "dc-head" },
        el("span", { class: "dc-name" }, ctx.botName || "Bureau"),
        el("span", { class: "dc-app" }, "APP"),
        el("span", { class: "dc-time" }, clock(Date.now())),
      ),
      payload.content ? el("div", { class: "dc-content" }, markdown(payload.content, ctx)) : null,
      (payload.embeds ?? []).map((e) => renderEmbed(e, ctx)),
      (payload.components ?? []).map(renderRow),
    ),
  );
}

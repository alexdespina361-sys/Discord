// Shared helpers for the Bureau's pages.

let toastTimer;

export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast${kind === "error" ? " toast--error" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === "error" ? 6000 : 3500);
}

export async function postJson(url, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.field = data.field;
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Copies to the clipboard, or shows the text in a box to copy by hand when the browser won't allow it. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    showCopyDialog(text);
    return false;
  }
}

export function showCopyDialog(text) {
  const area = el("textarea", { readonly: true, rows: 12, "aria-label": "Text to copy" }, text);
  const overlay = el(
    "div",
    { class: "copy-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Copy the text" },
    el(
      "div",
      { class: "card copy-dialog__card" },
      el("h2", {}, "Copy this, then paste it in Discord"),
      area,
      el("div", { class: "copy-dialog__actions" }, el("button", { type: "button", class: "btn btn--primary", onclick: () => overlay.remove() }, "Done")),
    ),
  );
  document.body.append(overlay);
  area.focus();
  area.select();
}

export function readData(id) {
  const node = document.getElementById(id);
  return node ? JSON.parse(node.textContent) : null;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relativeTime(ms, now = Date.now()) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  // Round up a unit early, the way people talk: 50 minutes is "in 1 hour".
  if (abs < 45e3) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 45 * 6e4) return rtf.format(Math.round(diff / 6e4), "minute");
  if (abs < 22 * 36e5) return rtf.format(Math.round(diff / 36e5), "hour");
  if (abs < 26 * 864e5) return rtf.format(Math.round(diff / 864e5), "day");
  if (abs < 320 * 864e5) return rtf.format(Math.round(diff / (30 * 864e5)), "month");
  return rtf.format(Math.round(diff / (365 * 864e5)), "year");
}

export function formatTime(ms, style) {
  const d = new Date(ms);
  switch (style) {
    case "relative":
      return relativeTime(ms);
    case "time":
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    case "short":
      return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    default:
      return d.toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
}

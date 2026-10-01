import { formatTime, postJson, toast } from "./lib.js";

// Avatars come from Discord's CDN; if one fails, show the Bureau seal instead of a broken image.
function avatarFallback(img) {
  if (img instanceof HTMLImageElement && img.matches(".avatar, .dc-avatar") && !img.dataset.fallback) {
    img.dataset.fallback = "1";
    img.src = "/static/seal.png";
  }
}
document.addEventListener("error", (e) => avatarFallback(e.target), true);
for (const img of document.querySelectorAll("img.avatar")) if (img.complete && !img.naturalWidth) avatarFallback(img);

// Server renders times in UTC; show them in the reader's own timezone.
function localizeTimes() {
  for (const node of document.querySelectorAll("time[data-ts]")) {
    node.textContent = formatTime(Number(node.dataset.ts), node.dataset.style);
    node.title = new Date(Number(node.dataset.ts)).toLocaleString();
  }
}
localizeTimes();
setInterval(localizeTimes, 30_000);

document.addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      toast("Copied to clipboard");
    } catch {
      copy.previousElementSibling?.select?.();
      toast("Press and hold to copy");
    }
    return;
  }

  const setup = event.target.closest("[data-setup]");
  if (setup) {
    setup.disabled = true;
    try {
      const result = await postJson(`/setup/${setup.dataset.setup}`);
      toast(result.message, result.ok ? "info" : "error");
      if (result.ok) setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setup.disabled = false;
    }
    return;
  }

  const action = event.target.closest("[data-action]");
  if (action) {
    if (action.dataset.confirm && !confirm(action.dataset.confirm)) return;
    action.disabled = true;
    try {
      const result = await postJson(action.dataset.action);
      toast(result.message);
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast(e.message, "error");
      action.disabled = false;
    }
  }
});

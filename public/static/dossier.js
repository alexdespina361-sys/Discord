import { postJson, readData, toast } from "./lib.js";

const data = readData("dossier-data");

if (new URLSearchParams(location.search).has("sent")) {
  toast("📨 Summons dispatched. The Bureau will take it from here.");
  history.replaceState(null, "", location.pathname);
}

const panel = document.getElementById("respond");
if (panel && data) {
  const noteBox = panel.querySelector(".respond__note");
  const note = document.getElementById("note");
  const label = document.getElementById("note-label");
  let pendingKind = null;

  async function submit(kind, text) {
    try {
      const result = await postJson(`/api/summons/${data.id}/respond`, { kind, note: text });
      toast(result.message);
      setTimeout(() => location.reload(), 1000);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  panel.addEventListener("click", (e) => {
    const button = e.target.closest("[data-respond]");
    if (!button) return;
    const kind = button.dataset.respond;
    if (button.dataset.needsNote) {
      pendingKind = kind;
      label.textContent = kind === "excuse" ? "State your excuse for the record" : "How much extra time do you need?";
      note.placeholder = kind === "excuse" ? "e.g. my cat scheduled a meeting with me" : "e.g. 30 minutes, still in the shower";
      noteBox.hidden = false;
      note.focus();
      return;
    }
    submit(kind, null);
  });

  document.getElementById("note-submit").addEventListener("click", () => {
    if (!note.value.trim()) {
      toast("The Committee does not accept blank forms.", "error");
      return;
    }
    submit(pendingKind, note.value);
  });
}

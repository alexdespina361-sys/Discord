import { renderMessage } from "./discord-preview.js";
import { el, getJson, postJson, readData, toast } from "./lib.js";

const data = readData("compose-data");
const form = document.getElementById("compose");
const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ["classification", "title", "objective", "location", "dressCode", "signatureTitle"];
const KIND_NAMES = { yes: "accept", no: "decline", excuse: "excuse", extend: "extension" };

const prefill = data.prefill;
const state = {
  guildId: prefill && data.guilds.some((g) => g.id === prefill.guildId) ? prefill.guildId : data.guilds[0].id,
  picked: new Map(),
  members: [],
  results: [],
  mode: "list",
  template: null,
  variants: {},
};

// --- small helpers -------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocal(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function radioValue(name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
}

function setRadio(name, value) {
  const input = form.querySelector(`input[name="${name}"][value="${CSS.escape(String(value))}"]`);
  if (input) input.checked = true;
}

function setDuration(min) {
  const select = $("durationMin");
  if (![...select.options].some((o) => Number(o.value) === min)) {
    select.append(el("option", { value: min }, `${min} minutes`));
  }
  select.value = String(min);
}

// --- when ----------------------------------------------------------------------------

function quickTime(label, compute) {
  return el("button", {
    type: "button",
    class: "btn btn--ghost btn--sm",
    onclick: () => {
      $("startsAt").value = toLocalInput(compute());
      clearError("startsAt");
      schedulePreview();
    },
  }, label);
}

function at(dayOffset, hour) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function roundedFromNow(minutes) {
  const d = new Date(Date.now() + minutes * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return d.getTime();
}

$("startsAt").closest(".field").append(
  el(
    "div",
    { class: "quick-times" },
    quickTime("Right now", () => Date.now() + 60_000),
    quickTime("In 1 hour", () => roundedFromNow(60)),
    quickTime("Tonight 21:00", () => (new Date().getHours() >= 21 ? at(1, 21) : at(0, 21))),
    quickTime("Tomorrow 18:00", () => at(1, 18)),
  ),
);

// --- templates -----------------------------------------------------------------------

const templateBox = $("templates");
for (const t of data.templates) {
  templateBox.append(
    el("button", { type: "button", class: "tpl", "data-tpl": t.id, "aria-pressed": "false", onclick: () => applyTemplate(t) }, `${t.emoji} ${t.name}`),
  );
}

function applyTemplate(t, reroll = false) {
  state.template = t;
  for (const b of templateBox.querySelectorAll(".tpl")) b.setAttribute("aria-pressed", String(b.dataset.tpl === t.id));
  for (const f of TEXT_FIELDS) {
    const variants = t[f];
    let index = 0;
    if (reroll && variants.length > 1) {
      const previous = state.variants[f] ?? 0;
      index = (previous + 1 + Math.floor(Math.random() * (variants.length - 1))) % variants.length;
    }
    state.variants[f] = index;
    $(f).value = variants[index] ?? "";
  }
  fitTextarea();
  if (!reroll) {
    setDuration(t.durationMin);
    setRadio("priority", t.priority);
  }
  clearErrors();
  schedulePreview();
}

$("reroll").addEventListener("click", () => {
  if (state.template) applyTemplate(state.template, true);
});

// --- recipients ------------------------------------------------------------------------

function memberRow(m) {
  const selected = state.picked.has(m.id);
  const isMe = m.id === data.me.id;
  return el(
    "button",
    { type: "button", class: "member", role: "option", "aria-selected": String(selected), onclick: () => toggle(m) },
    el("img", { class: "avatar avatar--md", src: m.avatar, alt: "", loading: "lazy" }),
    el(
      "span",
      {},
      el("span", { class: "member__name" }, m.name, isMe ? " (you)" : ""),
      el("br"),
      el("span", { class: "member__user" }, m.username ? `@${m.username}` : ""),
    ),
    el("span", { class: "member__tick", "aria-hidden": "true" }, selected ? "✓" : ""),
  );
}

function renderMembers() {
  const list = $("members");
  const q = $("member-search").value.trim().toLowerCase();
  let items;
  if (state.mode === "search") {
    if (!q) {
      list.replaceChildren(
        el("p", { class: "muted" }, "Type a name to search the server. (Enable the Server Members Intent on the Setup page to pick from a full list.)"),
      );
      return;
    }
    items = state.results;
  } else {
    items = state.members.filter((m) => !q || m.name.toLowerCase().includes(q) || m.username.toLowerCase().includes(q));
  }
  list.replaceChildren(...(items.length ? items.map(memberRow) : [el("p", { class: "muted" }, "Nobody by that name.")]));
}

function renderPicked() {
  const box = $("picked");
  const chips = [...state.picked.values()].map((m) =>
    el(
      "span",
      { class: "picked" },
      el("img", { class: "avatar avatar--sm", src: m.avatar || "/static/seal.png", alt: "" }),
      m.name,
      el("button", { type: "button", "aria-label": `Remove ${m.name}`, onclick: () => toggle(m) }, "×"),
    ),
  );
  box.replaceChildren(...(chips.length ? chips : [el("span", { class: "muted small" }, "Nobody selected yet. Pick at least one person.")]));
}

function toggle(m) {
  if (state.picked.has(m.id)) {
    state.picked.delete(m.id);
  } else {
    if (state.picked.size >= data.maxRecipients) {
      toast(`At most ${data.maxRecipients} people per summons.`, "error");
      return;
    }
    state.picked.set(m.id, m);
  }
  clearError("recipients");
  renderPicked();
  renderMembers();
  schedulePreview();
}

let searchTimer;
$("member-search").addEventListener("input", () => {
  if (state.mode !== "search") return renderMembers();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $("member-search").value.trim();
    if (!q) return renderMembers();
    try {
      const { members } = await getJson(`/api/guilds/${state.guildId}/search?q=${encodeURIComponent(q)}`);
      state.results = members;
    } catch (e) {
      state.results = [];
      toast(e.message, "error");
    }
    renderMembers();
  }, 300);
});

function fillChannels(channels) {
  const select = $("channelId");
  const wanted = select.value || prefill?.channelId || "";
  select.replaceChildren(el("option", { value: "" }, "Don't post anywhere"), ...channels.map((c) => el("option", { value: c.id }, `#${c.name}`)));
  if (channels.some((c) => c.id === wanted)) select.value = wanted;
  updateDeliveryUi();
}

async function loadDirectory() {
  $("members").replaceChildren(el("p", { class: "muted" }, "Loading members…"));
  try {
    const dir = await getJson(`/api/guilds/${state.guildId}/directory`);
    state.mode = dir.mode;
    state.members = dir.members;
    $("member-search").placeholder = dir.mode === "search" ? "Search people by name…" : "Filter people…";
    fillChannels(dir.channels);
    renderMembers();
  } catch (e) {
    $("members").replaceChildren(el("p", { class: "muted" }, `Couldn't load members: ${e.message}`));
  }
}

$("guildId").addEventListener("change", (e) => {
  state.guildId = e.target.value;
  state.picked.clear();
  renderPicked();
  loadDirectory();
  schedulePreview();
});

// --- delivery ------------------------------------------------------------------------------

function updateDeliveryUi() {
  const channelMode = radioValue("delivery") === "channel";
  const select = $("channelId");
  form.querySelector('label[for="channelId"]').textContent = channelMode ? "Post in channel" : "If someone's DMs are closed, post in";
  if (select.options[0]) {
    select.options[0].textContent = channelMode ? "Pick a channel…" : "Don't post anywhere";
    select.options[0].disabled = channelMode;
  }
  if (channelMode && !select.value && select.options.length > 1) select.value = select.options[1].value;
}

// --- response buttons -------------------------------------------------------------------------

const optionBox = $("options");
const startingOptions = prefill?.options ?? data.defaultOptions;
for (const def of data.defaultOptions) {
  const existing = startingOptions.find((o) => o.kind === def.kind);
  const o = existing ?? def;
  optionBox.append(
    el(
      "div",
      { class: "opt-row", "data-kind": def.kind },
      el("input", {
        type: "checkbox",
        checked: Boolean(existing),
        disabled: def.kind === "yes",
        "aria-label": `Show the ${KIND_NAMES[def.kind]} button`,
      }),
      el(
        "select",
        { "aria-label": `Emoji for the ${KIND_NAMES[def.kind]} button` },
        el("option", { value: "" }, "—"),
        data.emoji.map((e) => el("option", { value: e, selected: e === o.emoji }, e)),
      ),
      el("input", { type: "text", value: o.label, maxlength: 40, "aria-label": `Label for the ${KIND_NAMES[def.kind]} button` }),
    ),
  );
}

function collectOptions() {
  return [...optionBox.querySelectorAll(".opt-row")]
    .filter((row) => row.querySelector('input[type="checkbox"]').checked)
    .map((row) => {
      const kind = row.dataset.kind;
      const fallback = data.defaultOptions.find((o) => o.kind === kind).label;
      return {
        kind,
        emoji: row.querySelector("select").value,
        label: row.querySelector('input[type="text"]').value.trim() || fallback,
      };
    });
}

// --- draft, preview, submit ------------------------------------------------------------------

function collect() {
  return {
    guildId: state.guildId,
    recipients: [...state.picked.keys()],
    classification: $("classification").value,
    title: $("title").value,
    objective: $("objective").value,
    location: $("location").value,
    startsAt: parseLocal($("startsAt").value),
    durationMin: Number($("durationMin").value),
    priority: radioValue("priority") ?? "routine",
    dressCode: $("dressCode").value,
    signatureTitle: $("signatureTitle").value,
    respondBy: parseLocal($("respondBy").value),
    options: collectOptions(),
    delivery: radioValue("delivery") ?? "dm",
    channelId: $("channelId").value || null,
    escalation: radioValue("escalation") ?? "standard",
    remindBeforeMin: Number($("remindBeforeMin").value),
    createScheduledEvent: $("createScheduledEvent").checked,
  };
}

let previewTimer;
let previewSeq = 0;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 200);
}

async function updatePreview() {
  const seq = ++previewSeq;
  try {
    const { message } = await postJson("/api/preview", collect());
    if (seq !== previewSeq) return;
    const names = { [data.me.id]: data.me.name, 0: "Recipient" };
    for (const m of state.picked.values()) names[m.id] = m.name;
    $("preview").replaceChildren(renderMessage(message, { names }));
  } catch {
    // keep the last good preview
  }
}

function fitTextarea() {
  const box = $("objective");
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + 2}px`;
}

form.addEventListener("input", (e) => {
  if (e.target.id === "objective") fitTextarea();
  schedulePreview();
});
form.addEventListener("change", (e) => {
  if (e.target.name === "delivery") updateDeliveryUi();
  schedulePreview();
});

const FIELD_INPUT = { recipients: "member-search", guildId: "guildId", options: "options" };

function clearError(field) {
  const input = $(FIELD_INPUT[field] ?? field);
  input?.classList.remove("is-invalid");
  if (field === "recipients") form.querySelector('[data-error-for="recipients"]').hidden = true;
}

function clearErrors() {
  for (const node of form.querySelectorAll(".is-invalid")) node.classList.remove("is-invalid");
  form.querySelector('[data-error-for="recipients"]').hidden = true;
  $("form-error").hidden = true;
}

function showError(field, message) {
  const formError = $("form-error");
  formError.textContent = message;
  formError.hidden = false;
  if (field === "recipients") {
    const p = form.querySelector('[data-error-for="recipients"]');
    p.textContent = message;
    p.hidden = false;
  }
  if (field === "options") form.querySelector("details.panel").open = true;
  const input = field && $(FIELD_INPUT[field] ?? field);
  if (input) {
    input.classList.add("is-invalid");
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus?.({ preventScroll: true });
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors();
  const draft = collect();
  if (!draft.recipients.length) return showError("recipients", "Pick at least one person to summon.");
  if (!draft.title.trim()) return showError("title", "Give the summons a title.");
  if (!draft.startsAt) return showError("startsAt", "When is it happening?");
  if (draft.delivery === "channel" && !draft.channelId) return showError("channelId", "Pick a channel to post in.");

  const button = $("dispatch");
  button.disabled = true;
  button.textContent = "📨 Dispatching…";
  try {
    const result = await postJson("/api/summons", draft);
    location.href = `/s/${result.id}?sent=1`;
  } catch (err) {
    showError(err.field, err.message);
    button.disabled = false;
    button.textContent = "📨 Dispatch summons";
  }
});

for (const id of ["title", "startsAt", "classification"]) $(id).addEventListener("input", () => clearError(id));

// --- initial state ------------------------------------------------------------------------------

$("guildId").value = state.guildId;
$("startsAt").value = toLocalInput(roundedFromNow(60));
if (prefill) {
  for (const f of TEXT_FIELDS) $(f).value = prefill[f] ?? "";
  setDuration(prefill.durationMin);
  setRadio("priority", prefill.priority);
  setRadio("delivery", prefill.delivery);
  setRadio("escalation", prefill.escalation);
  $("remindBeforeMin").value = String(prefill.remindBeforeMin);
  for (const p of prefill.recipients) state.picked.set(p.id, { ...p, username: "" });
  toast("Duplicated. Pick a new time and dispatch.");
} else {
  applyTemplate(data.templates[0]);
  setRadio("escalation", "standard");
  $("remindBeforeMin").value = "15";
}
renderPicked();
loadDirectory();
fitTextarea();
schedulePreview();

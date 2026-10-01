import { describe, expect, it } from "vitest";
import { validateMessage } from "../e2e/fake-discord.mjs";
import { WHAT_CHOICES, WHEN_CHOICES, quickDraft } from "../../src/quick";
import { commandDefinitions } from "../../src/setup";
import { renderInChatCancel, renderInChatResponse, renderInChatVerdict, renderNudge, renderSummons } from "../../src/messages";
import { DEFAULT_OPTIONS, type Invite, type InviteStatus, type Summons } from "../../src/model";
import { TEMPLATES } from "../../src/templates";

const NOW = Date.UTC(2026, 9, 1, 18, 0);

describe("quickDraft", () => {
  it("fills a whole summons from a template", () => {
    const d = quickDraft({ what: "gaming", minutes: 0, guildId: "", recipients: ["140000000000000011"] }, NOW, () => 0);
    const gaming = TEMPLATES.find((t) => t.id === "gaming")!;
    expect(d.title).toBe(gaming.title[0]);
    expect(d.classification).toBe(gaming.classification[0]);
    expect(d.startsAt).toBe(NOW);
    expect(d.durationMin).toBe(gaming.durationMin);
    expect(d.options).toEqual(DEFAULT_OPTIONS);
    expect(d.remindBeforeMin).toBe(0);
  });

  it("uses the person's own title and note, and a later start time", () => {
    const d = quickDraft(
      { what: "food", minutes: 60, title: "  Operation Pizza ", note: "bring cash", guildId: "", recipients: ["1"] },
      NOW,
      () => 0.99,
    );
    expect(d.title).toBe("Operation Pizza");
    expect(d.objective.endsWith("\n\nbring cash")).toBe(true);
    expect(d.startsAt).toBe(NOW + 3_600_000);
    expect(d.remindBeforeMin).toBe(15);
  });

  it("falls back safely on unknown choices", () => {
    const d = quickDraft({ what: "nope", minutes: 999, guildId: "", recipients: ["1"] }, NOW);
    expect(d.title).toBe("Unspecified Operation");
    expect(d.startsAt).toBe(NOW);
  });
});

describe("command definitions", () => {
  it("stay within Discord's limits", () => {
    for (const userInstall of [false, true]) {
      for (const c of commandDefinitions(userInstall)) {
        expect(c.description.length).toBeLessThanOrEqual(100);
        for (const o of c.options ?? []) {
          expect(o.description.length).toBeLessThanOrEqual(100);
          expect((o.choices ?? []).length).toBeLessThanOrEqual(25);
          for (const ch of o.choices ?? []) expect(ch.name.length).toBeLessThanOrEqual(100);
        }
      }
    }
    expect(WHAT_CHOICES.length).toBeLessThanOrEqual(25);
    expect(WHEN_CHOICES[0]!.value).toBe("0");
  });

  it("only reach personal DMs once user installs are enabled", () => {
    expect(commandDefinitions(false)[1]).toMatchObject({ name: "summon", integration_types: [0], contexts: [0, 1] });
    expect(commandDefinitions(true)[1]).toMatchObject({ name: "summon", integration_types: [0, 1], contexts: [0, 1, 2] });
  });
});

function chatSummons(over: Partial<Summons> = {}): Summons {
  return {
    id: "chat1",
    ref: "BMA-2026-0009",
    organizer: { id: "140000000000000010", name: "Mihai", avatar: null },
    guildId: "",
    guildName: "",
    classification: "COMBAT READINESS ORDER",
    title: "Operation Elo Recovery",
    objective: "Queue up.",
    location: "The Rift",
    startsAt: NOW,
    durationMin: 180,
    priority: "high",
    dressCode: "",
    signatureTitle: "Shotcaller-in-Chief",
    respondBy: null,
    options: DEFAULT_OPTIONS,
    delivery: "interaction",
    channelId: "150000000000000099",
    escalation: "standard",
    remindBeforeMin: 0,
    reminderSent: true,
    scheduledEventId: null,
    status: "active",
    origin: "https://bureau.example.workers.dev",
    createdAt: NOW,
    endedAt: null,
    ...over,
  };
}

function chatInvite(status: InviteStatus, verdict: Invite["verdict"] = null): Invite {
  return {
    id: "inv1",
    summonsId: "chat1",
    recipient: { id: "140000000000000011", name: "Andrei", avatar: null },
    deliveredVia: "interaction",
    channelId: "150000000000000099",
    messageId: null,
    status,
    note: status === "extend" ? "20 more minutes" : null,
    respondedAt: status === "pending" ? null : NOW,
    nudgesSent: 0,
    nextNudgeAt: null,
    verdict,
    error: null,
  };
}

describe("summonses posted by /summon", () => {
  it("carry the 🔔 while unanswered, and grant/deny buttons for extension requests", () => {
    const pending = renderSummons(chatSummons(), [chatInvite("pending")], [chatInvite("pending")], "B", NOW);
    expect(pending.components?.map((r) => r.components.map((b) => b.custom_id))).toEqual([
      ["r:chat1:yes", "r:chat1:no", "r:chat1:excuse", "r:chat1:extend"],
      ["n:chat1"],
    ]);
    const extend = renderSummons(chatSummons(), [chatInvite("extend")], [chatInvite("extend")], "B", NOW);
    expect(extend.components?.[1]?.components.map((b) => b.custom_id)).toEqual(["xs:inv1:granted", "xs:inv1:denied"]);
    const decided = renderSummons(chatSummons(), [chatInvite("extend", "granted")], [chatInvite("extend", "granted")], "B", NOW);
    expect(decided.components).toHaveLength(1);
    const closed = renderSummons(chatSummons({ status: "closed" }), [chatInvite("pending")], [chatInvite("pending")], "B", NOW);
    expect(closed.components).toHaveLength(1);
    for (const m of [pending, extend, decided, closed]) expect(validateMessage(m)).toEqual([]);
  });

  it("only mention the relay on summonses delivered by the bot's DM", () => {
    const dmInvite = { ...chatInvite("pending"), deliveredVia: "dm" as const };
    const dm = renderSummons(chatSummons({ delivery: "dm" }), [dmInvite], [dmInvite], "B", NOW, { relay: true });
    expect(dm.content).toContain("Reply to this message and the Bureau will pass it on to Mihai");
    const chat = renderSummons(chatSummons(), [chatInvite("pending")], [chatInvite("pending")], "B", NOW, { relay: true });
    expect(chat.content).not.toContain("Reply to this message");
  });

  it("post in-chat notices that ping the right person", () => {
    const s = chatSummons();
    const answered = renderInChatResponse(s, { ...chatInvite("excuse"), note: "my cat" });
    expect(answered.content).toContain("<@140000000000000010>");
    expect(answered.allowed_mentions).toEqual({ parse: [], users: ["140000000000000010"] });
    expect(renderInChatVerdict(s, chatInvite("extend", "denied")).content).toContain("**DENIED**");
    expect(renderInChatCancel(s, chatInvite("pending")).allowed_mentions?.users).toEqual(["140000000000000011"]);
    expect(renderNudge(s, chatInvite("pending"), 0, false, true).components).toEqual([]);
  });
});

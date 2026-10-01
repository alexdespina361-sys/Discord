import { describe, expect, it } from "vitest";
import { validateMessage, validateModal } from "../e2e/fake-discord.mjs";
import {
  renderBriefing,
  renderCancelNotice,
  renderModal,
  renderNudge,
  renderReminder,
  renderResponseNotice,
  renderSummons,
  renderVerdictNotice,
  withoutButtonEmoji,
} from "../../src/messages";
import { DEFAULT_OPTIONS, type Invite, type InviteStatus, type Summons } from "../../src/model";
import { findInputValue } from "../../src/interactions";

const NOW = Date.UTC(2026, 9, 1, 12, 0);

function summons(over: Partial<Summons> = {}): Summons {
  return {
    id: "abc123",
    ref: "BMA-2026-0001",
    organizer: { id: "140000000000000010", name: "Mihai", avatar: null },
    guildId: "140000000000000003",
    guildName: "Friends HQ",
    classification: "MANDATORY LOGISTICS OPERATION",
    title: "Procurement Run — LIDL",
    objective: "Procurement of Pepsi, chips and questionable bakery items.",
    location: "Lidl",
    startsAt: NOW + 3_600_000,
    durationMin: 45,
    priority: "high",
    dressCode: "Civilian attire",
    signatureTitle: "Chief Logistics Officer",
    respondBy: null,
    options: DEFAULT_OPTIONS,
    delivery: "dm",
    channelId: null,
    escalation: "standard",
    remindBeforeMin: 15,
    reminderSent: false,
    scheduledEventId: null,
    status: "active",
    origin: "https://bureau.example.workers.dev",
    createdAt: NOW,
    endedAt: null,
    ...over,
  };
}

function invite(n: number, status: InviteStatus = "pending", note: string | null = null): Invite {
  return {
    id: `inv${n}`,
    summonsId: "abc123",
    recipient: { id: `1400000000000001${String(n).padStart(2, "0")}`, name: `Friend ${n}`, avatar: null },
    deliveredVia: "dm",
    channelId: "150000000000000001",
    messageId: `15000000000000010${n}`,
    status,
    note,
    respondedAt: status === "pending" ? null : NOW,
    nudgesSent: 0,
    nextNudgeAt: null,
    verdict: null,
    error: null,
  };
}

describe("renderSummons", () => {
  it("addresses one person personally in a DM", () => {
    const i = invite(1);
    const msg = renderSummons(summons(), [i], [i], "Bureau of Mandatory Attendance", NOW);
    expect(validateMessage(msg)).toEqual([]);
    expect(msg.content).toContain(`<@${i.recipient.id}>`);
    expect(JSON.stringify(msg)).toContain("AWAITING YOUR RESPONSE");
    expect(msg.allowed_mentions).toEqual({ parse: [], users: [i.recipient.id] });
    expect(msg.components?.[0]?.components.map((b) => b.custom_id)).toEqual(["r:abc123:yes", "r:abc123:no", "r:abc123:excuse", "r:abc123:extend"]);
  });

  it("stays within every Discord limit at maximum input sizes", () => {
    const long = (n: number) => "W".repeat(n);
    const s = summons({
      classification: long(80),
      title: long(100),
      objective: `${long(500)}\n${long(499)}`,
      location: long(100),
      dressCode: long(80),
      signatureTitle: long(60),
      respondBy: NOW + 1_800_000,
      options: DEFAULT_OPTIONS.map((o) => ({ ...o, label: long(40) })),
    });
    const statuses: InviteStatus[] = ["pending", "yes", "no", "excuse", "extend"];
    const invites = Array.from({ length: 10 }, (_, n) => invite(n, statuses[n % 5]!, n % 5 >= 3 ? long(300) : null));
    for (const status of ["active", "closed", "cancelled"] as const) {
      const all = renderSummons({ ...s, status }, invites, invites, long(60), NOW);
      expect(validateMessage(all), `group ${status}`).toEqual([]);
      for (const one of invites) {
        expect(validateMessage(renderSummons({ ...s, status }, invites, [one], long(60), NOW)), `${status}/${one.status}`).toEqual([]);
      }
    }
    for (const one of invites) {
      for (const previous of statuses) {
        expect(validateMessage(renderResponseNotice(s, invites, one, previous, long(60)))).toEqual([]);
      }
      expect(validateMessage(renderNudge(s, one, 5, false))).toEqual([]);
      expect(validateMessage(renderReminder(s, one))).toEqual([]);
      expect(validateMessage(renderVerdictNotice(s, { ...one, verdict: "denied" }))).toEqual([]);
      expect(validateMessage(renderCancelNotice(s, one))).toEqual([]);
    }
    expect(validateMessage(renderBriefing(s, invites, long(60)))).toEqual([]);
  });

  it("disables the buttons once the file is closed", () => {
    const i = invite(1);
    const msg = renderSummons(summons({ status: "closed" }), [i], [i], "B", NOW);
    expect(msg.components?.[0]?.components.every((b) => b.disabled)).toBe(true);
    expect(JSON.stringify(msg)).toContain("NO RESPONSE");
  });

  it("shows a roster when several people are summoned", () => {
    const invites = [invite(1, "yes"), invite(2, "excuse", "my cat")];
    const msg = renderSummons(summons(), invites, [invites[0]!], "B", NOW);
    const roster = msg.embeds?.[0]?.fields?.find((f) => f.name.includes("Roster"));
    expect(roster?.value).toContain("accepted");
    expect(roster?.value).toContain("“my cat”");
  });

  it("only renders the buttons the organizer kept", () => {
    const i = invite(1);
    const msg = renderSummons(summons({ options: DEFAULT_OPTIONS.slice(0, 2) }), [i], [i], "B", NOW);
    expect(msg.components?.[0]?.components).toHaveLength(2);
  });
});

describe("extension requests", () => {
  it("give the organizer grant/deny buttons until decided", () => {
    const s = summons();
    const pending = invite(1, "extend", "30 minutes");
    const open = renderResponseNotice(s, [pending], pending, "pending", "B");
    expect(open.components?.[0]?.components.map((b) => b.custom_id ?? b.url)).toEqual([
      "x:inv1:granted",
      "x:inv1:denied",
      "https://bureau.example.workers.dev/s/abc123",
    ]);
    const decided = renderResponseNotice(s, [pending], { ...pending, verdict: "granted" }, "extend", "B");
    expect(decided.components?.[0]?.components).toHaveLength(1);
    expect(decided.embeds?.[0]?.description).toContain("GRANTED");
  });
});

describe("modals", () => {
  it("fit Discord's modal limits", () => {
    expect(validateModal(renderModal(summons(), "excuse"))).toEqual([]);
    expect(validateModal(renderModal(summons(), "extend"))).toEqual([]);
  });

  it("read the note from Label-wrapped and legacy action-row submissions", () => {
    expect(findInputValue([{ type: 10 }, { type: 18, component: { type: 4, custom_id: "note", value: "cat" } }], "note")).toBe("cat");
    expect(findInputValue([{ type: 1, components: [{ type: 4, custom_id: "note", value: "dog" }] }], "note")).toBe("dog");
    expect(findInputValue([{ type: 18, component: { type: 4, custom_id: "other", value: "x" } }], "note")).toBeNull();
  });
});

describe("withoutButtonEmoji", () => {
  it("moves emoji into labels", () => {
    const i = invite(1);
    const msg = withoutButtonEmoji(renderSummons(summons(), [i], [i], "B", NOW));
    const first = msg.components?.[0]?.components[0];
    expect(first?.emoji).toBeUndefined();
    expect(first?.label).toBe("🫡 Accept Mission");
  });
});

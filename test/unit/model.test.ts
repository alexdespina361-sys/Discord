import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, ValidationError, formatDuration, validateDraft } from "../../src/model";
import { ALL_TEMPLATES } from "../../src/templates";

const NOW = Date.UTC(2026, 9, 1, 12, 0);
const draft = (over: Record<string, unknown> = {}) => ({
  guildId: "140000000000000003",
  recipients: ["140000000000000011"],
  classification: "Mandatory logistics operation",
  title: "Procurement Run — LIDL",
  startsAt: NOW + 3_600_000,
  durationMin: 45,
  ...over,
});

function fieldOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.field;
    throw e;
  }
  return "no error";
}

describe("validateDraft", () => {
  it("normalizes a minimal draft with sensible defaults", () => {
    const d = validateDraft(draft(), NOW);
    expect(d.classification).toBe("MANDATORY LOGISTICS OPERATION");
    expect(d.options).toEqual(DEFAULT_OPTIONS);
    expect(d.delivery).toBe("dm");
    expect(d.escalation).toBe("standard");
    expect(d.priority).toBe("routine");
    expect(d.createScheduledEvent).toBe(false);
  });

  it("dedupes recipients and caps them at 10", () => {
    expect(validateDraft(draft({ recipients: ["140000000000000011", "140000000000000011"] }), NOW).recipients).toHaveLength(1);
    const many = Array.from({ length: 11 }, (_, i) => `1400000000000000${String(i).padStart(2, "0")}`);
    expect(fieldOf(() => validateDraft(draft({ recipients: many }), NOW))).toBe("recipients");
  });

  it("names the offending field", () => {
    expect(fieldOf(() => validateDraft(draft({ recipients: [] }), NOW))).toBe("recipients");
    expect(fieldOf(() => validateDraft(draft({ recipients: ["@andrei"] }), NOW))).toBe("recipients");
    expect(fieldOf(() => validateDraft(draft({ title: "   " }), NOW))).toBe("title");
    expect(fieldOf(() => validateDraft(draft({ title: "x".repeat(101) }), NOW))).toBe("title");
    expect(fieldOf(() => validateDraft(draft({ startsAt: NOW - 3_600_000 }), NOW))).toBe("startsAt");
    expect(fieldOf(() => validateDraft(draft({ durationMin: 2 }), NOW))).toBe("durationMin");
    expect(fieldOf(() => validateDraft(draft({ delivery: "channel" }), NOW))).toBe("channelId");
    expect(fieldOf(() => validateDraft(draft({ remindBeforeMin: 7 }), NOW))).toBe("remindBeforeMin");
    expect(fieldOf(() => validateDraft(draft({ respondBy: NOW - 1 }), NOW))).toBe("respondBy");
  });

  it("allows 'right now' (a few minutes of clock skew)", () => {
    expect(validateDraft(draft({ startsAt: NOW - 60_000 }), NOW).startsAt).toBe(NOW - 60_000);
  });

  it("keeps the accept button and at least two options; only known emoji", () => {
    expect(fieldOf(() => validateDraft(draft({ options: [{ kind: "no", label: "No", emoji: "" }, { kind: "excuse", label: "Hm", emoji: "" }] }), NOW))).toBe(
      "options",
    );
    expect(fieldOf(() => validateDraft(draft({ options: [{ kind: "yes", label: "Yes", emoji: "" }] }), NOW))).toBe("options");
    expect(fieldOf(() => validateDraft(draft({ options: [{ kind: "yes", label: "Yes", emoji: "<:x:1>" }, { kind: "no", label: "No" }] }), NOW))).toBe(
      "options",
    );
    const sorted = validateDraft(
      draft({ options: [{ kind: "no", label: "Nope", emoji: "🙅" }, { kind: "yes", label: "Yep", emoji: "🫡" }] }),
      NOW,
    ).options;
    expect(sorted.map((o) => o.kind)).toEqual(["yes", "no"]);
  });
});

describe("templates", () => {
  it("every variant passes validation limits", () => {
    for (const t of ALL_TEMPLATES) {
      for (const classification of t.classification) {
        for (const title of t.title.filter(Boolean)) {
          const d = validateDraft(
            draft({
              classification,
              title,
              objective: t.objective.reduce((a, b) => (a.length > b.length ? a : b)),
              location: t.location.reduce((a, b) => (a.length > b.length ? a : b)),
              dressCode: t.dressCode.reduce((a, b) => (a.length > b.length ? a : b)),
              signatureTitle: t.signatureTitle.reduce((a, b) => (a.length > b.length ? a : b)),
              durationMin: t.durationMin,
              priority: t.priority,
            }),
            NOW,
          );
          expect(d.title).toBe(title);
        }
      }
    }
  });
});

describe("formatDuration", () => {
  it("reads naturally", () => {
    expect(formatDuration(45)).toBe("45 minutes");
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(90)).toBe("1 hour 30 min");
    expect(formatDuration(180)).toBe("3 hours");
  });
});

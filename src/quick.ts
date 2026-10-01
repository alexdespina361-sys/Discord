import { DEFAULT_OPTIONS, type SummonsDraft } from "./model";
import { clip } from "./messages";
import { ALL_TEMPLATES, BLANK_TEMPLATE, TEMPLATES } from "./templates";

/** Relative start times, so /summon never needs to know anyone's timezone. */
export const WHEN_CHOICES = [
  { name: "Right now", value: "0" },
  { name: "In 15 minutes", value: "15" },
  { name: "In 30 minutes", value: "30" },
  { name: "In 1 hour", value: "60" },
  { name: "In 2 hours", value: "120" },
  { name: "In 3 hours", value: "180" },
];

export const WHAT_CHOICES = [
  ...TEMPLATES.map((t) => ({ name: `${t.emoji} ${t.name}`, value: t.id })),
  { name: "📝 Something else", value: BLANK_TEMPLATE.id },
];

export interface QuickInput {
  what: string;
  minutes: number;
  title?: string | null;
  note?: string | null;
  guildId: string;
  recipients: string[];
}

function pick<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? items[0]!;
}

/** A complete summons from a template, with the official wording picked at random. */
export function quickDraft(input: QuickInput, now: number, random: () => number = Math.random): SummonsDraft {
  const t = ALL_TEMPLATES.find((x) => x.id === input.what) ?? BLANK_TEMPLATE;
  const minutes = WHEN_CHOICES.some((c) => Number(c.value) === input.minutes) ? input.minutes : 0;
  const title = clip(input.title?.trim() || pick(t.title, random) || "Unspecified Operation", 100);
  const objective = [pick(t.objective, random), input.note?.trim()].filter(Boolean).join("\n\n");
  return {
    guildId: input.guildId,
    recipients: input.recipients,
    classification: pick(t.classification, random),
    title,
    objective: clip(objective, 1000),
    location: pick(t.location, random),
    startsAt: now + minutes * 60_000,
    durationMin: t.durationMin,
    priority: t.priority,
    dressCode: pick(t.dressCode, random),
    signatureTitle: pick(t.signatureTitle, random),
    respondBy: null,
    options: DEFAULT_OPTIONS,
    delivery: "interaction",
    channelId: null,
    escalation: "standard",
    remindBeforeMin: minutes >= 30 ? 15 : 0,
    createScheduledEvent: false,
  };
}

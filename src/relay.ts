import type { DiscordFullMessage } from "./discord";

/** A message someone typed in their DM with the bot, reduced to what the relay needs. */
export interface IncomingDm {
  id: string;
  channelId: string;
  author: { id: string; name: string };
  content: string;
  attachments: { url: string; filename: string }[];
  stickers: string[];
  replyTo: string | null;
}

export type RelayOutcome = "forwarded" | "help" | "duplicate" | "ignored" | "failed";

/** Plain messages and replies; joins, pins, calls and the like aren't relayed. */
const RELAYED_TYPES = new Set([0, 19]);

export function toIncomingDm(m: DiscordFullMessage): IncomingDm | null {
  if (m.guild_id || !m.author || m.author.bot) return null;
  if (m.type !== undefined && !RELAYED_TYPES.has(m.type)) return null;
  const attachments = (m.attachments ?? []).map((a) => ({ url: a.url, filename: a.filename }));
  const stickers = (m.sticker_items ?? []).map((s) => s.name);
  const content = m.content ?? "";
  if (!content.trim() && !attachments.length && !stickers.length) return null;
  return {
    id: m.id,
    channelId: m.channel_id,
    author: { id: m.author.id, name: m.author.global_name || m.author.username },
    content,
    attachments,
    stickers,
    replyTo: m.message_reference?.message_id ?? null,
  };
}

const DISCORD_EPOCH = 1420070400000n;

/** The smallest snowflake Discord could assign at `ms`: everything sent later has a bigger ID. */
export function snowflakeAt(ms: number): string {
  return String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
}

/** Snowflakes grow over time; compare them without losing precision. */
export function laterId(a: string | null, b: string): string {
  if (!a) return b;
  try {
    return BigInt(b) > BigInt(a) ? b : a;
  } catch {
    return b;
  }
}

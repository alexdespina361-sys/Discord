import { describe, expect, it } from "vitest";
import { validateMessage } from "../e2e/fake-discord.mjs";
import { laterId, snowflakeAt, toIncomingDm } from "../../src/relay";
import { renderForward, renderRelayFailed, renderRelayHelp, renderUnreachable } from "../../src/messages";
import { DEFAULT_OPTIONS, type Invite, type Summons } from "../../src/model";

const andrei = { id: "140000000000000011", username: "andrei", global_name: "Andrei" };

describe("toIncomingDm", () => {
  it("keeps what the relay needs from a DM", () => {
    const dm = toIncomingDm({
      id: "1500000000000000001",
      channel_id: "1500000000000000002",
      type: 19,
      author: andrei,
      content: "on my way",
      attachments: [{ url: "https://cdn.example/cat.png", filename: "cat.png" }],
      message_reference: { message_id: "1500000000000000000" },
    });
    expect(dm).toEqual({
      id: "1500000000000000001",
      channelId: "1500000000000000002",
      author: { id: andrei.id, name: "Andrei" },
      content: "on my way",
      attachments: [{ url: "https://cdn.example/cat.png", filename: "cat.png" }],
      stickers: [],
      replyTo: "1500000000000000000",
    });
  });

  it("ignores bots, server messages, system messages and empty messages", () => {
    const base = { id: "1", channel_id: "2", author: andrei, content: "hi" };
    expect(toIncomingDm({ ...base, author: { ...andrei, bot: true } })).toBeNull();
    expect(toIncomingDm({ ...base, guild_id: "3" })).toBeNull();
    expect(toIncomingDm({ ...base, type: 7 })).toBeNull();
    expect(toIncomingDm({ ...base, content: "   " })).toBeNull();
    expect(toIncomingDm({ ...base, content: "", sticker_items: [{ name: "wave" }] })?.stickers).toEqual(["wave"]);
  });
});

describe("snowflakes", () => {
  it("compares IDs beyond Number precision", () => {
    expect(laterId("1500000000000000009", "1500000000000000010")).toBe("1500000000000000010");
    expect(laterId("1500000000000000010", "1500000000000000009")).toBe("1500000000000000010");
    expect(laterId(null, "5")).toBe("5");
  });

  it("builds the smallest ID Discord could assign at a time", () => {
    const at = Date.UTC(2026, 9, 1);
    const id = BigInt(snowflakeAt(at));
    expect(Number((id >> 22n) + 1420070400000n)).toBe(at);
  });
});

describe("relay messages", () => {
  it("forwards text, quoting multi-line messages, within Discord's limits", () => {
    const one = renderForward("Andrei", "on my way", [], [], "BMA-2026-0007");
    expect(one.content).toBe("💬 **Andrei:** on my way\n-# ↩️ Reply to this message to answer · re: BMA-2026-0007");
    expect(one.allowed_mentions).toEqual({ parse: [] });
    const multi = renderForward("Andrei", "line one\nline two", [], [], null);
    expect(multi.content).toContain("> line one\n> line two");
    const huge = renderForward("A".repeat(200), "x".repeat(5000), [{ url: "https://cdn.example/a.png", filename: "a.png" }], ["wave"], null);
    expect(validateMessage(huge)).toEqual([]);
    expect(huge.content!.length).toBeLessThanOrEqual(2000);
    expect(huge.content).toContain("Reply to this message to answer");
  });

  it("explains itself when it can't route or deliver", () => {
    expect(validateMessage(renderRelayHelp())).toEqual([]);
    expect(renderRelayFailed("Mihai").content).toContain("**Mihai**");
    const s = { ref: "BMA-2026-0001", options: DEFAULT_OPTIONS } as unknown as Summons;
    const invite = { recipient: { id: andrei.id, name: "Andrei", avatar: null } } as unknown as Invite;
    expect(renderUnreachable(s, invite).content).toContain("can't reach Andrei any more");
  });
});

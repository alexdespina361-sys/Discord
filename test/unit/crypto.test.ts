import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { openToken, randomId, sealToken, verifyDiscordSignature } from "../../src/crypto";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const hex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { hex, privateKey };
}

describe("verifyDiscordSignature", () => {
  const { hex, privateKey } = keypair();
  const body = JSON.stringify({ type: 1 });
  const ts = "1700000000";
  const sig = sign(null, Buffer.from(ts + body), privateKey).toString("hex");

  it("accepts a valid signature", async () => {
    expect(await verifyDiscordSignature(hex, sig, ts, body)).toBe(true);
  });

  it("rejects a tampered body, timestamp or signature", async () => {
    expect(await verifyDiscordSignature(hex, sig, ts, body + " ")).toBe(false);
    expect(await verifyDiscordSignature(hex, sig, "1700000001", body)).toBe(false);
    expect(await verifyDiscordSignature(hex, "00".repeat(64), ts, body)).toBe(false);
  });

  it("rejects missing headers and garbage keys without throwing", async () => {
    expect(await verifyDiscordSignature(hex, null, ts, body)).toBe(false);
    expect(await verifyDiscordSignature(hex, sig, null, body)).toBe(false);
    expect(await verifyDiscordSignature("not-hex", sig, ts, body)).toBe(false);
    expect(await verifyDiscordSignature(keypair().hex, sig, ts, body)).toBe(false);
  });
});

describe("sealed tokens", () => {
  it("round-trips a payload", async () => {
    const token = await sealToken("secret", { uid: "1", name: "Mihai" });
    expect(await openToken("secret", token)).toEqual({ uid: "1", name: "Mihai" });
  });

  it("rejects tokens signed with another secret or tampered with", async () => {
    const token = await sealToken("secret", { uid: "1" });
    expect(await openToken("other", token)).toBeNull();
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "2" })).toString("base64url");
    expect(await openToken("secret", `${forged}.${mac}`)).toBeNull();
    expect(await openToken("secret", `${body}`)).toBeNull();
    expect(await openToken("secret", null)).toBeNull();
  });
});

describe("randomId", () => {
  it("uses only unambiguous characters", () => {
    const id = randomId(200);
    expect(id).toHaveLength(200);
    expect(id).not.toMatch(/[01lIoO]/);
  });
});

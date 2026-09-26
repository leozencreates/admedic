import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptField, encryptField, maskEmail, maskPhone, tryDecryptField } from "./crypto";

const KEY = "0".repeat(63) + "1";

describe("field encryption", () => {
  const original = process.env.ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  });

  it("round-trips and uses a fresh IV per call", () => {
    const a = encryptField("+905321112233")!;
    const b = encryptField("+905321112233")!;
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe("+905321112233");
    expect(decryptField(b)).toBe("+905321112233");
  });

  it("returns null for empty input and rejects tampered data", () => {
    expect(encryptField(null)).toBeNull();
    expect(encryptField("")).toBeNull();
    const c = encryptField("secret")!;
    const tampered = Buffer.from(c, "base64");
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptField(tampered.toString("base64"))).toThrow();
    expect(tryDecryptField(tampered.toString("base64"))).toBeNull();
  });

  it("fails clearly without a key", () => {
    process.env.ENCRYPTION_KEY = "";
    expect(() => encryptField("x")).toThrow(/ENCRYPTION_KEY/);
  });

  it("masks contact data", () => {
    expect(maskEmail("leo@example.com")).toBe("l***@example.com");
    expect(maskPhone("+905321112233")).toBe("+90***33");
  });
});

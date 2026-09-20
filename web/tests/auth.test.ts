import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, tokenHash } from "../app/_lib/password";
import { body, sameOrigin } from "../app/_lib/http";
import { z } from "zod";
import { randomBytes } from "node:crypto";
describe("credentials and request boundary", () => {
  it("salts password hashes and rejects missing, wrong or malformed credentials", async () => {
    const password = randomBytes(24).toString("hex");
    const [a, b] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(password, a)).toBe(true);
    expect(await verifyPassword(`${password}!`, a)).toBe(false);
    expect(await verifyPassword(password, null)).toBe(false);
    expect(await verifyPassword(password, "malformed")).toBe(false);
    expect(tokenHash(password)).not.toBe(password);
  });
  it("rejects cross-origin and missing-origin writes", () => {
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3000/api/studio", {
          headers: { origin: "https://elsewhere.example" },
        }),
      ),
    ).toThrow();
    expect(() =>
      sameOrigin(new Request("http://localhost:3000/api/studio")),
    ).toThrow();
  });
  it("enforces JSON shape and byte limits", async () => {
    const schema = z.object({ value: z.string().max(10) }).strict();
    const req = (s: string) =>
      new Request("http://localhost:3000", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: s,
      });
    await expect(body(req('{"value":"ok"}'), schema)).resolves.toEqual({
      value: "ok",
    });
    await expect(
      body(req('{"value":"ok", "role":"OWNER"}'), schema),
    ).rejects.toMatchObject({ status: 400 });
    await expect(body(req("x".repeat(32769)), schema)).rejects.toMatchObject({
      status: 413,
    });
  });
});

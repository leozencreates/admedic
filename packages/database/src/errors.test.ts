import { describe, expect, it } from "vitest";
import { uniqueViolationFields } from "./errors";

describe("uniqueViolationFields", () => {
  it("yerel motor ve sürücü bağdaştırıcısı biçimlerini okur", () => {
    expect(uniqueViolationFields({ code: "P2002", meta: { target: ["externalId"] } })).toEqual(["externalId"]);
    expect(
      uniqueViolationFields({ code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields: ['"workspaceId"', "slug"] } } } } }),
    ).toEqual(["workspaceId", "slug"]);
    expect(uniqueViolationFields({ code: "P2002", meta: {} })).toEqual([]);
    expect(uniqueViolationFields({ code: "P2025" })).toBeNull();
    expect(uniqueViolationFields(null)).toBeNull();
  });
});

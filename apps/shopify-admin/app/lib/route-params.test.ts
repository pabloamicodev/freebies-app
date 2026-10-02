import { describe, expect, it } from "vitest";
import { isUuid, parseUuidParam } from "./route-params.js";

const ID = "3f2b8c1e-9d4a-4e6b-8a1c-0b7d5e2f4a69";

describe("parseUuidParam", () => {
  it("returns a valid uuid", () => {
    expect(parseUuidParam({ id: ID })).toBe(ID);
    expect(parseUuidParam({ offerId: ID.toUpperCase() }, "offerId")).toBe(ID.toUpperCase());
  });

  it.each([undefined, "", "123", "not-a-uuid", `${ID}x`, `${ID}'; drop table offers;--`, "new"])("throws a 404 for %s", (bad) => {
    try {
      parseUuidParam({ id: bad });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("isUuid rejects non-strings", () => {
    expect(isUuid(5)).toBe(false);
    expect(isUuid(ID)).toBe(true);
  });
});

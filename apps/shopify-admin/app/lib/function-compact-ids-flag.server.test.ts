import type { Db } from "@promo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isFunctionCompactIdsEnabled } from "./function-compact-ids-flag.server.js";

const dbWith = (value?: string) =>
  ({ select: () => ({ from: () => ({ where: async () => (value === undefined ? [] : [{ value }]) }) }) }) as unknown as Db;

afterEach(() => vi.unstubAllEnvs());

describe("isFunctionCompactIdsEnabled", () => {
  it("is off unless the shop row is true", async () => {
    expect(await isFunctionCompactIdsEnabled(dbWith(), "s")).toBe(false);
    expect(await isFunctionCompactIdsEnabled(dbWith("false"), "s")).toBe(false);
    expect(await isFunctionCompactIdsEnabled(dbWith("true"), "s")).toBe(true);
  });

  it("env off forces it off even for an enabled shop", async () => {
    vi.stubEnv("FUNCTION_COMPACT_IDS", "off");
    expect(await isFunctionCompactIdsEnabled(dbWith("true"), "s")).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@promo/db";
import { createTestDb, seedShop } from "./test-support/pglite-db.js";
import { isRemoveUnfundedGiftsEnabled, setRemoveUnfundedGiftsEnabled } from "./remove-unfunded-gifts-flag.server.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("remove-unfunded-gifts flag", () => {
  it("is off by default, on only after an explicit set, and per shop", async () => {
    const a = await seedShop(db, "flag-a.myshopify.com");
    const b = await seedShop(db, "flag-b.myshopify.com");
    expect(await isRemoveUnfundedGiftsEnabled(db, a)).toBe(false);
    await setRemoveUnfundedGiftsEnabled(db, a, true);
    expect(await isRemoveUnfundedGiftsEnabled(db, a)).toBe(true);
    expect(await isRemoveUnfundedGiftsEnabled(db, b)).toBe(false);
    await setRemoveUnfundedGiftsEnabled(db, a, false);
    expect(await isRemoveUnfundedGiftsEnabled(db, a)).toBe(false);
  });
});

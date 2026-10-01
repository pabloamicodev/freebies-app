import { describe, expect, it } from "vitest";
import { createTestDb, seedOffer, seedShop } from "./pglite-db.js";

describe("pglite harness", () => {
  it("applies all migrations", async () => {
    const { db, close } = await createTestDb();
    const shopId = await seedShop(db);
    const offerId = await seedOffer(db, shopId);
    expect(offerId).toMatch(/-/);
    await close();
  }, 60_000);
});

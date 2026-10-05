import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { offers, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("0020_offer_timezone_backfill", () => {
  it("fills NULL offer timezones from the shop, leaves set ones and stored instants alone", async () => {
    const shopId = await seedShop(db, "backfill.myshopify.com");
    await db.update(shops).set({ timezone: "America/Argentina/Buenos_Aires" }).where(eq(shops.id, shopId));
    const startsAt = new Date("2030-01-01T15:00:00.000Z");
    const nullTz = await seedOffer(db, shopId, { timezone: null, startsAt });
    const explicit = await seedOffer(db, shopId, { timezone: "Europe/Paris", startsAt });

    const file = readFileSync(resolve(__dirname, "../../../../packages/db/drizzle/0020_offer_timezone_backfill.sql"), "utf8");
    await db.execute(sql.raw(file));

    const rows = await db.select().from(offers).where(eq(offers.shopId, shopId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(nullTz)!.timezone).toBe("America/Argentina/Buenos_Aires");
    expect(byId.get(explicit)!.timezone).toBe("Europe/Paris");
    expect(byId.get(nullTz)!.startsAt!.toISOString()).toBe(startsAt.toISOString());
  });
});

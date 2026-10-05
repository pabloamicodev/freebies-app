import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offers, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import { _resetTimezoneThrottleForTests, refreshShopTimezone } from "./shop-timezone-refresh.server.js";

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => close());
beforeEach(() => _resetTimezoneThrottleForTests());

describe("refreshShopTimezone", () => {
  it("updates the shop and pins only NULL-timezone offers, instants untouched, throttled", async () => {
    const shopId = await seedShop(db, "tz-refresh.myshopify.com");
    const startsAt = new Date("2026-10-06T00:01:00Z");
    const nullTz = await seedOffer(db, shopId, { timezone: null, startsAt });
    const utcTz = await seedOffer(db, shopId, { timezone: "UTC", startsAt });
    const fetchZone = vi.fn(async () => "America/New_York");

    expect(await refreshShopTimezone({ db, shopId, storedTimezone: "UTC", fetchZone })).toBe("America/New_York");
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop!.timezone).toBe("America/New_York");
    const rows = new Map((await db.select().from(offers).where(eq(offers.shopId, shopId))).map((r) => [r.id, r]));
    expect(rows.get(nullTz)!.timezone).toBe("America/New_York");
    expect(rows.get(utcTz)!.timezone).toBe("UTC");
    expect(rows.get(nullTz)!.startsAt!.toISOString()).toBe(startsAt.toISOString());

    expect(await refreshShopTimezone({ db, shopId, storedTimezone: "UTC", fetchZone })).toBeNull();
    expect(fetchZone).toHaveBeenCalledTimes(1);
  });

  it("ignores UTC results, real zones stored, and fetch errors", async () => {
    const shopId = await seedShop(db, "tz-refresh2.myshopify.com");
    expect(await refreshShopTimezone({ db, shopId, storedTimezone: "UTC", fetchZone: async () => "UTC" })).toBeNull();
    _resetTimezoneThrottleForTests();
    expect(await refreshShopTimezone({ db, shopId, storedTimezone: "UTC", fetchZone: async () => { throw new Error("x"); } })).toBeNull();
    const fetchZone = vi.fn(async () => "Europe/Paris");
    expect(await refreshShopTimezone({ db, shopId, storedTimezone: "America/Chicago", fetchZone })).toBeNull();
    expect(fetchZone).not.toHaveBeenCalled();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@promo/db";
import { clearFanOutCache } from "../multi-shop.server.js";
import { createTestDb, seedOffer } from "../../test-support/pglite-db.js";
import { NOW, SECRET_VALUES, insertEvents, now, operatorAll, seedWorld } from "./insights-test-fixtures.js";
import { promoPerformance } from "./promo-performance.server.js";
import { resolveWindow } from "./insights-common.server.js";

let db: Db;
let close: () => Promise<void>;
let world: Awaited<ReturnType<typeof seedWorld>>;
let alphaOffer: string;
let betaOffer: string;
let alphaBundle: string;

const DAY = "2026-10-25T10:00:00.000Z";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  world = await seedWorld(db);
  alphaOffer = await seedOffer(db, world.alpha, { type: "gift", internalName: "Alpha gift" });
  alphaBundle = await seedOffer(db, world.alpha, { type: "bundle", internalName: "Alpha bundle" });
  betaOffer = await seedOffer(db, world.beta, { type: "gift", internalName: "Beta gift" });
  const goneOffer = await seedOffer(db, world.gone, { type: "gift", internalName: "Gone gift" });

  await insertEvents(db, { shopId: world.alpha, offerId: alphaOffer, name: "promo_engine:widget_viewed", at: DAY, n: 100 });
  await insertEvents(db, { shopId: world.alpha, offerId: alphaOffer, name: "promo_engine:gift_auto_added", at: DAY, n: 20 });
  await insertEvents(db, { shopId: world.alpha, offerId: alphaOffer, name: "checkout_started", at: DAY, n: 10 });
  await insertEvents(db, { shopId: world.alpha, offerId: alphaOffer, name: "promo_engine:cart_mutation_error", at: DAY, n: 5 });
  for (let i = 0; i < 4; i++) {
    await insertEvents(db, {
      shopId: world.alpha, offerId: alphaOffer, name: "order_placed_attributed", at: DAY,
      orderId: `gid://shopify/Order/${9000 + i}`, properties: { subtotalCents: 5000, savedCents: 500 },
    });
  }
  // The same order delivered twice counts once.
  await insertEvents(db, {
    shopId: world.alpha, offerId: alphaOffer, name: "order_placed_attributed", at: DAY,
    orderId: "gid://shopify/Order/9000", properties: { subtotalCents: 5000, savedCents: 500 },
  });
  // Bundle: only orders, no views/adds/checkouts (zero denominators).
  await insertEvents(db, {
    shopId: world.alpha, offerId: alphaBundle, name: "order_placed_attributed", at: DAY,
    orderId: SECRET_VALUES.order, properties: { subtotalCents: 12000 },
  });

  await insertEvents(db, { shopId: world.beta, offerId: betaOffer, name: "promo_engine:widget_viewed", at: DAY, n: 50 });
  for (let i = 0; i < 2; i++) {
    await insertEvents(db, {
      shopId: world.beta, offerId: betaOffer, name: "order_placed_attributed", at: DAY,
      orderId: `gid://shopify/Order/${7000 + i}`, properties: { subtotalCents: 3000, savedCents: 300 },
    });
  }
  // Beta event at 23:30 UTC on Oct 25 is already Oct 26 in Madrid.
  await insertEvents(db, { shopId: world.beta, offerId: betaOffer, name: "promo_engine:widget_viewed", at: "2026-10-25T23:30:00.000Z", n: 3 });

  await insertEvents(db, { shopId: world.gone, offerId: goneOffer, name: "promo_engine:widget_viewed", at: DAY, n: 999 });
  // Outside the window (older than 30 days) and events without an offer.
  await insertEvents(db, { shopId: world.alpha, offerId: alphaOffer, name: "promo_engine:widget_viewed", at: "2026-08-01T00:00:00.000Z", n: 7 });
  await insertEvents(db, { shopId: world.alpha, offerId: null, name: "promo_engine:widget_viewed", at: DAY, n: 11 });
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => clearFanOutCache());

const run = async (args: Parameters<typeof promoPerformance>[2] = {}) =>
  promoPerformance(db, await world.visible(), args, now);

describe("promo_performance", () => {
  it("aggregates per offer across shops with rates from counts and money per currency", async () => {
    const res = await run();
    const rows = Object.fromEntries(res.data.rows.map((r) => [r.name, r]));
    expect(Object.keys(rows).sort()).toEqual(["Alpha bundle", "Alpha gift", "Beta gift"]);

    const gift = rows["Alpha gift"]!;
    expect(gift.promoRef).toBe(`promo:alpha:${alphaOffer}`);
    expect(gift.counts).toMatchObject({ views: 100, adds: 20, checkouts: 10, cartErrors: 5, orders: 4 });
    expect(gift.rates).toEqual({ addRate: 0.2, checkoutRate: 0.5, orderRate: 0.4, cartErrorRate: 0.2 });
    expect(gift.revenue).toEqual([{ amount: "200.00", currency: "USD" }]);
    expect(gift.discountGiven).toEqual([{ amount: "20.00", currency: "USD" }]);
    expect(gift.aov).toEqual([{ amount: "50.00", currency: "USD" }]);

    const beta = rows["Beta gift"]!;
    expect(beta.counts.views).toBe(53);
    expect(beta.revenue).toEqual([{ amount: "60.00", currency: "EUR" }]);
    expect(beta.aov).toEqual([{ amount: "30.00", currency: "EUR" }]);
  });

  it("totals sum counts, recompute rates and keep currencies apart", async () => {
    const { totals } = (await run()).data;
    expect(totals.counts).toMatchObject({ views: 153, adds: 20, orders: 7 });
    expect(totals.rates.addRate).toBeCloseTo(20 / 153, 4);
    expect(totals.rates.addRate).not.toBe((0.2 + 0 + 0) / 3);
    expect(totals.revenue).toEqual([
      { amount: "60.00", currency: "EUR" },
      { amount: "320.00", currency: "USD" },
    ]);
  });

  it("returns null rates (never 0 or NaN) when the denominator is 0", async () => {
    const res = await run();
    const bundle = res.data.rows.find((r) => r.name === "Alpha bundle")!;
    expect(bundle.counts).toMatchObject({ views: 0, adds: 0, checkouts: 0, orders: 1 });
    expect(bundle.rates).toEqual({ addRate: null, checkoutRate: null, orderRate: null, cartErrorRate: null });
    const beta = res.data.rows.find((r) => r.name === "Beta gift")!;
    expect(beta.rates.addRate).toBe(0);
    expect(beta.rates.checkoutRate).toBeNull();
  });

  it("excludes uninstalled shops, events outside the window and events without an offer", async () => {
    const res = await run();
    expect(res.perShop!.map((p) => p.shopDomain)).toEqual(["alpha.myshopify.com", "beta.myshopify.com"]);
    expect(res.data.rows.map((r) => r.name)).not.toContain("Gone gift");
    expect(res.data.totals.counts.views).toBe(153);
    await expect(run({ shops: ["gone"] })).rejects.toMatchObject({ payload: { code: "SHOP_NOT_FOUND" } });
  });

  it("reports honestly which events are missing", async () => {
    const res = await run();
    const { aggregate, perShop } = res.data.dataQuality;
    expect(aggregate.missingEvents.map((m) => m.stage)).toEqual(["qualified"]);
    expect(aggregate.ordersWithoutRevenue).toBe(0);
    const beta = perShop.find((p) => p.shopDomain === "beta.myshopify.com")!;
    expect(beta.missingEvents.map((m) => m.stage).sort()).toEqual(["adds", "cartErrors", "checkouts", "qualified"]);
    expect(beta.earliestEventAt).toBe("2026-10-25T10:00:00.000Z");
    expect(res.data.dataQuality.notes.join(" ")).toMatch(/not incremental/);
  });

  it("warns when a shop has no order events at all", async () => {
    const res = await run({ lastDays: 1, shops: ["alpha"] });
    expect(res.warnings.map((w) => w.code)).toContain("NO_ORDER_EVENTS");
    expect(res.data.totals.rates.addRate).toBeNull();
  });

  it("groups by day using each shop's timezone", async () => {
    const res = await run({ groupBy: "day", shops: ["beta"] });
    expect(res.data.rows.map((r) => [r.key, r.counts.views])).toEqual([
      ["2026-10-25", 50],
      ["2026-10-26", 3],
    ]);
    const alpha = await run({ groupBy: "day", shops: ["alpha"] });
    expect(alpha.data.rows.map((r) => r.key)).toEqual(["2026-10-25"]);
  });

  it("groups by offer type", async () => {
    const res = await run({ groupBy: "type" });
    const byType = Object.fromEntries(res.data.rows.map((r) => [r.key, r.counts]));
    expect(byType["gift"]).toMatchObject({ views: 153, orders: 6 });
    expect(byType["bundle"]).toMatchObject({ views: 0, orders: 1 });
  });

  it("narrows to one offer by ref and rejects bad or unknown refs", async () => {
    const res = await run({ ref: `promo:beta:${betaOffer}` });
    expect(res.data.rows).toHaveLength(1);
    expect(res.data.rows[0]!.name).toBe("Beta gift");
    await expect(run({ ref: "nope" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
    await expect(run({ ref: "promo:beta:11111111-1111-1111-1111-111111111111" })).rejects.toMatchObject({ payload: { code: "NOT_FOUND" } });
    await expect(run({ ref: "promo:gone:11111111-1111-1111-1111-111111111111" })).rejects.toMatchObject({ payload: { code: "SHOP_NOT_FOUND" } });
  });

  it("enforces the 90-day window and validates dates", async () => {
    await expect(run({ start: "2026-01-01T00:00:00Z", end: "2026-11-01T00:00:00Z" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
    await expect(run({ start: "garbage" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
    await expect(run({ start: "2026-10-02T00:00:00Z", end: "2026-10-01T00:00:00Z" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
    const ok = await run({ start: "2026-10-24T00:00:00Z", end: "2026-10-26T00:00:00Z" });
    expect(ok.meta.window).toEqual({ start: "2026-10-24T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z" });
    expect(ok.data.totals.counts.views).toBe(153);
  });

  it("paginates with an opaque cursor", async () => {
    const first = await run({ limit: 2 });
    expect(first.data.rows).toHaveLength(2);
    expect(first.meta.page?.hasMore).toBe(true);
    const second = await run({ limit: 2, cursor: first.meta.page!.cursor! });
    expect(second.data.rows).toHaveLength(1);
    expect(second.meta.page?.hasMore).toBe(false);
    await expect(run({ cursor: "!!!" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
  });

  it("never outputs customer, session, cart or order identifiers", async () => {
    for (const groupBy of ["offer", "day", "type"] as const) {
      const json = JSON.stringify(await run({ groupBy }));
      for (const secret of Object.values(SECRET_VALUES)) expect(json).not.toContain(secret);
      expect(json).not.toMatch(/customer_?id|session_?id|cart_?token|order_?id/i);
    }
  });

  it("an allow-listed operator only aggregates its shops", async () => {
    const visible = await world.visible({ ...operatorAll, shopAllowList: ["beta.myshopify.com"] });
    const res = await promoPerformance(db, visible, {}, now);
    expect(res.data.rows.map((r) => r.name)).toEqual(["Beta gift"]);
    expect(res.data.totals.revenue).toEqual([{ amount: "60.00", currency: "EUR" }]);
  });
});

describe("resolveWindow", () => {
  it("defaults to the last 30 days ending now", () => {
    const w = resolveWindow({}, NOW);
    expect(w.end).toEqual(NOW);
    expect(NOW.getTime() - w.start.getTime()).toBe(30 * 86_400_000);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { discountCodes, offerConditions, offers, type Db } from "@promo/db";
import { migrateLegacyDiscountCodes } from "./discount-code-migration.server.js";
import { findShopsWithDueCodeChanges, runDiscountCodeSchedule } from "./discount-code-schedule.server.js";
import { recordDiscountCodeRedemptions } from "./discount-codes.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

vi.mock("./offer-publish-flow.server.js", () => ({ publishShopConfig: vi.fn() }));
vi.mock("./publish-pending.server.js", () => ({ markPublishPending: vi.fn(async () => undefined) }));

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function conditionRow(offerId: string, code: unknown, overrides: Record<string, unknown> = {}) {
  const [shop] = await db.select({ shopId: offers.shopId }).from(offers).where(eq(offers.id, offerId));
  await db.insert(offerConditions).values({
    shopId: shop!.shopId,
    offerId,
    scope: "sub",
    conditionType: "discount_code",
    operator: "eq",
    value: { code },
    sortOrder: 0,
    isEnabled: true,
    ...overrides,
  });
}

describe("migrateLegacyDiscountCodes", () => {
  it("dry run reports what would change and writes nothing", async () => {
    const shopId = await seedShop(db, "mig-dry.myshopify.com");
    const fromCondition = await seedOffer(db, shopId);
    const fromRequired = await seedOffer(db, shopId, {
      requiredDiscountCode: "LIVECODE",
      codeDiscountId: "gid://shopify/DiscountCodeNode/1",
    });
    await conditionRow(fromCondition, " prime2026 ");

    const report = await migrateLegacyDiscountCodes(db, { apply: false, shopId });

    expect(report.conditionOffers.map((o) => [o.offerId, o.code])).toEqual([[fromCondition, "PRIME2026"]]);
    expect(report.requiredCodeOffers).toEqual([
      expect.objectContaining({ offerId: fromRequired, code: "LIVECODE", codeDiscountId: "gid://shopify/DiscountCodeNode/1" }),
    ]);
    expect(await db.select().from(discountCodes).where(eq(discountCodes.shopId, shopId))).toEqual([]);
    expect(await db.select().from(offerConditions).where(eq(offerConditions.offerId, fromCondition))).toHaveLength(1);
    const [untouched] = await db.select().from(offers).where(eq(offers.id, fromRequired));
    expect(untouched!.requiredDiscountCode).toBe("LIVECODE");
  });

  it("applies the move, keeps the live node linked, and is idempotent", async () => {
    const shopId = await seedShop(db, "mig-apply.myshopify.com");
    const fromCondition = await seedOffer(db, shopId);
    const fromRequired = await seedOffer(db, shopId, {
      requiredDiscountCode: "LIVECODE2",
      codeDiscountId: "gid://shopify/DiscountCodeNode/2",
    });
    await conditionRow(fromCondition, "PRIME");
    await conditionRow(fromCondition, "IGNORED", { isEnabled: false, sortOrder: 1 });

    await migrateLegacyDiscountCodes(db, { apply: true, shopId });

    const rows = await db.select().from(discountCodes).where(eq(discountCodes.shopId, shopId));
    expect(rows.map((r) => [r.offerId, r.code, Boolean(r.shopifySyncedAt)]).sort()).toEqual(
      [
        [fromCondition, "PRIME", false],
        // The existing node already carries this code, so it is not re-added.
        [fromRequired, "LIVECODE2", true],
      ].sort(),
    );
    expect(await db.select().from(offerConditions).where(eq(offerConditions.offerId, fromCondition))).toEqual([]);
    const [required] = await db.select().from(offers).where(eq(offers.id, fromRequired));
    expect(required).toMatchObject({ requiredDiscountCode: null, codeDiscountId: "gid://shopify/DiscountCodeNode/2" });

    const again = await migrateLegacyDiscountCodes(db, { apply: true, shopId });
    expect(again.conditionOffers).toEqual([]);
    expect(again.requiredCodeOffers).toEqual([]);
    expect(await db.select().from(discountCodes).where(eq(discountCodes.shopId, shopId))).toHaveLength(2);
  });

  it("reports offers it cannot convert instead of guessing: several codes, clashes, archived", async () => {
    const shopId = await seedShop(db, "mig-conflict.myshopify.com");
    const several = await seedOffer(db, shopId);
    await conditionRow(several, "ONE");
    await conditionRow(several, "TWO", { sortOrder: 1 });
    const mixed = await seedOffer(db, shopId, { requiredDiscountCode: "REQ1" });
    await conditionRow(mixed, "DIFFERENT");
    const owner = await seedOffer(db, shopId);
    await db.insert(discountCodes).values({ shopId, offerId: owner, code: "TAKEN" });
    const clash = await seedOffer(db, shopId);
    await conditionRow(clash, "taken");
    const archived = await seedOffer(db, shopId, { status: "archived" });
    await conditionRow(archived, "OLD");

    const report = await migrateLegacyDiscountCodes(db, { apply: true, shopId });

    expect(report.conflicts.map((c) => c.offerId).sort()).toEqual([several, mixed, clash].sort());
    expect(report.skippedArchived).toBe(1);
    // Nothing was changed for the conflicting or archived ones.
    expect(await db.select().from(offerConditions).where(eq(offerConditions.offerId, several))).toHaveLength(2);
    expect(await db.select().from(offerConditions).where(eq(offerConditions.offerId, archived))).toHaveLength(1);
  });
});

describe("discount code schedule", () => {
  it("flags shops with a startable code or an expired code still on Shopify, and republishes them", async () => {
    const shopId = await seedShop(db, "sched.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    const now = new Date("2026-06-01T12:00:00Z");
    await db.insert(discountCodes).values([
      { shopId, offerId, code: "SYNCED", shopifySyncedAt: new Date("2026-05-01") },
    ]);
    expect((await findShopsWithDueCodeChanges(db, now)).map((s) => s.shopId)).not.toContain(shopId);

    // Window opened and never made it to Shopify.
    await db.insert(discountCodes).values({ shopId, offerId, code: "OPENED", startsAt: new Date("2026-05-31") });
    expect((await findShopsWithDueCodeChanges(db, now)).map((s) => s.shopId)).toContain(shopId);
    await db.update(discountCodes).set({ shopifySyncedAt: now }).where(eq(discountCodes.code, "OPENED"));
    expect((await findShopsWithDueCodeChanges(db, now)).map((s) => s.shopId)).not.toContain(shopId);

    // Expired but still on Shopify.
    await db.update(discountCodes).set({ endsAt: new Date("2026-05-31") }).where(eq(discountCodes.code, "SYNCED"));
    const publish = vi.fn().mockResolvedValue(null);
    const result = await runDiscountCodeSchedule(db, now, publish);
    expect(publish).toHaveBeenCalledWith(shopId, "sched.myshopify.com");
    expect(result).toMatchObject({ failures: [] });
  });

  it("ignores codes of offers that are not live", async () => {
    const shopId = await seedShop(db, "sched-paused.myshopify.com");
    const offerId = await seedOffer(db, shopId, { status: "paused" });
    await db.insert(discountCodes).values({ shopId, offerId, code: "PAUSEDOFFER" });
    expect((await findShopsWithDueCodeChanges(db, new Date())).map((s) => s.shopId)).not.toContain(shopId);
  });

  it("reports a failed publish instead of swallowing it", async () => {
    const shopId = await seedShop(db, "sched-fail.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    await db.insert(discountCodes).values({ shopId, offerId, code: "NEEDSPUSH" });
    const result = await runDiscountCodeSchedule(db, new Date(), vi.fn().mockResolvedValue("Shopify rejected a code"));
    expect(result.failures).toContainEqual(expect.objectContaining({ shopId, error: "Shopify rejected a code" }));
  });
});

describe("orders/paid handler", () => {
  it("republishes once when a redemption exhausts a code, and not for ordinary redemptions", async () => {
    const { publishShopConfig } = await import("./offer-publish-flow.server.js");
    const publish = vi.mocked(publishShopConfig);
    publish.mockReset();
    publish.mockResolvedValue(null);
    const { handleDiscountCodeRedemptions } = await import("./webhooks/discount-code-redemption.server.js");

    const shopId = await seedShop(db, "paid.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    await db.insert(discountCodes).values([
      { shopId, offerId, code: "ONCE", usageLimit: 1, shopifySyncedAt: new Date() },
      { shopId, offerId, code: "PLENTY" },
    ]);

    await handleDiscountCodeRedemptions(db, shopId, "paid.myshopify.com", { id: 1, discount_codes: [{ code: "PLENTY" }] });
    expect(publish).not.toHaveBeenCalled();

    await handleDiscountCodeRedemptions(db, shopId, "paid.myshopify.com", { id: 2, discount_codes: [{ code: "ONCE" }] });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(shopId, "paid.myshopify.com");

    // Orders without a managed code never reach the publisher.
    await handleDiscountCodeRedemptions(db, shopId, "paid.myshopify.com", { id: 3, discount_codes: [{ code: "NATIVE" }] });
    await handleDiscountCodeRedemptions(db, null, "paid.myshopify.com", { id: 4, discount_codes: [{ code: "ONCE" }] });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("records the redemption before answering and republishes after the response, not inside it", async () => {
    const { publishShopConfig } = await import("./offer-publish-flow.server.js");
    let release: (value: null) => void = () => undefined;
    vi.mocked(publishShopConfig).mockReset();
    vi.mocked(publishShopConfig).mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { handleDiscountCodeRedemptions } = await import("./webhooks/discount-code-redemption.server.js");
    const shopId = await seedShop(db, "paid-deferred.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    await db.insert(discountCodes).values({ shopId, offerId, code: "DEFER1", usageLimit: 1, shopifySyncedAt: new Date() });
    const deferred: Promise<void>[] = [];

    // The handler resolves while the republish is still pending: the webhook is not held up by it.
    await handleDiscountCodeRedemptions(
      db,
      shopId,
      "paid-deferred.myshopify.com",
      { id: 30, discount_codes: [{ code: "DEFER1" }] },
      { defer: (work) => void deferred.push(work) },
    );

    const [row] = await db.select().from(discountCodes).where(eq(discountCodes.code, "DEFER1"));
    expect(row).toMatchObject({ usageCount: 1, status: "exhausted" });
    expect(deferred).toHaveLength(1);
    expect(publishShopConfig).toHaveBeenCalledTimes(1);

    release(null);
    await Promise.all(deferred);
  });

  it("does not fail the webhook when the deferred republish fails: the shop is parked as publish-pending for the cron", async () => {
    const { publishShopConfig } = await import("./offer-publish-flow.server.js");
    const { markPublishPending } = await import("./publish-pending.server.js");
    vi.mocked(markPublishPending).mockClear();
    vi.mocked(publishShopConfig).mockReset();
    vi.mocked(publishShopConfig).mockResolvedValue("Shopify is down");
    const { handleDiscountCodeRedemptions } = await import("./webhooks/discount-code-redemption.server.js");
    const shopId = await seedShop(db, "paid-fail.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    await db.insert(discountCodes).values({ shopId, offerId, code: "LASTONE", usageLimit: 1, shopifySyncedAt: new Date() });
    const deferred: Promise<void>[] = [];

    await expect(
      handleDiscountCodeRedemptions(
        db,
        shopId,
        "paid-fail.myshopify.com",
        { id: 10, discount_codes: [{ code: "LASTONE" }] },
        { defer: (work) => void deferred.push(work) },
      ),
    ).resolves.toBeUndefined();
    await Promise.all(deferred);

    expect(markPublishPending).toHaveBeenCalledWith(shopId);
    // The redemption itself is recorded, and a redelivery still reports the exhausted offer.
    expect((await recordDiscountCodeRedemptions(db, shopId, { id: 10, discount_codes: [{ code: "LASTONE" }] })).exhaustedOfferIds).toEqual([offerId]);
  });

  it("also parks the shop when the republish throws", async () => {
    const { publishShopConfig } = await import("./offer-publish-flow.server.js");
    const { markPublishPending } = await import("./publish-pending.server.js");
    vi.mocked(markPublishPending).mockClear();
    vi.mocked(publishShopConfig).mockReset();
    vi.mocked(publishShopConfig).mockRejectedValue(new Error("socket hang up"));
    const { handleDiscountCodeRedemptions } = await import("./webhooks/discount-code-redemption.server.js");
    const shopId = await seedShop(db, "paid-throw.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    await db.insert(discountCodes).values({ shopId, offerId, code: "BOOM1", usageLimit: 1, shopifySyncedAt: new Date() });
    const deferred: Promise<void>[] = [];

    await handleDiscountCodeRedemptions(
      db,
      shopId,
      "paid-throw.myshopify.com",
      { id: 40, discount_codes: [{ code: "BOOM1" }] },
      { defer: (work) => void deferred.push(work) },
    );
    await expect(Promise.all(deferred)).resolves.toBeDefined();
    expect(markPublishPending).toHaveBeenCalledWith(shopId);
  });
});

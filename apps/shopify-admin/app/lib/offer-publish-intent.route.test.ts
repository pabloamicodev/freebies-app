import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, offerConditions, offerRewards, offerVersions, offers, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import type * as PublishFlow from "./offer-publish-flow.server.js";
import type * as Publisher from "./sync/offer-publisher.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

/**
 * Characterizes the admin offer detail `publish` intent against a real database; only Shopify
 * (the shop publish and the theme/experiment warnings) is faked.
 */
const SHOP = "publish-intent.myshopify.com";
const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));
const publishOffersForShop = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "ok" as string));
const getPublishWarnings = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as string[]));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: SHOP, accessToken: "tok" },
  }),
}));
vi.mock("../shopify.server.js", () => ({ authenticate: { admin: async () => ({ session: { shop: SHOP } }) } }));
vi.mock("@promo/db", async (importOriginal) => ({ ...(await importOriginal<typeof PromoDb>()), getDb: () => ctx.db }));
vi.mock("./sync/offer-publisher.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Publisher>()),
  publishOffersForShop,
}));
vi.mock("./offer-publish-flow.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PublishFlow>()),
  getPublishWarnings,
}));
vi.mock("./offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("./publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const detail = await import("../routes/app.offers.$id._index.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, SHOP);
  ctx.shopId = shopId;
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publishOffersForShop.mockReset();
  publishOffersForShop.mockResolvedValue("ok");
  getPublishWarnings.mockReset();
  getPublishWarnings.mockResolvedValue([]);
});

const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const publish = (id: string, extra: Record<string, string> = {}) => {
  const body = new URLSearchParams({ intent: "publish", ...extra });
  return (detail.action as unknown as (a: unknown) => Promise<unknown>)({
    request: new Request(`http://localhost/app/offers/${id}`, { method: "POST", body }),
    params: { id },
    context: {},
  });
};
const row = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const versions = (id: string) => db.select().from(offerVersions).where(eq(offerVersions.offerId, id));
const audits = (id: string) => db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function publishable(overrides: Partial<typeof offers.$inferInsert> = {}, withReward = true, withCondition = true) {
  const id = await seedOffer(db, shopId, { status: "draft", ...overrides });
  if (withCondition) {
    await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true });
  }
  if (withReward) {
    await db.insert(offerRewards).values({
      shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
      target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
    });
  }
  return id;
}

describe("admin Publish intent", () => {
  it("publishes a draft: active status, one publish, a version snapshot and an audit row by the shop", async () => {
    const id = await publishable({ startsAt: days(-1) });
    const result = await publish(id);
    expect(result).toEqual({ success: true });
    expect((await row(id)).status).toBe("active");
    expect(publishOffersForShop).toHaveBeenCalledTimes(1);
    const [version] = await versions(id);
    expect(version).toMatchObject({ versionNumber: 1, createdBy: SHOP });
    expect(version!.snapshot).toMatchObject({ offer: { id }, conditions: [expect.anything()], rewards: [expect.anything()], combinationPolicy: null });
    await tick();
    const [log] = await audits(id);
    expect(log).toMatchObject({ action: "publish", performedBy: SHOP, before: { status: "draft" }, after: { status: "active" } });
  });

  it("a future start schedules it; a second publish numbers the version 2", async () => {
    const id = await publishable({ startsAt: days(3) });
    await publish(id);
    expect((await row(id)).status).toBe("scheduled");
    await db.update(offers).set({ status: "draft" }).where(eq(offers.id, id));
    await publish(id);
    expect((await versions(id)).map((v) => v.versionNumber).sort()).toEqual([1, 2]);
  });

  it("republishing a non-draft offer still sets the schedule-aware status", async () => {
    const id = await publishable({ status: "paused", startsAt: days(-1) });
    await publish(id);
    expect((await row(id)).status).toBe("active");
  });

  it("needs a main condition, then a reward (gift offers get their own wording); nothing is published or changed", async () => {
    const noCondition = await publishable({}, true, false);
    expect(await publish(noCondition)).toEqual({ error: "Cannot publish: add at least one main condition before publishing." });
    const noReward = await publishable({ type: "gift" }, false);
    expect(await publish(noReward)).toEqual({ error: "Cannot publish: Add a gift reward before publishing." });
    const noRewardOther = await publishable({ type: "discount" }, false);
    expect(await publish(noRewardOther)).toEqual({ error: "Cannot publish: add at least one reward before publishing." });
    for (const id of [noCondition, noReward, noRewardOther]) {
      expect((await row(id)).status).toBe("draft");
      expect(await versions(id)).toHaveLength(0);
    }
    expect(publishOffersForShop).not.toHaveBeenCalled();
  });

  it("returns the advisory warnings first without publishing, then publishes once acknowledged", async () => {
    const id = await publishable({ startsAt: days(-1) });
    getPublishWarnings.mockResolvedValueOnce(['Template "page.gone" is not in your published theme.']);
    expect(await publish(id)).toEqual({ warnings: ['Template "page.gone" is not in your published theme.'] });
    expect(getPublishWarnings).toHaveBeenCalledWith(expect.anything(), shopId, id, { shopDomain: SHOP, accessToken: "tok" });
    expect((await row(id)).status).toBe("draft");
    expect(publishOffersForShop).not.toHaveBeenCalled();
    await publish(id, { acknowledgeWarnings: "1" });
    expect((await row(id)).status).toBe("active");
    expect(getPublishWarnings).toHaveBeenCalledTimes(1);
  });

  it("a failed Shopify publish returns its message, puts the previous status back and records no version or audit", async () => {
    const id = await publishable({ startsAt: days(-1) });
    publishOffersForShop.mockRejectedValueOnce(new Error("Shopify unavailable"));
    expect(await publish(id)).toEqual({ error: "Shopify unavailable" });
    expect((await row(id)).status).toBe("draft");
    expect(await versions(id)).toHaveLength(0);
    await tick();
    expect(await audits(id)).toHaveLength(0);
  });
});

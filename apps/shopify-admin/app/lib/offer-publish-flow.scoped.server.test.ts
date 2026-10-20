import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { auditLogs, offerConditions, offerRewards, offers, shops, type Db } from "@promo/db";
import type * as Publisher from "./sync/offer-publisher.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const publishOffersForShop = vi.hoisted(() => vi.fn());
vi.mock("./sync/offer-publisher.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Publisher>()),
  publishOffersForShop,
}));
vi.mock("./offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("@sentry/node", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { finalizeCreatedOffer, republishIfActive, validateActivation } = await import("./offer-publish-flow.server.js");
const { OfferPublishError, getOfferPublishErrors } = await import("./offer-publish-errors.server.js");

const DOMAIN = "scoped-shop.myshopify.com";
let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, DOMAIN);
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publishOffersForShop.mockReset();
  publishOffersForShop.mockResolvedValue("published");
  vi.mocked(Sentry.captureMessage).mockClear();
});

async function seed(
  status: "active" | "draft",
  condition: { conditionType: string; operator?: "gte" | "eq" | "any"; value: unknown } = {
    conditionType: "cart_value",
    value: { thresholdCents: 100, currencyCode: "USD", includeGiftValues: false },
  },
  withReward = true,
) {
  const id = await seedOffer(db, shopId, { status });
  await db.insert(offerConditions).values({
    shopId,
    offerId: id,
    scope: "main",
    conditionType: condition.conditionType,
    operator: condition.operator ?? "gte",
    value: condition.value,
    sortOrder: 0,
    isEnabled: true,
  });
  if (withReward) {
    await db.insert(offerRewards).values({
      shopId,
      offerId: id,
      rewardType: "product_gift",
      discountType: "percentage",
      value: { amount: 10 },
      target: { productId: "gid://shopify/Product/1" },
      quantity: 1,
    });
  }
  return id;
}

const statusOf = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!.status;
const auditFor = (id: string) => db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
const pendingAt = async () => (await db.select().from(shops).where(eq(shops.id, shopId)))[0]!.publishPendingAt;

describe("republishIfActive scopes a publish failure", () => {
  it("keeps an active offer active on a shop-wide error, records it, audits it and retries", async () => {
    const id = await seed("active");
    publishOffersForShop.mockRejectedValue(new Error("Function config is 12000B, exceeding the safe 9500B limit."));

    const message = await republishIfActive(db, shopId, DOMAIN, id, true);

    expect(message).toContain("12000B");
    expect(message).toContain("retried");
    expect(await statusOf(id)).toBe("active");
    expect((await getOfferPublishErrors(shopId, db))[id]).toContain("12000B");
    expect(await pendingAt()).not.toBeNull();
    const [row] = await auditFor(id);
    expect(row).toMatchObject({ action: "publish_failed", performedBy: "system" });
    expect(row!.after).toMatchObject({ scope: "shop", reason: "shop_publish_error" });
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });

  it("pauses the edited offer when its own compile fails, with an audit row and a stored error", async () => {
    const id = await seed("active");
    publishOffersForShop.mockRejectedValueOnce(new OfferPublishError(id, "bad reward")).mockResolvedValue("published");

    const message = await republishIfActive(db, shopId, DOMAIN, id, true);

    expect(message).toContain("paused");
    expect(await statusOf(id)).toBe("paused");
    expect((await getOfferPublishErrors(shopId, db))[id]).toBe("bad reward");
    const rows = await auditFor(id);
    expect(rows).toEqual([expect.objectContaining({ action: "system_pause", performedBy: "system" })]);
    expect(rows[0]!.before).toEqual({ status: "active" });
    expect(rows[0]!.after).toMatchObject({ status: "paused", reason: "compile_error", error: "bad reward" });
  });

  it("does not pause the edited offer when another offer is the one that fails to compile", async () => {
    const edited = await seed("active");
    const other = await seed("active");
    publishOffersForShop.mockRejectedValue(new OfferPublishError(other, "other is broken"));

    await republishIfActive(db, shopId, DOMAIN, edited, true);

    expect(await statusOf(edited)).toBe("active");
    expect(await statusOf(other)).toBe("active");
    const errors = await getOfferPublishErrors(shopId, db);
    expect(errors[other]).toBe("other is broken");
    expect(errors[edited]).toBe("other is broken");
  });

  it("pauses an offer that fails its own validation and audits the reason", async () => {
    const id = await seed("active", undefined, false);

    const message = await republishIfActive(db, shopId, DOMAIN, id, true);

    expect(message).toContain("paused");
    expect(await statusOf(id)).toBe("paused");
    const [row] = await auditFor(id);
    expect(row).toMatchObject({ action: "system_pause" });
    expect(row!.after).toMatchObject({ reason: "validation_error" });
  });
});

describe("finalizeCreatedOffer", () => {
  it("keeps a new active offer on a shop-wide publish error", async () => {
    const id = await seed("active");
    publishOffersForShop.mockRejectedValue(new Error("Shopify is down"));

    const message = await finalizeCreatedOffer(db, shopId, DOMAIN, id, "active");

    expect(message).toContain("Shopify is down");
    expect(await statusOf(id)).toBe("active");
    expect((await auditFor(id))[0]).toMatchObject({ action: "publish_failed" });
  });

  it("sends an offer that fails validation back to draft with an audit row", async () => {
    const id = await seed("active", undefined, false);

    await finalizeCreatedOffer(db, shopId, DOMAIN, id, "active");

    expect(await statusOf(id)).toBe("draft");
    expect((await auditFor(id))[0]).toMatchObject({ action: "system_draft" });
  });
});

describe("validateActivation preflights the would-be shop config", () => {
  beforeEach(async () => {
    await db.update(offers).set({ status: "archived" }).where(eq(offers.shopId, shopId));
  });

  it("rejects a 4th cart-attribute key and names the offers that use the keys", async () => {
    const attr = (key: string) => ({ conditionType: "cart_attribute", operator: "eq" as const, value: { key, matchMode: "exists" } });
    await seed("active", attr("k1"));
    await seed("active", attr("k2"));
    await seed("active", attr("k3"));
    const fourth = await seed("draft", attr("k4"));

    const result = await validateActivation(db, shopId, [fourth]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cart attribute keys");
    expect(result.scope).toBe("shop");
    expect(await statusOf(fourth)).toBe("draft");
  });

  it("rejects an activation that pushes the shared config over the byte cap", async () => {
    const heavy = (n: number) => ({
      conditionType: "specific_product",
      operator: "any" as const,
      value: {
        requirements: Array.from({ length: 80 }, (_, i) => ({
          variantId: `gid://shopify/ProductVariant/${n}000000${i}`,
          trackMode: "variant",
          minQuantity: 1,
        })),
      },
    });
    await seed("active", heavy(1));
    await seed("active", heavy(2));
    const third = await seed("draft", heavy(3));

    const result = await validateActivation(db, shopId, [third]);

    expect(result).toMatchObject({ ok: false, scope: "shop" });
    expect(result.error).toContain("over the 9500B limit");
  });

  it("accepts a small activation", async () => {
    const id = await seed("draft");
    expect(await validateActivation(db, shopId, [id])).toEqual({ ok: true });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import type * as OfferPublisher from "./sync/offer-publisher.server.js";

/**
 * Characterization of the offer lifecycle admin actions against a real Postgres. Only the Shopify
 * side (the publisher) is mocked; validation, status writes, rollbacks and audit rows are real.
 * These tests must pass unchanged before and after the logic moves into offer-lifecycle.server.ts.
 */
const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));
const publishOffersForShop = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "published" as string));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "life-shop.myshopify.com" },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: "life-shop.myshopify.com" } }) },
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => ctx.db,
}));
vi.mock("./sync/offer-publisher.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OfferPublisher>()),
  publishOffersForShop,
}));
vi.mock("./offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("./publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const list = await import("../routes/app.offers._index.js");
const schedule = await import("../routes/app.offers.$id.schedule.js");
const conditions = await import("../routes/app.offers.$id.conditions.js");
const { OfferPublishError } = await import("./offer-publish-errors.server.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, "life-shop.myshopify.com");
  ctx.shopId = shopId;
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publishOffersForShop.mockReset();
  publishOffersForShop.mockResolvedValue("published");
});

const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const post = (url: string, fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
  return new Request(`http://localhost${url}`, { method: "POST", body });
};
const row = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<unknown>)({ request, params, context: {} });
const audits = (entityId: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.entityId, entityId)));
const waitAudit = async (entityId: string, action: string) => {
  await vi.waitFor(async () => {
    expect((await audits(entityId)).some((a) => a.action === action)).toBe(true);
  });
  return (await audits(entityId)).filter((a) => a.action === action);
};

async function publishable(overrides: Partial<typeof offers.$inferInsert> = {}) {
  const id = await seedOffer(db, shopId, { status: "draft", ...overrides });
  await db.insert(offerConditions).values({
    shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte",
    value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true,
  });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 }, target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
  });
  return id;
}

describe("toggle_status", () => {
  it("pauses an active offer, publishes the shop and audits before/after", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    const result = await run(list.action, post("/app/offers", { intent: "toggle_status", offerId: id }));
    expect(result).toBeNull();
    expect((await row(id)).status).toBe("paused");
    expect(publishOffersForShop).toHaveBeenCalledWith(shopId, "life-shop.myshopify.com");
    const [entry] = await waitAudit(id, "toggle_status");
    expect(entry).toMatchObject({
      entityType: "offer",
      before: { status: "active" },
      after: { status: "paused" },
      performedBy: "life-shop.myshopify.com",
    });
  });

  it("resumes a paused offer through validateActivation and honours the schedule", async () => {
    const live = await publishable({ status: "paused" });
    const future = await publishable({ status: "paused", startsAt: days(3) });
    const ended = await publishable({ status: "paused", startsAt: days(-5), endsAt: days(-1) });
    for (const id of [live, future, ended]) await run(list.action, post("/app/offers", { intent: "toggle_status", offerId: id }));
    expect((await row(live)).status).toBe("active");
    expect((await row(future)).status).toBe("scheduled");
    expect((await row(ended)).status).toBe("expired");
    await waitAudit(live, "toggle_status");
  });

  it("returns the validation error and changes nothing when the offer cannot be activated", async () => {
    const id = await seedOffer(db, shopId, { status: "paused" });
    const result = (await run(list.action, post("/app/offers", { intent: "toggle_status", offerId: id }))) as { error: string };
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    expect((await row(id)).status).toBe("paused");
    expect(publishOffersForShop).not.toHaveBeenCalled();
    expect(await audits(id)).toHaveLength(0);
  });

  it("returns Offer not found for an unknown id", async () => {
    const result = await run(list.action, post("/app/offers", { intent: "toggle_status", offerId: "00000000-0000-4000-8000-000000000000" }));
    expect(result).toEqual({ error: "Offer not found" });
    expect(publishOffersForShop).not.toHaveBeenCalled();
  });

  it("rolls the status back and writes no audit row when the publish fails (a whole-shop error included)", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    publishOffersForShop.mockRejectedValueOnce(new Error("Shopify unavailable"));
    const result = await run(list.action, post("/app/offers", { intent: "toggle_status", offerId: id }));
    expect(result).toEqual({ error: "Shopify unavailable" });
    expect((await row(id)).status).toBe("active");
    await new Promise((r) => setTimeout(r, 50));
    expect(await audits(id)).toHaveLength(0);
  });

  it("does not overwrite a status changed concurrently when rolling back", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    publishOffersForShop.mockImplementationOnce(async () => {
      await db.update(offers).set({ status: "expired" }).where(eq(offers.id, id));
      throw new Error("boom");
    });
    await run(list.action, post("/app/offers", { intent: "toggle_status", offerId: id }));
    expect((await row(id)).status).toBe("expired");
  });
});

describe("archive", () => {
  it("archives, stamps archivedAt and publishes", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    const result = await run(list.action, post("/app/offers", { intent: "archive", offerId: id }));
    expect(result).toBeNull();
    const after = await row(id);
    expect(after.status).toBe("archived");
    expect(after.archivedAt).toBeInstanceOf(Date);
    expect(publishOffersForShop).toHaveBeenCalledTimes(1);
  });

  it("restores status and archivedAt and returns the error when the publish fails", async () => {
    const id = await seedOffer(db, shopId, { status: "paused" });
    publishOffersForShop.mockRejectedValueOnce(new Error("Shopify unavailable"));
    const result = await run(list.action, post("/app/offers", { intent: "archive", offerId: id }));
    expect(result).toEqual({ error: "Shopify unavailable" });
    const after = await row(id);
    expect(after.status).toBe("paused");
    expect(after.archivedAt).toBeNull();
  });
});

describe("bulk actions", () => {
  it("bulk_pause pauses every selected offer, publishes once and audits the batch", async () => {
    const a = await seedOffer(db, shopId, { status: "active" });
    const b = await seedOffer(db, shopId, { status: "scheduled", startsAt: days(2) });
    const result = await run(list.action, post("/app/offers", { intent: "bulk_pause", "offerIds[]": [a, b] }));
    expect(result).toBeNull();
    expect((await row(a)).status).toBe("paused");
    expect((await row(b)).status).toBe("paused");
    expect(publishOffersForShop).toHaveBeenCalledTimes(1);
    const [entry] = await waitAudit([a, b].join(","), "bulk_pause");
    expect(entry!.after).toEqual({ offerIds: [a, b] });
  });

  it("bulk_pause restores each previous status when the publish fails", async () => {
    const a = await seedOffer(db, shopId, { status: "active" });
    const b = await seedOffer(db, shopId, { status: "scheduled", startsAt: days(2) });
    publishOffersForShop.mockRejectedValueOnce(new Error("Shopify unavailable"));
    const result = await run(list.action, post("/app/offers", { intent: "bulk_pause", "offerIds[]": [a, b] }));
    expect(result).toEqual({ error: "Shopify unavailable" });
    expect((await row(a)).status).toBe("active");
    expect((await row(b)).status).toBe("scheduled");
  });

  it("bulk_activate sets each offer by its dates and audits", async () => {
    const now = await publishable({ status: "draft" });
    const future = await publishable({ status: "paused", startsAt: days(3) });
    await run(list.action, post("/app/offers", { intent: "bulk_activate", "offerIds[]": [now, future] }));
    expect((await row(now)).status).toBe("active");
    expect((await row(future)).status).toBe("scheduled");
    await waitAudit([now, future].join(","), "bulk_activate");
  });

  it("bulk_activate returns the validation error and changes nothing", async () => {
    const good = await publishable({ status: "draft" });
    const bad = await seedOffer(db, shopId, { status: "draft" });
    const result = (await run(list.action, post("/app/offers", { intent: "bulk_activate", "offerIds[]": [good, bad] }))) as { error: string };
    expect(result.error.length).toBeGreaterThan(0);
    expect((await row(good)).status).toBe("draft");
    expect((await row(bad)).status).toBe("draft");
    expect(publishOffersForShop).not.toHaveBeenCalled();
  });

  it("bulk_activate restores previous statuses when the publish fails", async () => {
    const a = await publishable({ status: "draft" });
    const b = await publishable({ status: "paused" });
    publishOffersForShop.mockRejectedValueOnce(new Error("Shopify unavailable"));
    const result = await run(list.action, post("/app/offers", { intent: "bulk_activate", "offerIds[]": [a, b] }));
    expect(result).toEqual({ error: "Shopify unavailable" });
    expect((await row(a)).status).toBe("draft");
    expect((await row(b)).status).toBe("paused");
  });
});

describe("schedule save", () => {
  const save = (id: string, fields: Record<string, string>) =>
    run(schedule.action, post(`/app/offers/${id}/schedule`, fields), { id });

  it("converts local times in the posted timezone and moves an active offer to scheduled, republishing", async () => {
    const id = await publishable({ status: "active", timezone: "UTC" });
    const result = await save(id, { starts_at: "2099-01-01T09:00", ends_at: "", timezone: "America/Argentina/Buenos_Aires" });
    expect(result).toEqual({ success: true });
    const after = await row(id);
    expect(after.status).toBe("scheduled");
    expect(after.startsAt!.toISOString()).toBe("2099-01-01T12:00:00.000Z");
    expect(after.timezone).toBe("America/Argentina/Buenos_Aires");
    expect(publishOffersForShop).toHaveBeenCalledTimes(1);
  });

  it("does not publish when the offer was and stays inactive (a draft keeps its status)", async () => {
    const id = await seedOffer(db, shopId, { status: "draft" });
    const result = await save(id, { starts_at: "2099-01-01T09:00", ends_at: "2099-02-01T09:00", timezone: "UTC" });
    expect(result).toEqual({ success: true });
    expect((await row(id)).status).toBe("draft");
    expect(publishOffersForShop).not.toHaveBeenCalled();
  });

  it("quirk: saving a future start on a paused offer turns it into scheduled (statusForScheduleSave does not protect paused)", async () => {
    const id = await publishable({ status: "paused" });
    expect(await save(id, { starts_at: "2099-01-01T09:00", ends_at: "", timezone: "UTC" })).toEqual({ success: true });
    expect((await row(id)).status).toBe("scheduled");
    expect(publishOffersForShop).not.toHaveBeenCalled();
  });

  it("rejects an invalid timezone and an end before the start without writing", async () => {
    const id = await seedOffer(db, shopId, { status: "paused" });
    expect(await save(id, { starts_at: "", ends_at: "", timezone: "Not/AZone" })).toEqual({ error: "Timezone is invalid." });
    expect(await save(id, { starts_at: "2099-02-01T09:00", ends_at: "2099-01-01T09:00", timezone: "UTC" })).toEqual({
      error: "End date must be after start date.",
    });
    expect(await save(id, { starts_at: "", ends_at: "2099-01-01T09:00", timezone: "UTC" })).toEqual({
      error: "Set a start date before setting an end date.",
    });
    expect((await row(id)).startsAt).toBeNull();
  });

  it("validates activation when the save would turn an expired offer back on", async () => {
    const id = await seedOffer(db, shopId, { status: "expired", startsAt: days(-10), endsAt: days(-5) });
    const result = (await save(id, { starts_at: "", ends_at: "", timezone: "UTC" })) as { error: string };
    expect(result.error.length).toBeGreaterThan(0);
    expect((await row(id)).status).toBe("expired");
  });

  it("a whole-shop publish error keeps the offer active and says it will be retried (2026-10-20 rule)", async () => {
    const id = await publishable({ status: "active" });
    publishOffersForShop.mockRejectedValueOnce(new Error("Shopify unavailable"));
    const result = (await save(id, { starts_at: "2020-01-01T09:00", ends_at: "2099-01-01T09:00", timezone: "UTC" })) as { error: string };
    expect(result.error).toContain("Shopify unavailable");
    expect(result.error).toContain("keeps its status");
    const after = await row(id);
    expect(after.status).toBe("active");
    expect(after.endsAt!.toISOString()).toBe("2099-01-01T09:00:00.000Z");
  });

  it("an offer-scoped compile error pauses the edited offer", async () => {
    const id = await publishable({ status: "active" });
    publishOffersForShop.mockRejectedValueOnce(new OfferPublishError(id, "cannot compile"));
    publishOffersForShop.mockResolvedValue("published");
    const result = (await save(id, { starts_at: "2020-01-01T09:00", ends_at: "2099-01-01T09:00", timezone: "UTC" })) as { error: string };
    expect(result.error).toContain("cannot compile");
    expect(result.error).toContain("paused");
    expect((await row(id)).status).toBe("paused");
  });

  it("404s for an unknown offer", async () => {
    await expect(save("00000000-0000-4000-8000-000000000000", { starts_at: "", ends_at: "", timezone: "UTC" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("store pages condition (excludeUrls / pageUrls)", () => {
  async function pageOffer(status: string) {
    const id = await publishable({ status: status as "active" });
    const [cond] = await db
      .insert(offerConditions)
      .values({
        shopId, offerId: id, scope: "sub", conditionType: "page_types", operator: "gte",
        value: { pageTypes: ["page", "product"] }, sortOrder: 5, isEnabled: true,
      })
      .returning({ id: offerConditions.id });
    return { id, conditionId: cond!.id };
  }
  const update = (id: string, conditionId: string, fields: Record<string, string | string[]>) =>
    run(
      conditions.action,
      post(`/app/offers/${id}/conditions`, { intent: "update_condition", conditionId, conditionType: "page_types", scope: "sub", pageTypes: ["page", "product"], ...fields }),
      { id },
    );
  const stored = async (conditionId: string) =>
    (await db.select().from(offerConditions).where(eq(offerConditions.id, conditionId)))[0]!.value as Record<string, unknown>;

  it("normalizes, de-duplicates and stores the lists, then republishes an active offer", async () => {
    const { id, conditionId } = await pageOffer("active");
    const result = await update(id, conditionId, {
      excludeUrls: ["https://shop.com/products/Hat?v=1", "/products/hat/", "/cart"],
      pageUrls: ["/Pages/About/"],
    });
    expect(result).toEqual({ success: true });
    expect(await stored(conditionId)).toMatchObject({
      pageTypes: ["page", "product"],
      excludeUrls: ["/products/hat", "/cart"],
      pageUrls: ["/pages/about"],
    });
    expect(publishOffersForShop).toHaveBeenCalledTimes(1);
  });

  it("does not publish for an inactive offer", async () => {
    const { id, conditionId } = await pageOffer("paused");
    await update(id, conditionId, { excludeUrls: ["/cart"] });
    expect(publishOffersForShop).not.toHaveBeenCalled();
    expect((await stored(conditionId))["excludeUrls"]).toEqual(["/cart"]);
  });

  it("rejects more than 100 exclusions and entries longer than 300 characters", async () => {
    const { id, conditionId } = await pageOffer("paused");
    const tooMany = Array.from({ length: 101 }, (_, i) => `/products/p${i}`);
    const many = (await update(id, conditionId, { excludeUrls: tooMany })) as { error: string };
    expect(many.error.length).toBeGreaterThan(0);
    const long = (await update(id, conditionId, { excludeUrls: [`/${"a".repeat(301)}`] })) as { error: string };
    expect(long.error.length).toBeGreaterThan(0);
    expect((await stored(conditionId))["excludeUrls"]).toBeUndefined();
  });

  it("a whole-shop publish error leaves the active offer active", async () => {
    const { id, conditionId } = await pageOffer("active");
    publishOffersForShop.mockRejectedValueOnce(new Error("Shopify unavailable"));
    const result = (await update(id, conditionId, { excludeUrls: ["/cart"] })) as { error: string };
    expect(result.error).toContain("keeps its status");
    expect((await row(id)).status).toBe("active");
  });
});

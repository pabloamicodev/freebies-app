import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import {
  archiveOffer,
  bulkPauseOffers,
  bulkResumeOffers,
  pauseOffer,
  republishShop,
  resumeOffer,
  setOfferPageUrls,
  setOfferSchedule,
  toggleOfferStatus,
  type ShopPublishFn,
} from "./offer-lifecycle.server.js";

vi.mock("./offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("./publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const DOMAIN = "svc-shop.myshopify.com";
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

const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const ok: ShopPublishFn = async () => null;
const okSpy = () => vi.fn<ShopPublishFn>(async () => null);
const failing = (message = "Shopify unavailable") => vi.fn<ShopPublishFn>(async () => ({ message, scope: "shop" }));
const ctx = (offerId: string) => ({ shopId, shopDomain: DOMAIN, offerId });
const opts = { performedBy: `mcp:op-1`, publish: ok };
const row = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const audits = (entityId: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.entityId, entityId)));

async function publishable(overrides: Partial<typeof offers.$inferInsert> = {}) {
  const id = await seedOffer(db, shopId, { status: "draft", ...overrides });
  await db.insert(offerConditions).values({
    shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte",
    value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true,
  });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
    target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
  });
  return id;
}

describe("pauseOffer / resumeOffer", () => {
  it("pauses, publishes once and audits with performedBy and auditExtra", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    const publish = okSpy();
    const extra = { _mcp: { operator: "op-1", tool: "promo_pause" } };
    const result = await pauseOffer(db, ctx(id), { performedBy: "mcp:op-1", publish, auditExtra: extra });
    expect(result).toMatchObject({ ok: true, dryRun: false, statusBefore: "active", statusAfter: "paused", changed: true });
    expect((await row(id)).status).toBe("paused");
    expect(publish).toHaveBeenCalledWith(shopId, DOMAIN);
    const [entry] = await audits(id);
    expect(entry).toMatchObject({ action: "pause", performedBy: "mcp:op-1", before: { status: "active" }, after: { status: "paused", ...extra } });
  });

  it("dryRun computes the outcome and writes nothing: no update, publish or audit", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    const before = await row(id);
    const publish = okSpy();
    const result = await pauseOffer(db, ctx(id), { performedBy: "x", publish, dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, statusBefore: "active", statusAfter: "paused" });
    expect(result.ok && result.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await row(id)).status).toBe("active");
    expect(publish).not.toHaveBeenCalled();
    expect(await audits(id)).toHaveLength(0);
  });

  it("returns the offer's updatedAt and refuses a stale expectedUpdatedAt", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    const dry = await pauseOffer(db, ctx(id), { ...opts, dryRun: true });
    const updatedAt = dry.ok ? dry.updatedAt : new Date(0);
    await db.update(offers).set({ updatedAt: new Date(updatedAt.getTime() + 5000) }).where(eq(offers.id, id));
    const stale = await pauseOffer(db, ctx(id), { ...opts, expectedUpdatedAt: updatedAt });
    expect(stale).toMatchObject({ ok: false, code: "state", reason: "stale" });
    expect((await row(id)).status).toBe("active");
  });

  it("rolls the status back and skips the audit when the publish fails (shop-wide error included)", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    const result = await pauseOffer(db, ctx(id), { performedBy: "x", publish: failing() });
    expect(result).toEqual({ ok: false, code: "publish_failed", error: "Shopify unavailable", rolledBack: true, statusBefore: "active", statusAfter: "active" });
    expect((await row(id)).status).toBe("active");
    expect(await audits(id)).toHaveLength(0);
  });

  it("rollback leaves a status changed concurrently alone", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    const publish: ShopPublishFn = async () => {
      await db.update(offers).set({ status: "expired" }).where(eq(offers.id, id));
      return { message: "boom", scope: "shop" };
    };
    await pauseOffer(db, ctx(id), { performedBy: "x", publish });
    expect((await row(id)).status).toBe("expired");
  });

  it("pause refuses an offer that is not live; resume refuses one that is not paused", async () => {
    const paused = await seedOffer(db, shopId, { status: "paused" });
    const active = await seedOffer(db, shopId, { status: "active" });
    expect(await pauseOffer(db, ctx(paused), opts)).toMatchObject({ ok: false, code: "state", reason: "invalid_status" });
    expect(await resumeOffer(db, ctx(active), opts)).toMatchObject({ ok: false, code: "state", reason: "invalid_status" });
  });

  it("resume validates activation and respects the schedule", async () => {
    const live = await publishable({ status: "paused" });
    const future = await publishable({ status: "paused", startsAt: days(3) });
    const ended = await publishable({ status: "paused", startsAt: days(-5), endsAt: days(-1) });
    const outcomes = await Promise.all([live, future, ended].map((id) => resumeOffer(db, ctx(id), opts)));
    expect(outcomes.map((r) => r.ok && r.statusAfter)).toEqual(["active", "scheduled", "expired"]);
    expect((await audits(live))[0]).toMatchObject({ action: "resume", before: { status: "paused" }, after: { status: "active" } });
  });

  it("resume returns a validation failure for an unpublishable offer and dryRun reports it without writing", async () => {
    const id = await seedOffer(db, shopId, { status: "paused" });
    const publish = okSpy();
    const result = await resumeOffer(db, ctx(id), { performedBy: "x", publish, dryRun: true });
    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(publish).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe("paused");
  });

  it("returns not_found for an unknown or foreign-shop offer", async () => {
    expect(await pauseOffer(db, ctx("00000000-0000-4000-8000-000000000000"), opts)).toEqual({ ok: false, code: "not_found" });
    const otherShop = await seedShop(db, "other-shop.myshopify.com");
    const foreign = await seedOffer(db, otherShop, { status: "active" });
    expect(await pauseOffer(db, ctx(foreign), opts)).toEqual({ ok: false, code: "not_found" });
    expect((await row(foreign)).status).toBe("active");
  });

  it("toggleOfferStatus pauses an active offer and keeps the admin's toggle_status audit action", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    await toggleOfferStatus(db, ctx(id), opts);
    expect((await row(id)).status).toBe("paused");
    expect((await audits(id))[0]!.action).toBe("toggle_status");
  });
});

describe("archiveOffer", () => {
  it("archives, stamps archivedAt, publishes and audits", async () => {
    const id = await seedOffer(db, shopId, { status: "active" });
    const publish = okSpy();
    const result = await archiveOffer(db, ctx(id), { performedBy: "mcp:op-1", publish });
    expect(result).toMatchObject({ ok: true, statusBefore: "active", statusAfter: "archived" });
    const after = await row(id);
    expect(after.status).toBe("archived");
    expect(after.archivedAt).toBeInstanceOf(Date);
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await audits(id))[0]).toMatchObject({ action: "archive", performedBy: "mcp:op-1" });
  });

  it("restores status and archivedAt on publish failure; dryRun and already-archived write nothing", async () => {
    const id = await seedOffer(db, shopId, { status: "paused" });
    expect(await archiveOffer(db, ctx(id), { performedBy: "x", publish: failing() })).toMatchObject({
      ok: false, code: "publish_failed", rolledBack: true,
    });
    const restored = await row(id);
    expect(restored.status).toBe("paused");
    expect(restored.archivedAt).toBeNull();
    expect(await archiveOffer(db, ctx(id), { ...opts, dryRun: true })).toMatchObject({ ok: true, dryRun: true, statusAfter: "archived" });
    expect((await row(id)).status).toBe("paused");
    const archived = await seedOffer(db, shopId, { status: "archived", archivedAt: new Date() });
    expect(await archiveOffer(db, ctx(archived), opts)).toMatchObject({ ok: false, code: "state", reason: "already_in_state" });
  });
});

describe("bulk", () => {
  it("bulkPauseOffers pauses all, audits the batch and restores each status on publish failure", async () => {
    const a = await seedOffer(db, shopId, { status: "active" });
    const b = await seedOffer(db, shopId, { status: "scheduled", startsAt: days(2) });
    expect(await bulkPauseOffers(db, { shopId, shopDomain: DOMAIN, offerIds: [a, b] }, { performedBy: "x", publish: failing() })).toMatchObject({
      ok: false, code: "publish_failed", rolledBack: true,
    });
    expect([(await row(a)).status, (await row(b)).status]).toEqual(["active", "scheduled"]);
    const done = await bulkPauseOffers(db, { shopId, shopDomain: DOMAIN, offerIds: [a, b] }, opts);
    expect(done.ok && done.offers.map((o) => o.statusAfter)).toEqual(["paused", "paused"]);
    expect((await audits([a, b].join(",")))[0]).toMatchObject({ action: "bulk_pause", after: { offerIds: [a, b] } });
  });

  it("bulkResumeOffers reports advisory warnings per offer on a dry run, skips live offers and audits them on execution", async () => {
    const paused = await publishable({ status: "paused" });
    const live = await publishable({ status: "active" });
    const publishWarningsFor = vi.fn(async (id: string) => [`warn ${id}`]);
    const ctx = { shopId, shopDomain: DOMAIN, offerIds: [paused, live] };
    const dry = await bulkResumeOffers(db, ctx, { ...opts, dryRun: true, publishWarningsFor });
    expect(dry.ok && dry.offers.map((o) => o.warnings)).toEqual([[`warn ${paused}`], undefined]);
    expect((await row(paused)).status).toBe("paused");
    const done = await bulkResumeOffers(db, ctx, { ...opts, publishWarningsFor });
    expect(done.ok).toBe(true);
    expect((await row(paused)).status).toBe("active");
    expect((await audits(ctx.offerIds.join(",")))[0]!.after).toMatchObject({ warnings: { [paused]: [`warn ${paused}`] } });
  });

  it("bulkResumeOffers validates all first and honours each offer's dates", async () => {
    const now = await publishable({ status: "draft" });
    const future = await publishable({ status: "paused", startsAt: days(3) });
    const bad = await seedOffer(db, shopId, { status: "draft" });
    expect(await bulkResumeOffers(db, { shopId, shopDomain: DOMAIN, offerIds: [now, bad] }, opts)).toMatchObject({ ok: false, code: "validation" });
    expect((await row(now)).status).toBe("draft");
    await bulkResumeOffers(db, { shopId, shopDomain: DOMAIN, offerIds: [now, future] }, opts);
    expect([(await row(now)).status, (await row(future)).status]).toEqual(["active", "scheduled"]);
  });
});

describe("setOfferSchedule", () => {
  const sched = (id: string, extra: Record<string, unknown>, o: Partial<Parameters<typeof setOfferSchedule>[2]> = {}) =>
    setOfferSchedule(db, { ...ctx(id), ...extra }, { ...opts, ...o });

  it("interprets local times in the given timezone, moves an active offer to scheduled and republishes", async () => {
    const id = await publishable({ status: "active" });
    const publish = okSpy();
    const result = await sched(id, { startsAt: "2099-01-01T09:00", endsAt: null, timezone: "America/Argentina/Buenos_Aires" }, { publish });
    expect(result).toMatchObject({ ok: true, statusBefore: "active", statusAfter: "scheduled" });
    const after = await row(id);
    expect(after.startsAt!.toISOString()).toBe("2099-01-01T12:00:00.000Z");
    expect(after.timezone).toBe("America/Argentina/Buenos_Aires");
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await audits(id)).map((a) => a.action)).toContain("set_schedule");
  });

  it("undefined keeps the stored value; dryRun writes nothing", async () => {
    const startsAt = new Date("2030-05-05T15:00:00.123Z");
    const id = await seedOffer(db, shopId, { status: "scheduled", timezone: "UTC", startsAt });
    const dry = await sched(id, { endsAt: "2031-01-01T00:00" }, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true });
    expect((await row(id)).endsAt).toBeNull();
    await sched(id, { endsAt: "2031-01-01T00:00" });
    const after = await row(id);
    expect(after.startsAt!.toISOString()).toBe(startsAt.toISOString());
    expect(after.endsAt!.toISOString()).toBe("2031-01-01T00:00:00.000Z");
  });

  it("validates timezone, range and activation; falls back to the shop timezone", async () => {
    const id = await seedOffer(db, shopId, { status: "expired", startsAt: days(-10), endsAt: days(-5), timezone: null });
    expect(await sched(id, { timezone: "Nope/Zone" })).toEqual({ ok: false, code: "validation", error: "Timezone is invalid." });
    expect(await sched(id, { startsAt: "2099-02-01T09:00", endsAt: "2099-01-01T09:00" })).toMatchObject({ ok: false, code: "validation", error: "End date must be after start date." });
    expect(await sched(id, { startsAt: null, endsAt: null })).toMatchObject({ ok: false, code: "validation" });
    expect((await row(id)).status).toBe("expired");
    const dated = await seedOffer(db, shopId, { status: "draft", timezone: null });
    await sched(dated, { startsAt: "2099-01-01T09:00", shopTimezone: "America/Argentina/Buenos_Aires" });
    expect((await row(dated)).startsAt!.toISOString()).toBe("2099-01-01T12:00:00.000Z");
  });

  it("a whole-shop publish error keeps the saved change and the status (2026-10-20)", async () => {
    const id = await publishable({ status: "active" });
    const result = await sched(id, { startsAt: "2020-01-01T09:00", endsAt: "2099-01-01T09:00", timezone: "UTC" }, { publish: failing() });
    expect(result).toMatchObject({ ok: false, code: "publish_failed", rolledBack: false, statusAfter: "active" });
    expect(result.ok === false && result.code === "publish_failed" && result.error).toContain("keeps its status");
    expect((await row(id)).endsAt!.toISOString()).toBe("2099-01-01T09:00:00.000Z");
  });
});

describe("setOfferPageUrls", () => {
  async function pageOffer(status: "active" | "paused", pageTypes = ["page", "product"]) {
    const id = await publishable({ status });
    const [cond] = await db
      .insert(offerConditions)
      .values({ shopId, offerId: id, scope: "sub", conditionType: "page_types", operator: "gte", value: { pageTypes, onlyMatchedLines: true }, sortOrder: 5, isEnabled: true })
      .returning({ id: offerConditions.id });
    const stored = async () => (await db.select().from(offerConditions).where(eq(offerConditions.id, cond!.id)))[0]!.value as Record<string, unknown>;
    return { id, stored };
  }

  it("normalizes like the UI, keeps other keys, republishes an active offer and audits", async () => {
    const { id, stored } = await pageOffer("active");
    const publish = okSpy();
    const result = await setOfferPageUrls(
      db,
      { ...ctx(id), excludeUrls: ["https://shop.com/products/Hat?v=1", "/products/hat/", "/cart"], pageUrls: ["/Pages/About/"] },
      { ...opts, publish },
    );
    expect(result).toMatchObject({ ok: true, details: { after: { excludeUrls: ["/products/hat", "/cart"], pageUrls: ["/pages/about"] } } });
    expect(await stored()).toMatchObject({ pageTypes: ["page", "product"], onlyMatchedLines: true, excludeUrls: ["/products/hat", "/cart"], pageUrls: ["/pages/about"] });
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await audits(id))[0]).toMatchObject({ action: "set_page_urls", performedBy: "mcp:op-1" });
  });

  it("an empty array clears the list; dryRun and inactive offers do not publish", async () => {
    const { id, stored } = await pageOffer("paused");
    const publish = okSpy();
    await setOfferPageUrls(db, { ...ctx(id), excludeUrls: ["/a"] }, { ...opts, publish });
    expect((await stored())["excludeUrls"]).toEqual(["/a"]);
    await setOfferPageUrls(db, { ...ctx(id), excludeUrls: [] }, { ...opts, publish, dryRun: true });
    expect((await stored())["excludeUrls"]).toEqual(["/a"]);
    await setOfferPageUrls(db, { ...ctx(id), excludeUrls: [] }, { ...opts, publish });
    expect((await stored())["excludeUrls"]).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it("enforces the UI limits: at most 100 exclusions of at most 300 characters", async () => {
    const { id, stored } = await pageOffer("paused");
    const many = Array.from({ length: 101 }, (_, i) => `/products/p${i}`);
    expect(await setOfferPageUrls(db, { ...ctx(id), excludeUrls: many }, opts)).toMatchObject({ ok: false, code: "validation" });
    expect(await setOfferPageUrls(db, { ...ctx(id), excludeUrls: [`/${"a".repeat(301)}`] }, opts)).toMatchObject({ ok: false, code: "validation" });
    const hundred = many.slice(0, 100);
    expect(await setOfferPageUrls(db, { ...ctx(id), excludeUrls: hundred }, opts)).toMatchObject({ ok: true });
    expect((await stored())["excludeUrls"]).toHaveLength(100);
  });

  it("rejects pageUrls without the Pages kind, and an offer without a Store pages condition", async () => {
    const { id } = await pageOffer("paused", ["product"]);
    expect(await setOfferPageUrls(db, { ...ctx(id), pageUrls: ["/pages/x"] }, opts)).toMatchObject({ ok: false, code: "validation" });
    const bare = await publishable({ status: "paused" });
    expect(await setOfferPageUrls(db, { ...ctx(bare), excludeUrls: ["/a"] }, opts)).toMatchObject({ ok: false, code: "state", reason: "no_condition" });
  });

  it("a whole-shop publish error leaves the active offer active", async () => {
    const { id } = await pageOffer("active");
    const result = await setOfferPageUrls(db, { ...ctx(id), excludeUrls: ["/a"] }, { performedBy: "x", publish: failing() });
    expect(result).toMatchObject({ ok: false, code: "publish_failed", rolledBack: false, statusAfter: "active" });
    expect((await row(id)).status).toBe("active");
  });
});

describe("republishShop", () => {
  it("publishes and audits against the shop; failure and dryRun are typed", async () => {
    const publish = okSpy();
    expect(await republishShop(db, { shopId, shopDomain: DOMAIN }, { performedBy: "mcp:op-1", publish, dryRun: true })).toEqual({ ok: true, dryRun: true });
    expect(publish).not.toHaveBeenCalled();
    expect(await republishShop(db, { shopId, shopDomain: DOMAIN }, { performedBy: "mcp:op-1", publish })).toEqual({ ok: true, dryRun: false });
    expect((await audits(shopId))[0]).toMatchObject({ entityType: "shop", action: "republish_shop", performedBy: "mcp:op-1" });
    expect(await republishShop(db, { shopId, shopDomain: DOMAIN }, { performedBy: "x", publish: failing() })).toMatchObject({
      ok: false, code: "publish_failed", rolledBack: false,
    });
  });
});

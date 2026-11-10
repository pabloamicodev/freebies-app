import type * as RedisModule from "./redis.server.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { capacityActions, capacityIncidents, offerConditions, offerRewards, offers, variantCache, type CapacityIncident, type Db } from "@promo/db";
import { applyWorkaround, followUpSyncWorkaround, reclaimAllStalePending, reclaimStalePending, STALE_PENDING_MS, undoWorkaround, type ApplyDeps } from "./capacity-apply.server.js";
import { preflightCapacity, type CapacityOptions } from "./capacity-preflight.server.js";
import { recordCapacityIncident, restampHeldOffer, snapshotHeldOffers } from "./capacity-incidents.server.js";
import { proposeForIncident } from "./capacity-workarounds.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

vi.mock("./redis.server.js", async (importOriginal) => ({ ...(await importOriginal<typeof RedisModule>()), redisDelete: vi.fn(async () => undefined) }));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const budget = (maxCartSlots: number) => ({ storeActive: 5, ours: 2, others: 3, maxCartSlots });
const cap = (maxCartSlots = 11): CapacityOptions => ({ shardsEnabled: true, loadBudget: async () => budget(maxCartSlots) });
const deps = (extra: Partial<ApplyDeps> = {}): ApplyDeps => ({ capacity: cap(), env: {}, publish: vi.fn(async () => null), ...extra });

let seq = 0;
const gid = (kind: string) => `gid://shopify/${kind}/${++seq + 70_000_000_000}`;

async function wholeProductsFixture(domain: string, status: "paused" | "draft" | "active" = "paused", held = true) {
  const shopId = await seedShop(db, domain);
  const variants: string[] = [];
  for (let p = 0; p < 3; p++) {
    const product = gid("Product");
    for (let v = 0; v < 150; v++) {
      const variantGid = gid("ProductVariant");
      variants.push(variantGid);
      await db.insert(variantCache).values({ shopId, productGid: product, variantGid, title: `V${seq}`, price: "10", currencyCode: "USD", raw: {} });
    }
  }
  const offerId = await seedOffer(db, shopId, { internalName: "sale", type: "discount", status });
  await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_discount", discountType: "percentage", value: { amount: 15, currencyCode: "USD" }, target: { scopeMode: "sitewide", variantIds: variants, maxUnitsTotal: 5 }, sortOrder: 0 });
  const result = await preflightCapacity(db, shopId, [offerId], cap());
  if (result.ok) throw new Error("expected a capacity block");
  await recordCapacityIncident(db, { shopId, code: result.code, offerIds: result.offerIds, numbers: result.numbers, ...(result.splitRefusal ? { splitRefusal: result.splitRefusal } : {}), held: held ? await snapshotHeldOffers(db, shopId, [offerId]) : [] }, { source: "cron", attended: false });
  const [incident] = await db.select().from(capacityIncidents).where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.status, "open")));
  const p = (await proposeForIncident(db, incident!, { capacity: cap(), env: {} })).proposals.find((x) => x.kind === "use_whole_products")!;
  const input = { incidentId: incident!.id, kind: "use_whole_products" as const, confirm: false, expectedVersions: p.offerVersions, performedBy: "tester" };
  return { shopId, shop: { id: shopId, domain }, offerId, incident: incident!, input };
}

const statusOf = async (id: string) => (await db.select({ status: offers.status }).from(offers).where(eq(offers.id, id)))[0]?.status;
const actionsOf = (incidentId: string) => db.select().from(capacityActions).where(eq(capacityActions.incidentId, incidentId));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** An Apply the platform killed after its DB tx committed: the sidekick offer was paused by it and never restored. */
async function killedApply(f: { shopId: string; incident: CapacityIncident }, createdAt: Date) {
  const sidekick = await seedOffer(db, f.shopId, { internalName: "sidekick", status: "paused" });
  const [row] = await db.select({ updatedAt: offers.updatedAt }).from(offers).where(eq(offers.id, sidekick));
  const snapshot = {
    edits: [{ table: "offer", id: sidekick, before: { status: "active" }, after: { status: "paused" } }],
    createdOfferIds: [],
    offerUpdatedAfter: { [sidekick]: row!.updatedAt.toISOString() },
    deactivated: [],
  };
  const [action] = await db.insert(capacityActions).values({ shopId: f.shopId, incidentId: f.incident.id, kind: "pause_offers", status: "pending", performedBy: "tester", snapshot, createdAt }).returning();
  return { sidekick, actionId: action!.id };
}

describe("stale pending actions", () => {
  it("a pending action older than 10 minutes is rolled back, its committed edits reverted, and Apply goes through", async () => {
    const f = await wholeProductsFixture("stale-apply.myshopify.com");
    const killed = await killedApply(f, minutesAgo(11));
    const publish = vi.fn(async () => null);
    const result = await applyWorkaround(db, f.shop, f.input, deps({ publish }));
    expect(result).toMatchObject({ ok: true, code: "applied" });
    expect(await statusOf(killed.sidekick)).toBe("active");
    const [old] = await db.select().from(capacityActions).where(eq(capacityActions.id, killed.actionId));
    expect(old).toMatchObject({ status: "rolled_back", error: expect.stringContaining("timed out") });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("a fresh pending action still blocks Apply as busy and leaves everything alone", async () => {
    const f = await wholeProductsFixture("fresh-pending.myshopify.com");
    const fresh = await killedApply(f, minutesAgo(1));
    const result = await applyWorkaround(db, f.shop, f.input, deps());
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(await statusOf(fresh.sidekick)).toBe("paused");
    expect((await db.select().from(capacityActions).where(eq(capacityActions.id, fresh.actionId)))[0]?.status).toBe("pending");
  });

  it("reverting twice is impossible: the claim is atomic, a second reclaim finds nothing", async () => {
    const f = await wholeProductsFixture("stale-twice.myshopify.com");
    const killed = await killedApply(f, minutesAgo(30));
    const publish = vi.fn(async () => null);
    expect(await reclaimStalePending(db, f.shop, deps({ publish }))).toBe(1);
    await db.update(offers).set({ status: "paused" }).where(eq(offers.id, killed.sidekick));
    expect(await reclaimStalePending(db, f.shop, deps({ publish }))).toBe(0);
    expect(await statusOf(killed.sidekick)).toBe("paused");
  });

  it("does not revert over a merchant edit made after the killed Apply", async () => {
    const f = await wholeProductsFixture("stale-moved.myshopify.com");
    const killed = await killedApply(f, minutesAgo(30));
    await db.update(offers).set({ internalName: "renamed", updatedAt: new Date(Date.now() + 60_000) }).where(eq(offers.id, killed.sidekick));
    await reclaimStalePending(db, f.shop, deps());
    expect(await statusOf(killed.sidekick)).toBe("paused");
    expect((await db.select().from(capacityActions).where(eq(capacityActions.id, killed.actionId)))[0]).toMatchObject({ status: "rolled_back", error: expect.stringContaining("Changed since") });
  });

  it("a killed Undo is marked undo_failed and never auto-reverted", async () => {
    const f = await wholeProductsFixture("stale-undo.myshopify.com");
    const killed = await killedApply(f, minutesAgo(60 * 20));
    await db.update(capacityActions).set({ snapshot: { edits: [], createdOfferIds: [], offerUpdatedAfter: {}, deactivated: [], undoStartedAt: minutesAgo(15).toISOString() } }).where(eq(capacityActions.id, killed.actionId));
    expect(await reclaimStalePending(db, f.shop, deps())).toBe(1);
    expect((await db.select().from(capacityActions).where(eq(capacityActions.id, killed.actionId)))[0]?.status).toBe("undo_failed");
  });

  it("an Undo started a minute ago is not stale even though its action is a day old", async () => {
    const f = await wholeProductsFixture("undo-running.myshopify.com");
    const killed = await killedApply(f, minutesAgo(60 * 20));
    await db.update(capacityActions).set({ snapshot: { edits: [], createdOfferIds: [], offerUpdatedAfter: {}, deactivated: [], undoStartedAt: minutesAgo(1).toISOString() } }).where(eq(capacityActions.id, killed.actionId));
    expect(await reclaimStalePending(db, f.shop, deps())).toBe(0);
  });

  it("the cron entry reclaims across shops", async () => {
    const f = await wholeProductsFixture("stale-cron.myshopify.com");
    const killed = await killedApply(f, new Date(Date.now() - STALE_PENDING_MS - 1000));
    expect(await reclaimAllStalePending(db, deps())).toBeGreaterThanOrEqual(1);
    expect(await statusOf(killed.sidekick)).toBe("active");
  });
});

describe("Apply switches on the offers the block left draft or paused", () => {
  it("activates the blocked offer with the fix, and not an unrelated paused one", async () => {
    const f = await wholeProductsFixture("activate.myshopify.com", "draft");
    const other = await seedOffer(db, f.shopId, { internalName: "paused by the merchant", status: "paused" });
    const result = await applyWorkaround(db, f.shop, f.input, deps());
    expect(result).toMatchObject({ ok: true, code: "applied", activatedOffers: [{ id: f.offerId, name: "sale" }] });
    expect(result.message).toContain("switched on");
    expect(await statusOf(f.offerId)).toBe("active");
    expect(await statusOf(other)).toBe("paused");
  });

  it("does not switch the offer on when the merchant changed it after the block, and says why", async () => {
    const f = await wholeProductsFixture("activate-changed.myshopify.com", "draft");
    await db.update(offers).set({ status: "paused", updatedAt: new Date(Date.now() + 5_000) }).where(eq(offers.id, f.offerId));
    const p = (await proposeForIncident(db, f.incident, { capacity: cap(), env: {} })).proposals.find((x) => x.kind === "use_whole_products")!;
    const result = await applyWorkaround(db, f.shop, { ...f.input, expectedVersions: p.offerVersions }, deps());
    expect(result.ok).toBe(true);
    expect(result.activatedOffers).toBeUndefined();
    expect(result.keptOffOffers).toEqual([{ id: f.offerId, name: "sale", status: "paused" }]);
    expect(result.message).toContain("sale stays paused because it was changed after the block.");
    expect(await statusOf(f.offerId)).toBe("paused");
  });

  it("does not switch on a paused offer that is in the incident but was not the one being activated", async () => {
    const f = await wholeProductsFixture("activate-unrecorded.myshopify.com", "paused", false);
    const result = await applyWorkaround(db, f.shop, f.input, deps());
    expect(result.ok).toBe(true);
    expect(result.activatedOffers).toBeUndefined();
    expect(result.keptOffOffers).toBeUndefined();
    expect(await statusOf(f.offerId)).toBe("paused");
  });

  it("a system pause after the block is re-stamped, so it still counts as unchanged", async () => {
    const f = await wholeProductsFixture("activate-restamp.myshopify.com", "active");
    await db.update(offers).set({ status: "paused", updatedAt: new Date(Date.now() + 5_000) }).where(eq(offers.id, f.offerId));
    await restampHeldOffer(db, f.shopId, f.offerId);
    const p = (await proposeForIncident(db, f.incident, { capacity: cap(), env: {} })).proposals.find((x) => x.kind === "use_whole_products")!;
    const result = await applyWorkaround(db, f.shop, { ...f.input, expectedVersions: p.offerVersions }, deps());
    expect(result.activatedOffers).toEqual([{ id: f.offerId, name: "sale" }]);
    expect(await statusOf(f.offerId)).toBe("active");
  });

  it("a future start becomes scheduled, an offer that already ended stays as it was", async () => {
    const future = await wholeProductsFixture("activate-future.myshopify.com", "paused");
    await db.update(offers).set({ startsAt: new Date(Date.now() + 86_400_000) }).where(eq(offers.id, future.offerId));
    const p = (await proposeForIncident(db, future.incident, { capacity: cap(), env: {} })).proposals.find((x) => x.kind === "use_whole_products")!;
    await applyWorkaround(db, future.shop, { ...future.input, expectedVersions: p.offerVersions }, deps());
    expect(await statusOf(future.offerId)).toBe("scheduled");

    const ended = await wholeProductsFixture("activate-ended.myshopify.com", "paused");
    await db.update(offers).set({ endsAt: new Date(Date.now() - 86_400_000) }).where(eq(offers.id, ended.offerId));
    const q = (await proposeForIncident(db, ended.incident, { capacity: cap(), env: {} })).proposals.find((x) => x.kind === "use_whole_products")!;
    await applyWorkaround(db, ended.shop, { ...ended.input, expectedVersions: q.offerVersions }, deps());
    expect(await statusOf(ended.offerId)).toBe("paused");
  });

  it("rolls the activation back with everything else when the publish fails", async () => {
    const f = await wholeProductsFixture("activate-rollback.myshopify.com", "draft");
    const publish = vi.fn(async () => ({ message: "Shopify exploded", scope: "shop" as const }));
    const result = await applyWorkaround(db, f.shop, f.input, deps({ publish }));
    expect(result).toMatchObject({ ok: false, code: "rolled_back" });
    expect(await statusOf(f.offerId)).toBe("draft");
    expect((await actionsOf(f.incident.id))[0]?.status).toBe("rolled_back");
  });

  it("undo puts the activated offer back as it was", async () => {
    const f = await wholeProductsFixture("activate-undo.myshopify.com", "draft");
    const applied = await applyWorkaround(db, f.shop, f.input, deps());
    expect(await statusOf(f.offerId)).toBe("active");
    expect(await undoWorkaround(db, f.shop, applied.actionId!, "tester", deps())).toMatchObject({ ok: true, code: "undone" });
    expect(await statusOf(f.offerId)).toBe("draft");
  });
});

describe("Sync products follow-up", () => {
  async function syncFixture(domain: string, oversize: boolean) {
    const shopId = await seedShop(db, domain);
    const offerId = await seedOffer(db, shopId, { internalName: "synced", status: "draft", type: oversize ? "gift" : "discount" });
    if (oversize) {
      await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 1000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true });
      await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_gift", discountType: "free", value: {}, target: { variantIds: Array.from({ length: 150 }, () => gid("ProductVariant")) }, quantity: 1, sortOrder: 0 });
    } else {
      await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_discount", discountType: "percentage", value: { amount: 10, currencyCode: "USD" }, target: { scopeMode: "sitewide" }, sortOrder: 0 });
    }
    const result = await preflightCapacity(db, shopId, [offerId], cap());
    if (result.ok === oversize) throw new Error("fixture does not match the expected capacity outcome");
    await recordCapacityIncident(db, { shopId, code: result.ok ? "OFFER_TOO_LARGE" : result.code, offerIds: [offerId], numbers: result.ok ? { entries: 1 } : result.numbers, held: await snapshotHeldOffers(db, shopId, [offerId]) }, { source: "admin", attended: true });
    const [incident] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopId));
    await db.insert(capacityActions).values({ shopId, incidentId: incident!.id, kind: "sync_products", status: "applied", performedBy: "tester", appliedAt: new Date() });
    return { shopId, offerId, incident: incident! };
  }

  it("does not switch on a recorded offer the merchant paused after the block", async () => {
    const f = await syncFixture("sync-changed.myshopify.com", false);
    await db.update(offers).set({ status: "paused", updatedAt: new Date(Date.now() + 5_000) }).where(eq(offers.id, f.offerId));
    expect(await followUpSyncWorkaround(db, f.shopId, deps())).toBe("resolved");
    expect(await statusOf(f.offerId)).toBe("paused");
  });

  it("republishes, switches on the held-back offer and auto-resolves the incident once it fits", async () => {
    const f = await syncFixture("sync-fits.myshopify.com", false);
    const publish = vi.fn(async () => null);
    expect(await followUpSyncWorkaround(db, f.shopId, deps({ publish }))).toBe("resolved");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await statusOf(f.offerId)).toBe("active");
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "resolved", resolution: "published" });
    expect(await followUpSyncWorkaround(db, f.shopId, deps({ publish }))).toBe("none");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("leaves the incident open and does not publish when it still does not fit", async () => {
    const f = await syncFixture("sync-blocked.myshopify.com", true);
    const publish = vi.fn(async () => null);
    expect(await followUpSyncWorkaround(db, f.shopId, deps({ publish }))).toBe("still_blocked");
    expect(publish).not.toHaveBeenCalled();
    expect(await statusOf(f.offerId)).toBe("draft");
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, f.incident.id)))[0]?.status).toBe("open");
  });

  it("reverts the activation and keeps the incident open when the publish fails", async () => {
    const f = await syncFixture("sync-publish-fails.myshopify.com", false);
    const publish = vi.fn(async () => ({ message: "Shopify exploded", scope: "shop" as const }));
    expect(await followUpSyncWorkaround(db, f.shopId, deps({ publish }))).toBe("failed");
    expect(await statusOf(f.offerId)).toBe("draft");
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, f.incident.id)))[0]?.status).toBe("open");
  });
});

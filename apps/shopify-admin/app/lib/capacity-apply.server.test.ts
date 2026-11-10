import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appSettings, auditLogs, capacityActions, capacityIncidents, offerCombinationPolicies, offerConditions, offerRewards, offers, variantCache, type CapacityIncident, type Db } from "@promo/db";
import { applyWorkaround, undoWorkaround, type ApplyDeps, type DiscountOps } from "./capacity-apply.server.js";
import { preflightCapacity, type CapacityOptions } from "./capacity-preflight.server.js";
import { recordCapacityIncident } from "./capacity-incidents.server.js";
import { proposeForIncident } from "./capacity-workarounds.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

vi.mock("./redis.server.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./redis.server.js")>()), redisDelete: vi.fn(async () => undefined) }));

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
const ok = vi.fn(async () => null);
const deps = (extra: Partial<ApplyDeps> = {}): ApplyDeps => ({ capacity: cap(), env: {}, publish: ok, ...extra });

let seq = 0;
const gid = (kind: string) => `gid://shopify/${kind}/${++seq + 50_000_000_000}`;

async function seedVariants(shopId: string, products: number, perProduct: number) {
  const out: Array<{ product: string; variants: string[] }> = [];
  for (let p = 0; p < products; p++) {
    const product = gid("Product");
    const variants: string[] = [];
    for (let v = 0; v < perProduct; v++) {
      const variantGid = gid("ProductVariant");
      variants.push(variantGid);
      await db.insert(variantCache).values({ shopId, productGid: product, variantGid, title: `V${seq}`, price: "10", currencyCode: "USD", raw: {} });
    }
    out.push({ product, variants });
  }
  return out;
}

async function productOffer(shopId: string, name: string, target: Record<string, unknown>, value: Record<string, unknown> = { amount: 15, currencyCode: "USD" }, overrides: Parameters<typeof seedOffer>[2] = {}) {
  const offerId = await seedOffer(db, shopId, { internalName: name, type: "discount", ...overrides });
  await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_discount", discountType: "percentage", value, target: { scopeMode: "sitewide", ...target }, sortOrder: 0 });
  return offerId;
}

async function giftOffer(shopId: string, name: string, count: number, overrides: Parameters<typeof seedOffer>[2] = {}) {
  const offerId = await seedOffer(db, shopId, { internalName: name, ...overrides });
  await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 1000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_gift", discountType: "free", value: {}, target: { variantIds: Array.from({ length: count }, () => gid("ProductVariant")) }, quantity: 1, sortOrder: 0 });
  return offerId;
}

async function incidentFrom(shopId: string, offerIds: string[], opts: CapacityOptions = cap()): Promise<CapacityIncident> {
  const result = await preflightCapacity(db, shopId, offerIds, opts);
  if (result.ok) throw new Error("expected a capacity block");
  await recordCapacityIncident(db, { shopId, code: result.code, offerIds: result.offerIds, numbers: result.numbers, ...(result.splitRefusal ? { splitRefusal: result.splitRefusal } : {}) }, { source: "cron", attended: false });
  const rows = await db.select().from(capacityIncidents).where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.status, "open")));
  return rows.find((row) => row.code === result.code)!;
}

async function proposal(incident: CapacityIncident, kind: string, opts: CapacityOptions = cap()) {
  const found = (await proposeForIncident(db, incident, { capacity: opts, env: {} })).proposals.find((p) => p.kind === kind);
  if (!found) throw new Error(`no ${kind} proposal`);
  return found;
}

const shopRef = (shopId: string, domain: string) => ({ id: shopId, domain });
const rowsOf = async (offerId: string) => ({
  offer: (await db.select().from(offers).where(eq(offers.id, offerId)))[0],
  rewards: await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
  conditions: await db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)),
});

async function wholeProductsFixture(domain: string) {
  const shopId = await seedShop(db, domain);
  const products = await seedVariants(shopId, 3, 150);
  const offerId = await productOffer(shopId, "sale", { variantIds: products.flatMap((p) => p.variants), maxUnitsTotal: 5 }, { amount: 15, currencyCode: "USD" }, { status: "paused" });
  const incident = await incidentFrom(shopId, [offerId]);
  const p = await proposal(incident, "use_whole_products");
  return { shopId, domain, offerId, incident, p, input: { incidentId: incident.id, kind: "use_whole_products" as const, confirm: false, expectedVersions: p.offerVersions, performedBy: "tester" } };
}

describe("applyWorkaround: use_whole_products", () => {
  it("applies in place, resolves the incident, records the action with a 24 h undo window and audits the offer", async () => {
    const f = await wholeProductsFixture("apply-ok.myshopify.com");
    const result = await applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps());
    expect(result).toMatchObject({ ok: true, code: "applied", actionId: expect.anything() });
    expect(result.offersToActivate).toEqual([{ id: f.offerId, name: "sale" }]);
    const { rewards } = await rowsOf(f.offerId);
    expect(rewards[0]?.target).toMatchObject({ selectionLevel: "product", productIds: expect.anything() });
    expect(rewards[0]?.target).not.toHaveProperty("variantIds");
    const [action] = await db.select().from(capacityActions).where(eq(capacityActions.incidentId, f.incident.id));
    expect(action).toMatchObject({ status: "applied", kind: "use_whole_products", performedBy: "tester" });
    expect(action!.undoUntil!.getTime() - action!.appliedAt!.getTime()).toBe(24 * 3_600_000);
    const [incident] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, f.incident.id));
    expect(incident).toMatchObject({ status: "resolved", resolution: "workaround" });
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, f.shopId), eq(auditLogs.action, "capacity_workaround_applied")))).toHaveLength(1);
  });

  it("undo restores the original definition byte for byte, comes back paused because it does not fit, and reopens the incident", async () => {
    const f = await wholeProductsFixture("undo-ok.myshopify.com");
    const before = await rowsOf(f.offerId);
    const applied = await applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps());
    const result = await undoWorkaround(db, shopRef(f.shopId, f.domain), applied.actionId!, "tester", deps());
    expect(result).toMatchObject({ ok: true, code: "undone" });
    expect(result.message).toContain("The original offer comes back paused because it still doesn't fit.");
    const after = await rowsOf(f.offerId);
    expect(JSON.stringify(after.rewards[0]?.target)).toBe(JSON.stringify(before.rewards[0]?.target));
    expect(after.offer?.status).toBe("paused");
    const [incident] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, f.incident.id));
    expect(incident?.status).toBe("open");
    const [action] = await db.select().from(capacityActions).where(eq(capacityActions.id, applied.actionId!));
    expect(action?.status).toBe("undone");
  });

  it("an active offer comes back paused after undo and stays out of the config", async () => {
    const f = await wholeProductsFixture("undo-active.myshopify.com");
    await db.update(offers).set({ status: "active" }).where(eq(offers.id, f.offerId));
    const p = await proposal(f.incident, "use_whole_products");
    const applied = await applyWorkaround(db, shopRef(f.shopId, f.domain), { ...f.input, expectedVersions: p.offerVersions }, deps());
    expect(applied.ok).toBe(true);
    const result = await undoWorkaround(db, shopRef(f.shopId, f.domain), applied.actionId!, "tester", deps());
    expect(result.ok).toBe(true);
    expect((await rowsOf(f.offerId)).offer?.status).toBe("paused");
  });

  it("rolls back to byte-identical rows when the publish fails, republishes once, and keeps the incident open", async () => {
    const f = await wholeProductsFixture("rollback.myshopify.com");
    const before = await rowsOf(f.offerId);
    const publish = vi.fn(async () => ({ message: "Shopify exploded", scope: "shop" as const }));
    const result = await applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps({ publish }));
    expect(result).toMatchObject({ ok: false, code: "rolled_back", message: "Shopify exploded" });
    expect(publish).toHaveBeenCalledTimes(2);
    const after = await rowsOf(f.offerId);
    expect(JSON.stringify(after.rewards)).toBe(JSON.stringify(before.rewards.map((r) => ({ ...r, updatedAt: after.rewards[0]!.updatedAt }))));
    expect(JSON.stringify(after.rewards[0]?.target)).toBe(JSON.stringify(before.rewards[0]?.target));
    const [action] = await db.select().from(capacityActions).where(eq(capacityActions.incidentId, f.incident.id));
    expect(action).toMatchObject({ status: "rolled_back", error: "Shopify exploded" });
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, f.incident.id)))[0]?.status).toBe("open");
  });

  it("does not republish after a capacity block raised before any write", async () => {
    const f = await wholeProductsFixture("rollback-cap.myshopify.com");
    const publish = vi.fn(async () => ({ message: "blocked", scope: "shop" as const, capacity: { code: "SLOT_FULL" as const, offerIds: [], numbers: {} } }));
    const result = await applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps({ publish }));
    expect(result.code).toBe("rolled_back");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("refuses with the stale message when the offer changed since the proposal", async () => {
    const f = await wholeProductsFixture("stale.myshopify.com");
    await db.update(offers).set({ updatedAt: new Date(Date.now() + 5000) }).where(eq(offers.id, f.offerId));
    const result = await applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps());
    expect(result).toMatchObject({ ok: false, code: "stale", message: "The offer changed; review the proposal again." });
    expect(await db.select().from(capacityActions).where(eq(capacityActions.incidentId, f.incident.id))).toHaveLength(0);
  });

  it("lets only one of two parallel Applies win", async () => {
    const f = await wholeProductsFixture("race.myshopify.com");
    const results = await Promise.all([
      applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps()),
      applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.code).toMatch(/busy|not_found|stale/);
    const actions = await db.select().from(capacityActions).where(eq(capacityActions.incidentId, f.incident.id));
    expect(actions.filter((a) => a.status === "applied")).toHaveLength(1);
    expect(actions.filter((a) => a.status === "pending")).toHaveLength(0);
  });

  it("is invisible to another shop", async () => {
    const f = await wholeProductsFixture("tenant-a.myshopify.com");
    const other = await seedShop(db, "tenant-b.myshopify.com");
    expect(await applyWorkaround(db, shopRef(other, "tenant-b.myshopify.com"), f.input, deps())).toMatchObject({ ok: false, code: "not_found" });
    expect(await undoWorkaround(db, shopRef(other, "tenant-b.myshopify.com"), "00000000-0000-0000-0000-000000000000", "t", deps())).toMatchObject({ code: "not_found" });
  });

  it("is switched off by CAPACITY_WORKAROUNDS=off", async () => {
    const f = await wholeProductsFixture("killed-apply.myshopify.com");
    expect(await applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps({ env: { CAPACITY_WORKAROUNDS: "off" } }))).toMatchObject({ ok: false, code: "refused" });
  });

  it("refuses an undo after the offer changed, after the window, and twice", async () => {
    const f = await wholeProductsFixture("undo-guard.myshopify.com");
    const applied = await applyWorkaround(db, shopRef(f.shopId, f.domain), f.input, deps());
    await db.update(offers).set({ updatedAt: new Date(Date.now() + 9000) }).where(eq(offers.id, f.offerId));
    expect(await undoWorkaround(db, shopRef(f.shopId, f.domain), applied.actionId!, "t", deps())).toMatchObject({ ok: false, code: "undo_refused", message: "Changed since; undo by hand." });
    const g = await wholeProductsFixture("undo-expired.myshopify.com");
    const done = await applyWorkaround(db, shopRef(g.shopId, g.domain), g.input, deps());
    await db.update(capacityActions).set({ undoUntil: new Date(Date.now() - 1000) }).where(eq(capacityActions.id, done.actionId!));
    expect(await undoWorkaround(db, shopRef(g.shopId, g.domain), done.actionId!, "t", deps())).toMatchObject({ ok: false, code: "undo_refused", message: "The 24 hour undo window has passed." });
    const h = await wholeProductsFixture("undo-twice.myshopify.com");
    const once = await applyWorkaround(db, shopRef(h.shopId, h.domain), h.input, deps());
    expect((await undoWorkaround(db, shopRef(h.shopId, h.domain), once.actionId!, "t", deps())).ok).toBe(true);
    expect((await undoWorkaround(db, shopRef(h.shopId, h.domain), once.actionId!, "t", deps())).ok).toBe(false);
  });
});

describe("applyWorkaround: semantic changes", () => {
  it("require_any needs the confirmation and loosens only the operator", async () => {
    const shopId = await seedShop(db, "any.myshopify.com");
    const offerId = await seedOffer(db, shopId, { internalName: "trigger", status: "paused" });
    const requirements = Array.from({ length: 130 }, () => ({ productId: gid("Product"), trackMode: "product", minQuantity: 1 }));
    await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "specific_product", operator: "all", value: { requirements }, sortOrder: 0, isEnabled: true });
    await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_discount", discountType: "percentage", value: { amount: 10, currencyCode: "USD" }, target: { scopeMode: "sitewide", productIds: [gid("Product")] }, sortOrder: 0 });
    const incident = await incidentFrom(shopId, [offerId]);
    const p = await proposal(incident, "require_any");
    const input = { incidentId: incident.id, kind: "require_any" as const, confirm: false, expectedVersions: p.offerVersions, performedBy: "t" };
    expect(await applyWorkaround(db, shopRef(shopId, "any.myshopify.com"), input, deps())).toMatchObject({ ok: false, code: "refused" });
    expect((await rowsOf(offerId)).conditions[0]?.operator).toBe("all");
    const result = await applyWorkaround(db, shopRef(shopId, "any.myshopify.com"), { ...input, confirm: true }, deps());
    expect(result.ok).toBe(true);
    const [condition] = (await rowsOf(offerId)).conditions;
    expect(condition?.operator).toBe("any");
    expect(JSON.stringify(condition?.value)).toBe(JSON.stringify({ requirements }));
  });

  it("split_offer creates the parts active, pauses the original and Undo archives the parts and re-pauses the original", async () => {
    const shopId = await seedShop(db, "split.myshopify.com");
    const products = await seedVariants(shopId, 3, 150);
    const offerId = await productOffer(shopId, "tiered", { variantIds: products.flatMap((p) => p.variants) }, { amount: 0, tiers: [{ minimumQuantity: 2, discountType: "percentage", discountValue: 5 }, { minimumQuantity: 3, discountType: "percentage", discountValue: 10 }] }, { status: "active" });
    const incident = await incidentFrom(shopId, [offerId]);
    const p = await proposal(incident, "split_offer");
    const applied = await applyWorkaround(db, shopRef(shopId, "split.myshopify.com"), { incidentId: incident.id, kind: "split_offer", confirm: true, expectedVersions: p.offerVersions, performedBy: "t" }, deps());
    expect(applied.ok).toBe(true);
    const all = await db.select().from(offers).where(eq(offers.shopId, shopId));
    const parts = all.filter((o) => o.id !== offerId);
    expect(parts.length).toBe(p.params["parts"]);
    expect(parts.every((o) => o.status === "active" && /^tiered \(\d+\/\d+\)$/.test(o.internalName) && o.priority === 100)).toBe(true);
    expect(all.find((o) => o.id === offerId)?.status).toBe("paused");
    const slices = (await db.select().from(offerRewards).where(eq(offerRewards.shopId, shopId))).filter((r) => r.offerId !== offerId).flatMap((r) => (r.target as { variantIds: string[] }).variantIds);
    expect(new Set(slices).size).toBe(450);
    expect(slices).toHaveLength(450);

    const undone = await undoWorkaround(db, shopRef(shopId, "split.myshopify.com"), applied.actionId!, "t", deps());
    expect(undone.ok).toBe(true);
    const after = await db.select().from(offers).where(eq(offers.shopId, shopId));
    expect(after.filter((o) => o.id !== offerId).every((o) => o.status === "archived" && o.archivedAt)).toBe(true);
    expect(after.find((o) => o.id === offerId)?.status).toBe("paused");
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, incident.id)))[0]?.status).toBe("open");
  });

  it("reduce_gift_options trims the picker and undo puts the full list back", async () => {
    const shopId = await seedShop(db, "gifts.myshopify.com");
    const offerId = await giftOffer(shopId, "picker", 400, { status: "paused" });
    const before = (await rowsOf(offerId)).rewards[0]!.target;
    const incident = await incidentFrom(shopId, [offerId]);
    const p = await proposal(incident, "reduce_gift_options");
    const applied = await applyWorkaround(db, shopRef(shopId, "gifts.myshopify.com"), { incidentId: incident.id, kind: "reduce_gift_options", confirm: true, expectedVersions: p.offerVersions, performedBy: "t" }, deps());
    expect(applied.ok).toBe(true);
    expect(((await rowsOf(offerId)).rewards[0]!.target as { variantIds: string[] }).variantIds).toHaveLength(p.params["keep"] as number);
    expect((await undoWorkaround(db, shopRef(shopId, "gifts.myshopify.com"), applied.actionId!, "t", deps())).ok).toBe(true);
    expect(JSON.stringify((await rowsOf(offerId)).rewards[0]!.target)).toBe(JSON.stringify(before));
  });
});

describe("applyWorkaround: shop-level fixes", () => {
  async function groupFixture(domain: string) {
    const shopId = await seedShop(db, domain);
    const stop = await giftOffer(shopId, "stopper", 5, { priority: 0 });
    await db.insert(offerCombinationPolicies).values({ shopId, offerId: stop, stopLowerPriority: true });
    for (let i = 0; i < 8; i++) await giftOffer(shopId, `tail-${i}`, 60, { priority: 10 + i });
    const tiny = await giftOffer(shopId, "tiny", 1, { priority: 500 });
    const incident = await incidentFrom(shopId, []);
    return { shopId, domain, stop, tiny, incident };
  }

  it("pause_offers refuses a selection that does not fit, committing nothing", async () => {
    const f = await groupFixture("pause-short.myshopify.com");
    const p = await proposal(f.incident, "pause_offers");
    const result = await applyWorkaround(db, shopRef(f.shopId, f.domain), { incidentId: f.incident.id, kind: "pause_offers", selected: [f.tiny], confirm: true, expectedVersions: p.offerVersions, performedBy: "t" }, deps());
    expect(result).toMatchObject({ ok: false, code: "still_blocked" });
    expect(result.message).toContain("Still doesn't fit:");
    expect((await rowsOf(f.tiny)).offer?.status).toBe("active");
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, f.incident.id)))[0]?.status).toBe("open");
    expect((await db.select().from(capacityActions).where(eq(capacityActions.incidentId, f.incident.id)))[0]?.status).toBe("rolled_back");
  });

  it("pause_offers pauses the confirmed selection, and undo refuses to bring back a block", async () => {
    const f = await groupFixture("pause-ok.myshopify.com");
    const p = await proposal(f.incident, "pause_offers");
    const selected = p.options!.items.filter((item) => item.checked).map((item) => item.id);
    const applied = await applyWorkaround(db, shopRef(f.shopId, f.domain), { incidentId: f.incident.id, kind: "pause_offers", selected, confirm: true, expectedVersions: p.offerVersions, performedBy: "t" }, deps());
    expect(applied.ok).toBe(true);
    for (const id of selected) expect((await rowsOf(id)).offer?.status).toBe("paused");
    const undone = await undoWorkaround(db, shopRef(f.shopId, f.domain), applied.actionId!, "t", deps());
    expect(undone).toMatchObject({ ok: false, code: "undo_refused" });
    for (const id of selected) expect((await rowsOf(id)).offer?.status).toBe("paused");
  });

  it("rejects offers outside the proposal and requires the confirmation", async () => {
    const f = await groupFixture("pause-bad.myshopify.com");
    const p = await proposal(f.incident, "pause_offers");
    const base = { incidentId: f.incident.id, kind: "pause_offers" as const, expectedVersions: p.offerVersions, performedBy: "t" };
    expect(await applyWorkaround(db, shopRef(f.shopId, f.domain), { ...base, selected: ["00000000-0000-0000-0000-000000000001"], confirm: true }, deps())).toMatchObject({ ok: false, code: "refused" });
    expect(await applyWorkaround(db, shopRef(f.shopId, f.domain), { ...base, selected: [f.tiny], confirm: false }, deps())).toMatchObject({ ok: false, code: "refused" });
  });

  it("enable_shards flips the flag with no confirmation and undo refuses to bring the block back", async () => {
    const shopId = await seedShop(db, "shards.myshopify.com");
    const offerId = await productOffer(shopId, "catalog-sale", { productIds: Array.from({ length: 900 }, () => gid("Product")) }, { amount: 15, currencyCode: "USD" }, { status: "active" });
    await db.insert(appSettings).values({ shopId, key: "function_shards.enabled", value: "false" });
    const noFlag: CapacityOptions = { loadBudget: async () => budget(11) };
    const incident = await incidentFrom(shopId, [offerId], noFlag);
    const p = await proposal(incident, "enable_shards", noFlag);
    const applied = await applyWorkaround(db, shopRef(shopId, "shards.myshopify.com"), { incidentId: incident.id, kind: "enable_shards", confirm: false, expectedVersions: p.offerVersions, performedBy: "t" }, deps({ capacity: noFlag }));
    expect(applied.ok).toBe(true);
    const [flag] = await db.select().from(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "function_shards.enabled")));
    expect(flag?.value).toBe("true");
    expect(await undoWorkaround(db, shopRef(shopId, "shards.myshopify.com"), applied.actionId!, "t", deps({ capacity: noFlag }))).toMatchObject({ ok: false, code: "undo_refused" });
    expect((await db.select().from(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "function_shards.enabled"))))[0]?.value).toBe("true");
  });
});

describe("applyWorkaround: Shopify discounts", () => {
  async function limitFixture(domain: string) {
    const shopId = await seedShop(db, domain);
    for (let i = 0; i < 8; i++) await giftOffer(shopId, `u-${i}`, 60, { priority: i });
    const opts: CapacityOptions = { shardsEnabled: true, loadBudget: async () => budget(2) };
    const incident = await incidentFrom(shopId, [], opts);
    return { shopId, domain, incident, opts };
  }
  const candidates = Array.from({ length: 12 }, (_, i) => i + 1).map((n) => ({ id: `gid://shopify/DiscountAutomaticNode/${n}`, title: `Other ${n}`, type: "DiscountAutomaticApp", appTitle: "Other app" }));
  const makeOps = () => {
    const setActive = vi.fn(async () => undefined);
    const ops: DiscountOps = { list: async () => candidates, setActive };
    return { ops, setActive };
  };

  it("deactivates only what was selected from the server's list, and rolls the deactivations back when the publish fails", async () => {
    const f = await limitFixture("deact.myshopify.com");
    const p = await proposal(f.incident, "deactivate_discounts", f.opts);
    const needed = p.params["needed"] as number;
    const { ops, setActive } = makeOps();
    const base = { incidentId: f.incident.id, kind: "deactivate_discounts" as const, confirm: true, expectedVersions: p.offerVersions, performedBy: "t" };
    expect(await applyWorkaround(db, shopRef(f.shopId, f.domain), { ...base, selected: [] }, deps({ discounts: ops, capacity: f.opts }))).toMatchObject({ ok: false, code: "refused" });
    expect(await applyWorkaround(db, shopRef(f.shopId, f.domain), { ...base, selected: ["gid://shopify/DiscountAutomaticNode/999"] }, deps({ discounts: ops, capacity: f.opts }))).toMatchObject({ ok: false });
    expect(setActive).not.toHaveBeenCalled();

    const selected = candidates.slice(0, needed).map((c) => c.id);
    const failing = vi.fn(async () => ({ message: "publish failed", scope: "shop" as const, capacity: { code: "SLOT_FULL" as const, offerIds: [], numbers: {} } }));
    const rolled = await applyWorkaround(db, shopRef(f.shopId, f.domain), { ...base, selected }, deps({ discounts: ops, capacity: f.opts, publish: failing }));
    expect(rolled).toMatchObject({ ok: false, code: "rolled_back" });
    expect(setActive.mock.calls.map((c) => (c as unknown as [unknown, string, boolean]).slice(1))).toEqual([...selected.map((id) => [id, false]), ...[...selected].reverse().map((id) => [id, true])]);
  });

  it("deactivates, publishes, and Undo reactivates the same discounts", async () => {
    const f = await limitFixture("deact-ok.myshopify.com");
    const p = await proposal(f.incident, "deactivate_discounts", f.opts);
    const selected = candidates.slice(0, p.params["needed"] as number).map((c) => c.id);
    const { ops, setActive } = makeOps();
    const applied = await applyWorkaround(db, shopRef(f.shopId, f.domain), { incidentId: f.incident.id, kind: "deactivate_discounts", selected, confirm: true, expectedVersions: p.offerVersions, performedBy: "t" }, deps({ discounts: ops, capacity: f.opts }));
    expect(applied.ok).toBe(true);
    setActive.mockClear();
    const relaxed: CapacityOptions = { shardsEnabled: true, loadBudget: async () => budget(11) };
    const undone = await undoWorkaround(db, shopRef(f.shopId, f.domain), applied.actionId!, "t", deps({ discounts: ops, capacity: relaxed }));
    expect(undone.ok).toBe(true);
    expect(setActive.mock.calls.map((c) => (c as unknown as [unknown, string, boolean]).slice(1))).toEqual(selected.map((id) => [id, true]));
  });
});

describe("applyWorkaround: sync_products", () => {
  it("queues the catalog sync, applies without an undo window and never undoes", async () => {
    const shopId = await seedShop(db, "sync-apply.myshopify.com");
    const offerId = await seedOffer(db, shopId, { internalName: "unsynced", status: "active" });
    await recordCapacityIncident(db, { shopId, code: "OFFER_TOO_LARGE", offerIds: [offerId], numbers: {}, splitRefusal: "VARIANT_PRODUCT_UNKNOWN" }, { source: "cron", attended: false });
    const [incident] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopId));
    const p = await proposal(incident!, "sync_products");
    const syncProducts = vi.fn(async () => undefined);
    const applied = await applyWorkaround(db, shopRef(shopId, "sync-apply.myshopify.com"), { incidentId: incident!.id, kind: "sync_products", confirm: false, expectedVersions: p.offerVersions, performedBy: "t" }, deps({ syncProducts }));
    expect(applied).toMatchObject({ ok: true, code: "applied" });
    expect(syncProducts).toHaveBeenCalledWith(shopId);
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, incident!.id)))[0]?.status).toBe("open");
    expect(await undoWorkaround(db, shopRef(shopId, "sync-apply.myshopify.com"), applied.actionId!, "t", deps())).toMatchObject({ ok: false, code: "undo_refused" });
  });
});

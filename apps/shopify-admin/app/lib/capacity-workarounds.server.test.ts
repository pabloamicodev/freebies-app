import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appSettings, capacityIncidents, offerCombinationPolicies, offerConditions, offerRewards, offers, variantCache, type CapacityIncident, type Db } from "@promo/db";
import { preflightCapacity, type CapacityOptions } from "./capacity-preflight.server.js";
import { recordCapacityIncident } from "./capacity-incidents.server.js";
import { proposeForIncident } from "./capacity-workarounds.server.js";
import { rankGiftVariants } from "./capacity-transforms.server.js";
import { sliceTarget, splitEligibility } from "./sync/slice-offer-definition.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

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
const capNoFlag = (maxCartSlots = 11): CapacityOptions => ({ loadBudget: async () => budget(maxCartSlots) });

let seq = 0;
const variantGid = () => `gid://shopify/ProductVariant/${++seq + 10_000_000_000}`;

async function seedVariants(shopId: string, products: number, perProduct: number, stock: (index: number) => Partial<typeof variantCache.$inferInsert> = () => ({})) {
  const result: Array<{ product: string; variants: string[] }> = [];
  let n = 0;
  for (let p = 0; p < products; p++) {
    const product = `gid://shopify/Product/${++seq + 20_000_000_000}`;
    const variants: string[] = [];
    for (let v = 0; v < perProduct; v++) {
      const gid = variantGid();
      variants.push(gid);
      await db.insert(variantCache).values({ shopId, productGid: product, variantGid: gid, title: `Variant ${n}`, price: "10", currencyCode: "USD", raw: {}, ...stock(n++) });
    }
    result.push({ product, variants });
  }
  return result;
}

async function productOffer(shopId: string, name: string, target: Record<string, unknown>, value: Record<string, unknown> = { amount: 15, currencyCode: "USD" }, overrides: Parameters<typeof seedOffer>[2] = {}) {
  const offerId = await seedOffer(db, shopId, { internalName: name, type: "discount", ...overrides });
  await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_discount", discountType: "percentage", value, target: { scopeMode: "sitewide", ...target }, sortOrder: 0 });
  return offerId;
}

async function giftOffer(shopId: string, name: string, variantIds: string[], overrides: Parameters<typeof seedOffer>[2] = {}) {
  const offerId = await seedOffer(db, shopId, { internalName: name, ...overrides });
  await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 1000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_gift", discountType: "free", value: {}, target: { variantIds }, quantity: 1, sortOrder: 0 });
  return offerId;
}

async function incidentFrom(shopId: string, offerIds: string[], opts: CapacityOptions): Promise<CapacityIncident> {
  const result = await preflightCapacity(db, shopId, offerIds, opts);
  if (result.ok) throw new Error("expected a capacity block");
  await recordCapacityIncident(db, { shopId, code: result.code, offerIds: result.offerIds, numbers: result.numbers, ...(result.splitRefusal ? { splitRefusal: result.splitRefusal } : {}) }, { source: "cron", attended: false });
  const rows = await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopId));
  return rows.find((row) => row.code === result.code)!;
}

const kinds = async (incident: CapacityIncident, options: CapacityOptions, env: NodeJS.ProcessEnv = {}) =>
  (await proposeForIncident(db, incident, { capacity: options, env })).proposals.map((proposal) => proposal.kind);

describe("use_whole_products", () => {
  it("is offered, without a semantic change, when every variant of every product is selected and the config then fits", async () => {
    const shopId = await seedShop(db, "wp-ok.myshopify.com");
    const products = await seedVariants(shopId, 3, 150);
    const offerId = await productOffer(shopId, "sale", { variantIds: products.flatMap((p) => p.variants), maxUnitsTotal: 5 });
    const incident = await incidentFrom(shopId, [offerId], cap());
    expect(incident).toMatchObject({ code: "OFFER_TOO_LARGE", reason: "AGGREGATING_REWARD" });
    const result = await proposeForIncident(db, incident, { capacity: cap(), env: {} });
    expect(result.proposals.map((p) => p.kind)).toEqual(["use_whole_products"]);
    expect(result.proposals[0]).toMatchObject({ semanticChange: false, customerChange: expect.stringContaining("Nothing changes today") });
    expect(result.proposals[0]?.offerVersions[offerId]).toEqual(expect.anything());
    expect(result.guidance).toBeNull();
  });

  it("is not offered when a product has a variant the offer does not select", async () => {
    const shopId = await seedShop(db, "wp-partial.myshopify.com");
    const products = await seedVariants(shopId, 3, 150);
    const picked = products.flatMap((p) => p.variants);
    picked.pop();
    const offerId = await productOffer(shopId, "sale", { variantIds: picked, maxUnitsTotal: 5 });
    expect(await kinds(await incidentFrom(shopId, [offerId], cap()), cap())).toEqual([]);
  });

  it("is not offered when a selected variant is missing from the catalog cache", async () => {
    const shopId = await seedShop(db, "wp-unknown.myshopify.com");
    const products = await seedVariants(shopId, 3, 150);
    const offerId = await productOffer(shopId, "sale", { variantIds: [...products.flatMap((p) => p.variants), variantGid()], maxUnitsTotal: 5 });
    expect(await kinds(await incidentFrom(shopId, [offerId], cap()), cap())).toEqual([]);
  });
});

describe("require_any", () => {
  async function allOfOffer(shopId: string, count: number, minQuantity = 1) {
    const offerId = await seedOffer(db, shopId, { internalName: "bundle-trigger" });
    await db.insert(offerConditions).values({
      shopId, offerId, scope: "main", conditionType: "specific_product", operator: "all",
      value: { requirements: Array.from({ length: count }, () => ({ productId: `gid://shopify/Product/${++seq + 30_000_000_000}`, trackMode: "product", minQuantity })) },
      sortOrder: 0, isEnabled: true,
    });
    await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_discount", discountType: "percentage", value: { amount: 10, currencyCode: "USD" }, target: { scopeMode: "sitewide", productIds: ["gid://shopify/Product/1"] }, sortOrder: 0 });
    return offerId;
  }

  it("loosens all-of to any-of for plain quantities, flagged as a semantic change", async () => {
    const shopId = await seedShop(db, "ra-ok.myshopify.com");
    const offerId = await allOfOffer(shopId, 130);
    const result = await proposeForIncident(db, await incidentFrom(shopId, [offerId], cap()), { capacity: cap(), env: {} });
    const proposal = result.proposals.find((p) => p.kind === "require_any");
    expect(proposal).toMatchObject({ semanticChange: true, customerChange: "Customers qualify by buying any one of these 130 items instead of all of them." });
  });

  it("is not offered when a requirement needs more than one unit, and the guidance explains why", async () => {
    const shopId = await seedShop(db, "ra-qty.myshopify.com");
    const offerId = await allOfOffer(shopId, 130, 2);
    const result = await proposeForIncident(db, await incidentFrom(shopId, [offerId], cap()), { capacity: cap(), env: {} });
    expect(result.proposals.map((p) => p.kind)).not.toContain("require_any");
    expect(result.guidance === null || result.guidance.includes("Shopify can't check that a cart contains all of 130 items")).toBe(true);
  });
});

describe("reduce_gift_options", () => {
  it("keeps the most available options that fit, in the merchant's order, as a semantic change", async () => {
    const shopId = await seedShop(db, "gift-ok.myshopify.com");
    const products = await seedVariants(shopId, 1, 400, (n) => (n % 2 === 0 ? { inventoryTracked: true, inventoryQuantity: 0, inventoryPolicy: "DENY" } : { inventoryTracked: true, inventoryQuantity: 5, inventoryPolicy: "DENY" }));
    const offerId = await giftOffer(shopId, "picker", products[0]!.variants);
    const incident = await incidentFrom(shopId, [offerId], cap());
    expect(incident.reason).toBe("GIFT_PICKER");
    const result = await proposeForIncident(db, incident, { capacity: cap(), env: {} });
    const proposal = result.proposals.find((p) => p.kind === "reduce_gift_options");
    expect(proposal).toMatchObject({ semanticChange: true });
    const keep = proposal!.params["keep"] as number;
    expect(keep).toBeGreaterThan(1);
    expect(keep).toBeLessThan(400);
    expect(proposal!.customerChange).toContain(`Customers choose from ${keep} gifts instead of 400.`);
    expect(proposal!.customerChange).toContain("Removed:");
  });

  it("ranks available first, then more stock, then the original order", () => {
    const stock = new Map([
      ["a", { availableForSale: true, inventoryTracked: true, inventoryPolicy: "DENY", inventoryQuantity: 0, title: "a" }],
      ["b", { availableForSale: true, inventoryTracked: true, inventoryPolicy: "DENY", inventoryQuantity: 3, title: "b" }],
      ["c", { availableForSale: true, inventoryTracked: false, inventoryPolicy: "DENY", inventoryQuantity: null, title: "c" }],
      ["d", { availableForSale: true, inventoryTracked: true, inventoryPolicy: "DENY", inventoryQuantity: 9, title: "d" }],
      ["e", { availableForSale: true, inventoryTracked: true, inventoryPolicy: "CONTINUE", inventoryQuantity: 0, title: "e" }],
    ]);
    expect(rankGiftVariants(["a", "b", "c", "d", "e", "unknown"], stock)).toEqual(["d", "b", "c", "e", "a", "unknown"]);
  });
});

describe("split_offer", () => {
  const tiers = (values: number[]) => ({ amount: 0, tiers: values.map((discountValue, i) => ({ minimumQuantity: i + 2, discountType: "percentage", discountValue })) });

  it("is offered for a tiers-only discount that can only tighten, with the quantity warning", async () => {
    const shopId = await seedShop(db, "split-ok.myshopify.com");
    const products = await seedVariants(shopId, 3, 150);
    const offerId = await productOffer(shopId, "tiered", { variantIds: products.flatMap((p) => p.variants) }, tiers([5, 10, 15]));
    const incident = await incidentFrom(shopId, [offerId], cap());
    const result = await proposeForIncident(db, incident, { capacity: cap(), env: {} });
    const split = result.proposals.find((p) => p.kind === "split_offer");
    expect(split).toMatchObject({ semanticChange: true, customerChange: expect.stringContaining("Quantities count separately in each part") });
    expect(split!.params["parts"]).toBeGreaterThanOrEqual(2);
    expect(await db.select({ id: offers.id }).from(offers).where(eq(offers.shopId, shopId))).toHaveLength(1);
  });

  it("refuses tiers that grow when items are split apart or caps and codes that would multiply", () => {
    const base = { offer: { requiresCode: false, requiredDiscountCode: null }, conditions: [], policy: null } as const;
    const reward = (value: unknown, target: Record<string, unknown> = {}, quantity: number | null = null) =>
      [{ id: "r", rewardType: "product_discount", discountType: "percentage", value, target: { productIds: ["a", "b", "c"], ...target }, quantity }] as never;
    expect(splitEligibility({ ...base, rewards: reward(tiers([5, 10])) }).ok).toBe(true);
    expect(splitEligibility({ ...base, rewards: reward(tiers([10, 5])) }).ok).toBe(false);
    expect(splitEligibility({ ...base, rewards: reward({ amount: 10 }) }).ok).toBe(false);
    expect(splitEligibility({ ...base, rewards: reward(tiers([5, 10]), { maxUnitsTotal: 2 }) }).ok).toBe(false);
    expect(splitEligibility({ ...base, rewards: reward(tiers([5, 10]), { selectionMode: "cheapest" }) }).ok).toBe(false);
    expect(splitEligibility({ ...base, rewards: reward(tiers([5, 10]), {}, 2) }).ok).toBe(false);
    expect(splitEligibility({ ...base, offer: { requiresCode: true, requiredDiscountCode: null }, rewards: reward(tiers([5, 10])) }).ok).toBe(false);
    expect(splitEligibility({ ...base, policy: { stopLowerPriority: false, maxApplicationsPerCart: 1, maxApplicationsPerCustomer: null }, rewards: reward(tiers([5, 10])) }).ok).toBe(false);
    expect(splitEligibility({ ...base, rewards: reward({ amount: 0, tiers: [{ minimumQuantity: 2, maximumQuantity: 4, discountType: "percentage", discountValue: 5 }] }) }).ok).toBe(false);
  });

  it("slices disjointly and completely", () => {
    const slices = sliceTarget({ variantIds: Array.from({ length: 10 }, (_, i) => `v${i}`), productIds: ["p1", "p2"], scopeMode: "sitewide" }, 3);
    const all = slices.flatMap((slice) => [...((slice["productIds"] as string[]) ?? []), ...((slice["variantIds"] as string[]) ?? [])]);
    expect(slices).toHaveLength(3);
    expect(new Set(all).size).toBe(12);
    expect(all).toHaveLength(12);
    expect(slices.every((slice) => slice["scopeMode"] === "sitewide")).toBe(true);
  });
});

describe("sync_products", () => {
  it("is offered, with no customer change, when variants are not synced", async () => {
    const shopId = await seedShop(db, "sync.myshopify.com");
    const offerId = await seedOffer(db, shopId, { internalName: "unsynced" });
    await recordCapacityIncident(db, { shopId, code: "OFFER_TOO_LARGE", offerIds: [offerId], numbers: {}, splitRefusal: "VARIANT_PRODUCT_UNKNOWN" }, { source: "cron", attended: false });
    const [incident] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopId));
    const result = await proposeForIncident(db, incident!, { env: {} });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ kind: "sync_products", semanticChange: false, customerChange: "Nothing changes for customers." });
  });
});

describe("pause_offers", () => {
  it("proposes the smallest set, lowest priority first, pre-checked, that makes a stop-lower-priority group fit", async () => {
    const shopId = await seedShop(db, "pause-group.myshopify.com");
    const stop = await giftOffer(shopId, "stopper", Array.from({ length: 5 }, variantGid), { priority: 0 });
    await db.insert(offerCombinationPolicies).values({ shopId, offerId: stop, stopLowerPriority: true });
    for (let i = 0; i < 8; i++) await giftOffer(shopId, `tail-${i}`, Array.from({ length: 60 }, variantGid), { priority: 10 + i });
    const incident = await incidentFrom(shopId, [], cap());
    expect(incident.code).toBe("SLOT0_GROUP_TOO_LARGE");
    const result = await proposeForIncident(db, incident, { capacity: cap(), env: {} });
    const pause = result.proposals.find((p) => p.kind === "pause_offers");
    expect(pause).toMatchObject({ semanticChange: true });
    const checked = pause!.options!.items.filter((item) => item.checked).map((item) => item.label);
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.length).toBeLessThan(pause!.options!.items.length);
    expect(checked[0]).toBe("tail-7");
    expect(pause!.customerChange).toContain("These offers stop running:");
  });
});

describe("automatic discount limit", () => {
  it("offers deactivation (nothing pre-selected) and pausing when the store count is known", async () => {
    const shopId = await seedShop(db, "auto-limit.myshopify.com");
    for (let i = 0; i < 8; i++) await giftOffer(shopId, `u-${i}`, Array.from({ length: 60 }, variantGid), { priority: i });
    const incident = await incidentFrom(shopId, [], { ...cap(2), loadBudget: async () => budget(2) });
    expect(incident.code).toBe("AUTOMATIC_DISCOUNT_LIMIT");
    const result = await proposeForIncident(db, incident, { capacity: { ...cap(2) }, env: {} });
    const deactivate = result.proposals.find((p) => p.kind === "deactivate_discounts");
    expect(deactivate).toMatchObject({ semanticChange: true, options: { lazy: true, items: [], minSelected: expect.any(Number) } });
    expect(deactivate!.customerChange).toContain("The Shopify discounts you select stop applying");
  });

  it("only says to try again in a minute when the count is unknown", async () => {
    const shopId = await seedShop(db, "auto-unknown.myshopify.com");
    const offerId = await seedOffer(db, shopId, { internalName: "x" });
    await recordCapacityIncident(db, { shopId, code: "AUTOMATIC_DISCOUNT_LIMIT", offerIds: [offerId], numbers: { needed: 1 } }, { source: "cron", attended: false });
    const [incident] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopId));
    expect(await proposeForIncident(db, incident!, { env: {} })).toMatchObject({ proposals: [], guidance: "Try again in a minute." });
  });
});

describe("combination", () => {
  it("offers combination groups and allow-combine, both flagged, only when they make the offers fit", async () => {
    const shopId = await seedShop(db, "combo.myshopify.com");
    const blocker = await giftOffer(shopId, "blocker", Array.from({ length: 60 }, variantGid), { priority: 1 });
    await db.insert(offerCombinationPolicies).values({ shopId, offerId: blocker, combinesWithProductDiscounts: false });
    for (let i = 0; i < 7; i++) await giftOffer(shopId, `c-${i}`, Array.from({ length: 60 }, variantGid), { priority: 10 + i });
    const incident = await incidentFrom(shopId, [], cap());
    expect(incident.code).toBe("COMBINATION_SINGLE_SHARD");
    const result = await proposeForIncident(db, incident, { capacity: cap(), env: {} });
    expect(result.proposals.map((p) => p.kind).sort()).toEqual(["allow_combine", "enable_combination_groups"]);
    expect(result.proposals.every((p) => p.semanticChange)).toBe(true);
    const env = await proposeForIncident(db, incident, { capacity: cap(), env: { FUNCTION_SHARD_DOMAINS: "off" } });
    expect(env.proposals.map((p) => p.kind)).toEqual(["allow_combine"]);
  });
});

describe("enable_shards", () => {
  it("is offered, with no customer change, when the shop's flag is explicitly off and turning it on fits", async () => {
    const shopId = await seedShop(db, "shards-off.myshopify.com");
    const offerId = await productOffer(shopId, "catalog-sale", { productIds: Array.from({ length: 900 }, (_, i) => `gid://shopify/Product/${40_000_000_000 + i}`) });
    await db.insert(appSettings).values({ shopId, key: "function_shards.enabled", value: "false" });
    const incident = await incidentFrom(shopId, [offerId], capNoFlag());
    expect(incident.code).toBe("SLOT_FULL");
    const result = await proposeForIncident(db, incident, { capacity: capNoFlag(), env: {} });
    expect(result.proposals.map((p) => p.kind)).toEqual(["enable_shards"]);
    expect(result.proposals[0]).toMatchObject({ semanticChange: false, customerChange: "Nothing changes for customers." });
    expect((await db.select().from(appSettings).where(eq(appSettings.shopId, shopId)))[0]?.value).toBe("false");
  });
});

describe("kill switch and manual cases", () => {
  it("shows manual guidance only when CAPACITY_WORKAROUNDS is off", async () => {
    const shopId = await seedShop(db, "killed.myshopify.com");
    const products = await seedVariants(shopId, 3, 150);
    const offerId = await productOffer(shopId, "sale", { variantIds: products.flatMap((p) => p.variants), maxUnitsTotal: 5 });
    const incident = await incidentFrom(shopId, [offerId], cap());
    expect(incident.reason).toBe("AGGREGATING_REWARD");
    const result = await proposeForIncident(db, incident, { capacity: cap(), env: { CAPACITY_WORKAROUNDS: "off" } });
    expect(result.proposals).toEqual([]);
    expect(result.guidance).toContain("Automatic fixes are switched off");
    expect(result.title).toBe("This offer has too many items for one Shopify discount");
  });

  it("offers nothing for blocks without a safe fix (keys, tags)", async () => {
    const shopId = await seedShop(db, "manual.myshopify.com");
    const offerId = await giftOffer(shopId, "taggy", [variantGid(), variantGid()]);
    await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "customer_tags", operator: "any", value: { includeTags: Array.from({ length: 101 }, (_, i) => `tag-${i}`), excludeTags: [] }, sortOrder: 1, isEnabled: true });
    const incident = await incidentFrom(shopId, [offerId], cap());
    expect(incident.reason).toBe("tags");
    const result = await proposeForIncident(db, incident, { capacity: cap(), env: {} });
    expect(result.proposals).toEqual([]);
    expect(result.fix).toContain("Remove some customer tags");
  });
});

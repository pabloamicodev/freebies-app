import type * as PromoDb from "@promo/db";
import type * as CartValidation from "../cart-validation.server.js";
import type * as ShopifyFetch from "../shopify-fetch.server.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { appSettings, discountShards, offerCombinationPolicies, offerConditions, offerRewards, offers, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../test-support/pglite-db.js";
import { setFunctionShardsEnabled, setShardDomainsEnabled } from "../function-shards-flag.server.js";
import { SLOT_LIMITS } from "./shard-planner.js";

let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  // The publisher wraps itself in a transaction for the advisory lock; pglite has one connection, so queries
  // issued on the outer handle would wait for that transaction forever. Run the callback on the handle itself.
  getDb: () =>
    new Proxy(currentDb as object, {
      get: (target, prop) =>
        prop === "transaction"
          ? (callback: (tx: unknown) => unknown) => callback(target)
          : (target as Record<string | symbol, unknown>)[prop],
    }),
}));
vi.mock("../token-crypto.server.js", () => ({ decryptToken: async () => "token" }));
vi.mock("../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../cart-validation.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CartValidation>()),
  syncCartValidation: async () => "validation",
}));

const world = vi.hoisted(() => ({
  gql: undefined as unknown as (arg: { query: string; variables?: Record<string, unknown> }) => Promise<unknown>,
}));
vi.mock("../shopify-fetch.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ShopifyFetch>()),
  shopifyGraphQL: (arg: { query: string; variables?: Record<string, unknown> }) => world.gql(arg),
}));

const { publishOffersForShop } = await import("./offer-publisher.server.js");
const { ShardPlanBlockedError } = await import("./cart-shards.server.js");
const { configHash } = await import("../publish-manifest.server.js");
const { repairShopDrift } = await import("../discount-reconciliation.server.js");
const { tryPublishShop } = await import("../offer-publish-flow.server.js");

const CART_FN = { id: "gid://shopify/ShopifyFunction/cart", apiType: "discount", handle: "promo-engine-discount", title: "Promo Engine Discount" };
const DELIVERY_FN = { id: "gid://shopify/ShopifyFunction/delivery", apiType: "discount", handle: "promo-engine-delivery-discount", title: "Promo Engine Delivery Discount" };
const CART_NODE = "gid://shopify/DiscountAutomaticNode/cart";
const DELIVERY_NODE = "gid://shopify/DiscountAutomaticNode/delivery";

interface MetafieldInput {
  ownerId: string;
  namespace: string;
  key: string;
  value: string;
}

/** A recorded Shopify: automatic nodes, their function_config metafields and every call made. */
class FakeShopify {
  nodes = new Map<string, { title: string; functionId: string; classes: string[] }>();
  metafields = new Map<string, Map<string, string>>();
  mutations: string[] = [];
  metafieldsSets: MetafieldInput[][] = [];
  created: string[] = [];
  deleted: string[] = [];
  policyUpdates: string[] = [];
  /** Every combinesWith update and metafieldsSet, in call order, so tests can assert strict-first ordering. */
  timeline: string[] = [];
  policies = new Map<string, { orderDiscounts: boolean; productDiscounts: boolean; shippingDiscounts: boolean }>();
  others = 3;
  crashAfterMetafieldsSet = false;
  /** The next metafieldsSet fails before anything is stored. */
  failMetafieldsSet = false;
  failLiveRead = false;
  private seq = 100;

  reset() {
    this.nodes = new Map([
      [CART_NODE, { title: "Promo Engine", functionId: CART_FN.id, classes: ["PRODUCT", "ORDER"] }],
      [DELIVERY_NODE, { title: "Promo Engine Shipping", functionId: DELIVERY_FN.id, classes: ["SHIPPING"] }],
    ]);
    this.metafields = new Map();
    this.mutations = [];
    this.metafieldsSets = [];
    this.created = [];
    this.deleted = [];
    this.policyUpdates = [];
    this.timeline = [];
    this.policies = new Map();
    this.others = 3;
    this.crashAfterMetafieldsSet = false;
    this.failMetafieldsSet = false;
    this.failLiveRead = false;
  }

  value(ownerId: string, namespace = "promo_engine"): Record<string, unknown> & { offers: Array<{ id: string }> } {
    return JSON.parse(this.metafields.get(ownerId)!.get(namespace)!);
  }

  shardNodeIds(): string[] {
    return [...this.nodes.keys()].filter((id) => id !== CART_NODE && id !== DELIVERY_NODE);
  }

  setMetafield(ownerId: string, namespace: string, value: string) {
    const owner = this.metafields.get(ownerId) ?? new Map<string, string>();
    owner.set(namespace, value);
    this.metafields.set(ownerId, owner);
  }

  call = async ({ query, variables }: { query: string; variables?: Record<string, unknown> }): Promise<unknown> => {
    const mutation = /^\s*mutation (\w+)/.exec(query)?.[1];
    if (mutation) this.mutations.push(mutation);
    if (query.includes("CheckDiscountNode")) {
      const id = variables!["id"] as string;
      return { discountNode: this.nodes.has(id) ? { id } : null };
    }
    if (query.includes("FindDiscountFunction")) return { shopifyFunctions: { nodes: [CART_FN, DELIVERY_FN] } };
    if (query.includes("discountNodesCount")) return { discountNodesCount: { count: this.nodes.size + this.others } };
    if (query.includes("discountNodes(")) {
      return {
        discountNodes: {
          nodes: [...this.nodes].map(([id, node]) => ({
            id,
            discount: { __typename: "DiscountAutomaticApp", title: node.title, appDiscountType: { functionId: node.functionId } },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    if (query.includes("PromoEngineNodesActive")) {
      return {
        nodes: (variables!["ids"] as string[]).map((id) => (this.nodes.has(id) ? { id, automaticDiscount: { status: "ACTIVE" } } : null)),
      };
    }
    if (query.includes("PromoEngineNodesExist")) {
      return {
        nodes: (variables!["ids"] as string[]).map((id) =>
          this.nodes.has(id) ? { id, automaticDiscount: { title: this.nodes.get(id)!.title } } : null,
        ),
      };
    }
    if (query.includes("CreatePromoEngineDiscount")) {
      const input = variables!["discount"] as { title: string; functionHandle: string; discountClasses: string[]; metafields?: MetafieldInput[] };
      const id = `gid://shopify/DiscountAutomaticNode/n${this.seq++}`;
      this.nodes.set(id, {
        title: input.title,
        functionId: input.functionHandle === CART_FN.handle ? CART_FN.id : DELIVERY_FN.id,
        classes: input.discountClasses,
      });
      for (const m of input.metafields ?? []) this.setMetafield(id, m.namespace, m.value);
      this.created.push(id);
      return { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: id }, userErrors: [] } };
    }
    if (query.includes("PromoEngineLiveCombination")) {
      if (this.failLiveRead) throw new Error("live combination read failed");
      const open = { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true };
      return {
        nodes: (variables!["ids"] as string[]).map((id) =>
          this.nodes.has(id) ? { id, automaticDiscount: { combinesWith: this.policies.get(id) ?? open } } : null,
        ),
      };
    }
    if (query.includes("UpdatePromoEngineDiscountCombination")) {
      this.policyUpdates.push(variables!["id"] as string);
      const combinesWith = (variables!["discount"] as { combinesWith: { orderDiscounts: boolean; productDiscounts: boolean; shippingDiscounts: boolean } }).combinesWith;
      this.policies.set(variables!["id"] as string, combinesWith);
      this.timeline.push(`policy:${variables!["id"] as string}:${combinesWith.productDiscounts ? "open" : "closed"}`);
      return { discountAutomaticAppUpdate: { automaticAppDiscount: { discountId: variables!["id"] }, userErrors: [] } };
    }
    if (query.includes("mutation MetafieldsSet")) {
      const batch = variables!["metafields"] as MetafieldInput[];
      for (const m of batch) if (!this.nodes.has(m.ownerId)) throw new Error(`metafieldsSet on missing node ${m.ownerId}`);
      if (this.failMetafieldsSet) {
        this.failMetafieldsSet = false;
        throw new Error("metafieldsSet failed");
      }
      this.metafieldsSets.push(batch);
      this.timeline.push("swap");
      for (const m of batch) this.setMetafield(m.ownerId, m.namespace, m.value);
      if (this.crashAfterMetafieldsSet) {
        this.crashAfterMetafieldsSet = false;
        throw new Error("process died after metafieldsSet");
      }
      return { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    if (query.includes("PromoEngineDriftCheck")) {
      return {
        nodes: (variables!["ids"] as string[]).map((id) => {
          if (!this.nodes.has(id)) return null;
          const copy = (namespace: string) => {
            const value = this.metafields.get(id)?.get(namespace);
            return value ? { value } : null;
          };
          return {
            __typename: "DiscountAutomaticNode",
            id,
            m0: copy("promo_engine"),
            m1: copy("$app:promo_engine"),
            automaticDiscount: {
              status: "ACTIVE",
              appliesOnSubscription: true,
              appliesOnOneTimePurchase: true,
              ...(this.policies.has(id) ? { combinesWith: this.policies.get(id) } : {}),
            },
          };
        }),
      };
    }
    if (query.includes("PromoEngineValidationDrift")) return { validations: { nodes: [] } };
    if (query.includes("PromoEngineAppInstallation")) return { currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } };
    if (query.includes("PromoEngineStorefrontMetafields")) return { metafieldsSet: { metafields: [], userErrors: [] } };
    if (query.includes("DeletePromoEngineAutomaticDiscount")) {
      const id = variables!["id"] as string;
      this.deleted.push(id);
      this.nodes.delete(id);
      this.metafields.delete(id);
      return { discountAutomaticDelete: { deletedAutomaticDiscountId: id, userErrors: [] } };
    }
    throw new Error(`unexpected Shopify call: ${query.slice(0, 80)}`);
  };
}

const shopify = new FakeShopify();
world.gql = shopify.call;

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let DOMAIN = "";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  currentDb = db;
}, 60_000);
afterEach(async () => {
  await db.delete(shops).where(eq(shops.id, shopId));
});
afterAll(async () => {
  await close();
});

async function freshShop(): Promise<string> {
  shopify.reset();
  DOMAIN = `s${Math.random().toString(36).slice(2, 8)}.myshopify.com`;
  const id = await seedShop(db, DOMAIN);
  await db.update(shops).set({ discountId: CART_NODE, deliveryDiscountId: DELIVERY_NODE }).where(eq(shops.id, id));
  return id;
}

const KEYS = ["a", "b", "c", "d", "e"];

/** Offer shapes follow the Ambrosia fixture: landing product rewards with an anchor variant, plain sitewide percentages, order tiers. */
async function seedCatalog(id: string, total: number, orderOffers: number, stopOffers: number) {
  const rewardRows: Array<typeof offerRewards.$inferInsert> = [];
  const conditionRows: Array<typeof offerConditions.$inferInsert> = [];
  const policyRows: Array<typeof offerCombinationPolicies.$inferInsert> = [];
  const ids: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const isOrder = i < orderOffers;
    const isStop = !isOrder && i < orderOffers + stopOffers;
    const offerId = await seedOffer(db, id, {
      type: "discount",
      codeRedemption: "automatic",
      priority: isOrder ? 10 + i : isStop ? 900 + i : 100 + i,
      internalName: `Offer ${i}`,
      publicTitle: `Offer ${i}`,
    });
    ids.push(offerId);
    if (isOrder) {
      rewardRows.push({
        shopId: id,
        offerId,
        rewardType: "order_discount",
        discountType: "percentage",
        value: { amount: 5, currencyCode: "USD" },
        target: { scope: "cart" },
      });
    } else {
      rewardRows.push({
        shopId: id,
        offerId,
        rewardType: "product_discount",
        discountType: i % 3 === 0 ? "free" : "percentage",
        value: { amount: 10 + (i % 20), currencyCode: "USD" },
        target:
          i % 8 === 0
            ? {
                scopeMode: "landing",
                productIds: [`gid://shopify/Product/${10000000000000 + i}`],
                requiredLineAttributeValue: `landing-${i}`,
                requiredAnchorVariantIds: [`gid://shopify/ProductVariant/${50000000000000 + i}`],
                maxUnitsPerProduct: 1,
              }
            : { scopeMode: "sitewide", productIds: [`gid://shopify/Product/${10000000000000 + i}`] },
      });
    }
    if (isStop) {
      policyRows.push({ shopId: id, offerId, stopLowerPriority: true });
    }
    if (!isOrder && !isStop && i % 41 === 0) {
      conditionRows.push({
        shopId: id,
        offerId,
        scope: "main",
        conditionType: "cart_attribute",
        operator: "eq",
        value: { key: KEYS[(i / 41) % KEYS.length]!, value: "yes", matchMode: "equals" },
      });
    }
    if (!isOrder && !isStop && i % 29 === 0) {
      conditionRows.push({
        shopId: id,
        offerId,
        scope: "main",
        conditionType: "customer_tags",
        operator: "any",
        value: { includeTags: [`tag-${i % 17}`], excludeTags: [] },
      });
    }
  }
  await db.insert(offerRewards).values(rewardRows);
  if (conditionRows.length > 0) await db.insert(offerConditions).values(conditionRows);
  if (policyRows.length > 0) await db.insert(offerCombinationPolicies).values(policyRows);
  return ids;
}

const strip = (raw: string) => {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  delete parsed["compiledAt"];
  return parsed;
};
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

const shardRows = async () =>
  (await db.select().from(discountShards).where(and(eq(discountShards.shopId, shopId), eq(discountShards.kind, "cart")))).sort(
    (a, b) => a.slot - b.slot,
  );
const assignment = async () => {
  const map = new Map<string, number>();
  for (const row of await shardRows()) for (const key of row.unitKeys) map.set(key, row.slot);
  return map;
};
const slotOwner = (row: { slot: number; discountNodeId: string | null }) => row.discountNodeId!;
const metafieldSetCalls = () => shopify.mutations.filter((name) => name === "MetafieldsSet").length;

const COUNT = 100;

// The whole suite runs with combination groups off (today's behavior) and on (the production default).
describe.each(["off", "on"])("sharded cart publish (combination groups default %s)", (domainsDefault) => {
  let ids: string[];

  beforeEach(async () => {
    vi.stubEnv("FUNCTION_SHARD_DOMAINS_DEFAULT", domainsDefault);
    shopId = await freshShop();
  });

  describe("150 offers, flag on", () => {
    beforeEach(async () => {
      ids = await seedCatalog(shopId, COUNT, 10, 10);
      await setFunctionShardsEnabled(db, shopId, true);
    });

    it("packs every slot under 9500 B with one atomic metafieldsSet and persists the plan", async () => {
      await publishOffersForShop(shopId, DOMAIN);

      const rows = await shardRows();
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.length).toBeLessThanOrEqual(11);
      expect(metafieldSetCalls()).toBe(1);
      const batch = shopify.metafieldsSets[0]!;
      expect(new Set(batch.map((m) => m.ownerId))).toEqual(new Set([...rows.map(slotOwner), DELIVERY_NODE]));
      expect(batch).toHaveLength((rows.length + 1) * 2);
      expect(rows.length + 1).toBeLessThanOrEqual(12);
      expect(batch.slice(0, 2).map((m) => m.namespace)).toEqual(["promo_engine", "$app:promo_engine"]);

      const seen: string[] = [];
      for (const row of rows) {
        const raw = shopify.metafields.get(slotOwner(row))!.get("promo_engine")!;
        expect(bytes(raw)).toBeLessThanOrEqual(SLOT_LIMITS.slotBytes);
        expect(row.configBytes).toBe(bytes(raw));
        expect(row.configHash).toBe(configHash(raw));
        expect(row.publishedAt).not.toBeNull();
        const value = shopify.value(slotOwner(row));
        expect(value.offers.map((offer) => offer.id).sort()).toEqual([...row.unitKeys].sort());
        expect(shopify.metafields.get(slotOwner(row))!.get("$app:promo_engine")).toBe(raw);
        seen.push(...row.unitKeys);
      }
      expect(seen.sort()).toEqual([...ids].sort());

      const slot0 = rows[0]!;
      expect(slot0.slot).toBe(0);
      expect(slot0.discountNodeId).toBe(CART_NODE);
      const ordersAndStops = ids.slice(0, 20);
      for (const id of ordersAndStops) expect(slot0.unitKeys).toContain(id);

      for (const node of shopify.shardNodeIds()) expect(shopify.nodes.get(node)!.classes).toEqual(["PRODUCT"]);
      expect(new Set(shopify.policyUpdates)).toEqual(new Set([CART_NODE, DELIVERY_NODE, ...shopify.shardNodeIds()]));
      const delivery = shopify.value(DELIVERY_NODE);
      expect(delivery.offers).toEqual([]);
    });

    it("records every shard node in the manifest with its own value", async () => {
      await publishOffersForShop(shopId, DOMAIN);

      const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "publish_manifest.v1")));
      const manifest = JSON.parse(row!.value) as { nodes: Record<string, { kind: string; hash: string }> };
      for (const shard of await shardRows()) {
        const node = manifest.nodes[slotOwner(shard)]!;
        expect(node.kind).toBe(shard.slot === 0 ? "cart" : "cart-shard");
        expect(node.hash).toBe(shard.configHash);
      }
    });

    it("a second publish moves nothing and leaves every metafield unchanged", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      const before = await assignment();
      const values = new Map([...shopify.metafields].map(([owner, ns]) => [owner, strip(ns.get("promo_engine")!)]));
      const createdBefore = shopify.created.length;

      await publishOffersForShop(shopId, DOMAIN);

      expect(await assignment()).toEqual(before);
      for (const [owner, value] of values) expect(strip(shopify.metafields.get(owner)!.get("promo_engine")!)).toEqual(value);
      expect(shopify.created).toHaveLength(createdBefore);
      expect(shopify.deleted).toEqual([]);
    });

    it("editing one offer moves at most one unit", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      const before = await assignment();
      const target = ids[50]!;
      await db
        .update(offerRewards)
        .set({ value: { amount: 77, currencyCode: "USD" }, target: { scopeMode: "sitewide", productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2", "gid://shopify/Product/3"] } })
        .where(eq(offerRewards.offerId, target));

      await publishOffersForShop(shopId, DOMAIN);

      const after = await assignment();
      const moved = [...before].filter(([key, slot]) => after.get(key) !== slot);
      expect(moved.length).toBeLessThanOrEqual(1);
      expect(after.size).toBe(COUNT);
    });

    it("recreates a shard node the merchant deleted, without moving units", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      const before = await assignment();
      const victim = shopify.shardNodeIds()[1]!;
      shopify.nodes.delete(victim);
      shopify.metafields.delete(victim);

      await publishOffersForShop(shopId, DOMAIN);

      expect(shopify.created).toHaveLength(shopify.shardNodeIds().length + 1);
      expect(shopify.nodes.has(victim)).toBe(false);
      for (const row of await shardRows()) expect(shopify.nodes.has(slotOwner(row))).toBe(true);
      expect(await assignment()).toEqual(before);
    });

    it("does not recreate a merchant-deleted shard node only to drain it", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      const rows = await shardRows();
      const last = rows.at(-1)!;
      expect(last.slot).toBeGreaterThanOrEqual(2);
      await db.update(offers).set({ status: "paused" }).where(inArray(offers.id, last.unitKeys));
      shopify.nodes.delete(slotOwner(last));
      shopify.metafields.delete(slotOwner(last));
      const created = shopify.created.length;

      await publishOffersForShop(shopId, DOMAIN);

      expect(shopify.created).toHaveLength(created);
      expect(shopify.deleted).toEqual([]);
      const after = await shardRows();
      expect(after.filter((row) => row.unitKeys.length > 0)).toHaveLength(rows.length - 1);
      expect(shopify.shardNodeIds()).toHaveLength(rows.length - 2);
    });

    it("maps a blocked plan to a shop-scoped failure with the structured capacity error and offer names", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      await setFunctionShardsEnabled(db, shopId, false);
      await db.delete(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.conditionType, "cart_attribute")));
      const writes = shopify.mutations.length;

      const failure = await tryPublishShop(shopId, DOMAIN);

      expect(failure).toMatchObject({ scope: "shop", capacity: { code: "SLOT_FULL" } });
      expect(failure!.capacity!.offerIds.length).toBeGreaterThan(0);
      expect(failure!.capacity!.offerIds.every((id) => ids.includes(id))).toBe(true);
      expect(failure!.message).toMatch(/Offers that don't fit: "Offer \d+"/);
      expect(failure!.message).not.toContain(failure!.capacity!.offerIds[0]!);
      expect(shopify.mutations).toHaveLength(writes);
    });

    it("detects a shard node deleted out of band and the next publish recreates it with the same slot value", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const rows = await shardRows();
      const victim = rows[1]!;
      const before = strip(shopify.metafields.get(slotOwner(victim))!.get("promo_engine")!);
      shopify.nodes.delete(slotOwner(victim));
      shopify.metafields.delete(slotOwner(victim));
      const drift = { graphQL: shopify.call as never, publish: publishOffersForShop, settleMs: 0, globallyPaused: false };

      const dry = await repairShopDrift(db, drift, { shopId, dryRun: true });
      expect(dry.findings.filter((f) => f.nodeId)).toEqual([expect.objectContaining({ issue: "missing_node", nodeId: slotOwner(victim) })]);

      await publishOffersForShop(shopId, DOMAIN);

      const after = (await shardRows()).find((row) => row.slot === victim.slot)!;
      expect(after.discountNodeId).not.toBe(slotOwner(victim));
      expect(strip(shopify.metafields.get(slotOwner(after))!.get("promo_engine")!)).toEqual(before);
      expect((await repairShopDrift(db, drift, { shopId, dryRun: true })).findings.filter((f) => f.nodeId)).toEqual([]);
    });

    it("detects a shard metafield edited out of band and the repair republish restores only that node", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      const rows = await shardRows();
      const victim = rows[1]!;
      const original = new Map([...shopify.metafields].map(([owner, ns]) => [owner, ns.get("promo_engine")!]));
      shopify.setMetafield(slotOwner(victim), "promo_engine", JSON.stringify({ offers: [], shippingOffers: [], version: "1", compiledAt: "x" }));
      const created = shopify.created.length;
      const drift = { graphQL: shopify.call as never, publish: publishOffersForShop, settleMs: 0, globallyPaused: false };

      const dry = await repairShopDrift(db, drift, { shopId, dryRun: true });
      expect(dry.findings.filter((f) => f.nodeId)).toEqual([expect.objectContaining({ issue: "config_mismatch", nodeId: slotOwner(victim) })]);

      await repairShopDrift(db, drift, { shopId, dryRun: false });

      for (const [owner, value] of original) expect(strip(shopify.metafields.get(owner)!.get("promo_engine")!)).toEqual(strip(value));
      expect(shopify.created).toHaveLength(created);
      expect((await repairShopDrift(db, drift, { shopId, dryRun: true })).findings.filter((f) => f.nodeId)).toEqual([]);
    });

    it("converges after a crash following the metafieldsSet, with no moves and no duplicate nodes", async () => {
      shopify.crashAfterMetafieldsSet = true;
      await expect(publishOffersForShop(shopId, DOMAIN)).rejects.toThrow("process died after metafieldsSet");
      const nodesAfterCrash = shopify.shardNodeIds().length;
      expect((await assignment()).size).toBe(0);

      await publishOffersForShop(shopId, DOMAIN);

      const rows = await shardRows();
      expect(shopify.shardNodeIds()).toHaveLength(nodesAfterCrash);
      expect(rows).toHaveLength(nodesAfterCrash + 1);
      expect((await assignment()).size).toBe(COUNT);
      const settled = await assignment();
      await publishOffersForShop(shopId, DOMAIN);
      expect(await assignment()).toEqual(settled);
    });

    it("drains and deletes shards once the flag is turned off and everything fits in slot 0", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      const shards = shopify.shardNodeIds();
      expect(shards.length).toBeGreaterThan(0);
      await setFunctionShardsEnabled(db, shopId, false);
      await db.update(offers).set({ status: "paused" }).where(eq(offers.shopId, shopId));
      await db.update(offers).set({ status: "active" }).where(inArray(offers.id, ids.slice(0, 6)));

      await publishOffersForShop(shopId, DOMAIN);

      expect(shopify.shardNodeIds()).toEqual([]);
      expect(shopify.deleted.sort()).toEqual([...shards].sort());
      const emptied = shopify.metafieldsSets.at(-1)!.filter((m) => shards.includes(m.ownerId));
      expect(emptied).toHaveLength(shards.length * 2);
      for (const m of emptied) expect(JSON.parse(m.value).offers).toEqual([]);
      expect((await shardRows()).map((row) => row.slot)).toEqual([0]);
    });

    it("single-shard overflow blocks with the planner payload before any Shopify write", async () => {
      await publishOffersForShop(shopId, DOMAIN);
      await setFunctionShardsEnabled(db, shopId, false);
      await db.delete(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.conditionType, "cart_attribute")));
      const sets = shopify.metafieldsSets.length;
      const writes = shopify.mutations.length;

      const error = await publishOffersForShop(shopId, DOMAIN).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ShardPlanBlockedError);
      expect((error as InstanceType<typeof ShardPlanBlockedError>).blocked.code).toBe("SLOT_FULL");
      expect((error as Error).message).toMatch(/^The shared automatic config would be \d+B, over the 9500B limit\. Pause or simplify other automatic offers first\. Offers that don't fit: "Offer \d+"/);
      expect((error as Error).message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(shopify.metafieldsSets).toHaveLength(sets);
      expect(shopify.mutations).toHaveLength(writes);
    });
  });

  describe("combination domains", () => {
    const nonCombining = async (offerIds: string[], productDiscounts = false) => {
      await db.delete(offerCombinationPolicies).where(inArray(offerCombinationPolicies.offerId, offerIds));
      await db.insert(offerCombinationPolicies).values(
        offerIds.map((offerId) => ({ shopId, offerId, combinesWithProductDiscounts: productDiscounts })),
      );
    };
    const budget = { storeActive: 5, ours: 2, others: 3, maxCartSlots: 11 };

    beforeEach(async () => {
      ids = await seedCatalog(shopId, COUNT, 0, 0);
      await setFunctionShardsEnabled(db, shopId, true);
    });

    it("splits a shop with non-combining offers instead of blocking, each node carrying its own policy", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      const nc = [ids[3]!, ids[40]!];
      await nonCombining(nc);

      await publishOffersForShop(shopId, DOMAIN);

      const rows = await shardRows();
      expect(rows.length).toBeGreaterThan(2);
      const closed = rows.filter((row) => !shopify.policies.get(slotOwner(row))!.productDiscounts);
      expect(closed.map((row) => row.slot)).toEqual([0]);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });
      for (const row of rows.slice(1)) expect(shopify.policies.get(slotOwner(row))).toMatchObject({ productDiscounts: true });
      const inSlot0 = new Set(shopify.value(CART_NODE).offers.map((offer) => offer.id));
      for (const id of nc) expect(inSlot0.has(id)).toBe(true);
      expect((await assignment()).size).toBe(COUNT);
    });

    it("records each node's combinesWith in the manifest so drift can compare it", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      await nonCombining([ids[3]!]);
      await publishOffersForShop(shopId, DOMAIN);

      const { readPublishManifest } = await import("../publish-manifest.server.js");
      const manifest = (await readPublishManifest(shopId, db))!;
      expect(manifest.nodes[CART_NODE]!.combinesWith).toMatchObject({ productDiscounts: false });
      const shardNode = (await shardRows())[1]!;
      expect(manifest.nodes[slotOwner(shardNode)]!.combinesWith).toMatchObject({ productDiscounts: true });
      const drift = { graphQL: shopify.call as never, publish: publishOffersForShop, settleMs: 0, globallyPaused: false };
      expect((await repairShopDrift(db, drift, { shopId, dryRun: true })).findings.filter((f) => f.nodeId)).toEqual([]);
    });

    it("tightens before the config swap and loosens after it", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      const nc = [ids[3]!, ids[40]!];
      await nonCombining(nc);
      await publishOffersForShop(shopId, DOMAIN);
      shopify.timeline = [];

      await nonCombining(nc, true);
      await publishOffersForShop(shopId, DOMAIN);

      const swap = shopify.timeline.indexOf("swap");
      expect(swap).toBeGreaterThan(0);
      const before = shopify.timeline.slice(0, swap).filter((entry) => entry.startsWith(`policy:${CART_NODE}`));
      const after = shopify.timeline.slice(swap + 1).filter((entry) => entry.startsWith(`policy:${CART_NODE}`));
      expect(before).toEqual([`policy:${CART_NODE}:closed`]);
      expect(after).toEqual([`policy:${CART_NODE}:open`]);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: true });
    });

    it("a crash after the swap leaves the node restrictive and the next publish converges", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      const nc = [ids[3]!, ids[40]!];
      await nonCombining(nc);
      await publishOffersForShop(shopId, DOMAIN);

      await nonCombining(nc, true);
      shopify.crashAfterMetafieldsSet = true;
      await expect(publishOffersForShop(shopId, DOMAIN)).rejects.toThrow("process died after metafieldsSet");
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });

      await publishOffersForShop(shopId, DOMAIN);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: true });
    });

    it("a stale manifest cannot loosen a node before its swap: crash after the swap, offer flipped back, next swap fails", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      await publishOffersForShop(shopId, DOMAIN);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: true });

      // Every offer of slot 0 stops combining: they stay together in slot 0, whose manifest entry still says open.
      const nc = shopify.value(CART_NODE).offers.map((offer) => offer.id);
      await nonCombining(nc);
      shopify.crashAfterMetafieldsSet = true;
      await expect(publishOffersForShop(shopId, DOMAIN)).rejects.toThrow("process died after metafieldsSet");
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });
      expect(shopify.value(CART_NODE).offers.map((offer) => offer.id)).toEqual(nc);

      await nonCombining(nc, true);
      shopify.failMetafieldsSet = true;
      await expect(publishOffersForShop(shopId, DOMAIN)).rejects.toThrow("metafieldsSet failed");

      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });
      expect(shopify.timeline.filter((entry) => entry === `policy:${CART_NODE}:open`)).toHaveLength(1);
    });

    it("the manifest guard alone holds: live reads failing, a swap crash, the offer flipped back, a failing swap", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      await publishOffersForShop(shopId, DOMAIN);
      const nc = shopify.value(CART_NODE).offers.map((offer) => offer.id);
      await nonCombining(nc);
      shopify.failLiveRead = true;
      shopify.crashAfterMetafieldsSet = true;
      await expect(publishOffersForShop(shopId, DOMAIN)).rejects.toThrow("process died after metafieldsSet");
      await nonCombining(nc, true);
      shopify.failMetafieldsSet = true;
      await expect(publishOffersForShop(shopId, DOMAIN)).rejects.toThrow("metafieldsSet failed");
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });
    });

    it("persists the tightened policy to the manifest before the swap", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      await publishOffersForShop(shopId, DOMAIN);
      await nonCombining(shopify.value(CART_NODE).offers.map((offer) => offer.id));
      shopify.failMetafieldsSet = true;
      await expect(publishOffersForShop(shopId, DOMAIN)).rejects.toThrow("metafieldsSet failed");
      const { readPublishManifest } = await import("../publish-manifest.server.js");
      expect((await readPublishManifest(shopId, db))!.nodes[CART_NODE]!.combinesWith).toMatchObject({ productDiscounts: false });
    });

    it("tightens to the live policy even when the manifest says open", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      await publishOffersForShop(shopId, DOMAIN);
      shopify.policies.set(CART_NODE, { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true });
      shopify.timeline = [];
      await publishOffersForShop(shopId, DOMAIN);
      const swap = shopify.timeline.indexOf("swap");
      expect(shopify.timeline.slice(0, swap)).toContain(`policy:${CART_NODE}:closed`);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: true });
    });

    it("a failed live read fails closed: the node tightens to manifest and new, and nothing is loosened", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      const nc = [ids[3]!];
      await nonCombining(nc);
      await publishOffersForShop(shopId, DOMAIN);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });

      await nonCombining(nc, true);
      shopify.failLiveRead = true;
      shopify.timeline = [];
      await publishOffersForShop(shopId, DOMAIN);

      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });
      expect(shopify.timeline.filter((entry) => entry.startsWith(`policy:${CART_NODE}:open`))).toEqual([]);

      shopify.failLiveRead = false;
      await publishOffersForShop(shopId, DOMAIN);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: true });
    });

    it("drift repair of a node a merchant loosened tightens it again before the swap", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      await nonCombining([ids[3]!]);
      await publishOffersForShop(shopId, DOMAIN);
      shopify.policies.set(CART_NODE, { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true });
      const drift = { graphQL: shopify.call as never, publish: publishOffersForShop, settleMs: 0, globallyPaused: false };

      const dry = await repairShopDrift(db, drift, { shopId, dryRun: true });
      expect(dry.findings.map((finding) => finding.issue)).toContain("combination_mismatch");
      shopify.timeline = [];
      await repairShopDrift(db, drift, { shopId, dryRun: false });

      const swap = shopify.timeline.indexOf("swap");
      expect(shopify.timeline.slice(0, swap)).toContain(`policy:${CART_NODE}:closed`);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });
    });

    it("with the setting off a non-combining offer still blocks growth, writing nothing", async () => {
      await setShardDomainsEnabled(db, shopId, false);
      await nonCombining([ids[3]!]);

      const error = await publishOffersForShop(shopId, DOMAIN).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ShardPlanBlockedError);
      expect((error as InstanceType<typeof ShardPlanBlockedError>).capacity.code).toBe("COMBINATION_SINGLE_SHARD");
      expect(shopify.metafieldsSets).toEqual([]);
    });

    it("the global env switch overrides a shop that has the setting on", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      await nonCombining([ids[3]!]);
      vi.stubEnv("FUNCTION_SHARD_DOMAINS", "off");
      try {
        const error = await publishOffersForShop(shopId, DOMAIN).catch((caught: unknown) => caught);
        expect((error as InstanceType<typeof ShardPlanBlockedError>).capacity.code).toBe("COMBINATION_SINGLE_SHARD");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("an unset setting follows the default, which is on outside the test env", async () => {
      await nonCombining([ids[3]!]);
      vi.stubEnv("FUNCTION_SHARD_DOMAINS_DEFAULT", "on");
      try {
        await publishOffersForShop(shopId, DOMAIN);
        expect((await shardRows()).length).toBeGreaterThan(1);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("preflight uses the publisher's mode and reports the combination groups", async () => {
      await setShardDomainsEnabled(db, shopId, true);
      await nonCombining([ids[3]!, ids[40]!]);
      const preflight = await preflightCapacity(db, shopId, [], { shardsEnabled: true, loadBudget: async () => budget });
      expect(preflight.ok).toBe(true);
      await publishOffersForShop(shopId, DOMAIN);
      const rows = await shardRows();
      if (!preflight.ok) return;
      const closedNodes = rows.filter((row) => !shopify.policies.get(slotOwner(row))!.productDiscounts).length;
      expect(preflight.plan.slots).toBeGreaterThan(1);
      expect(preflight.plan.combinationGroups).toMatchObject({ nonCombining: 2, nonCombiningNodes: closedNodes });
      expect(preflight.plan.combinationGroups!.nodes).toBe(preflight.plan.slots);
    });

    it("preflight with the setting off reports COMBINATION_SINGLE_SHARD", async () => {
      await setShardDomainsEnabled(db, shopId, false);
      await nonCombining([ids[3]!]);
      const preflight = await preflightCapacity(db, shopId, [], { shardsEnabled: true, loadBudget: async () => budget });
      expect(preflight).toMatchObject({ ok: false, code: "COMBINATION_SINGLE_SHARD" });
    });

    it("a shop that fits one node makes the same calls whatever the setting says", async () => {
      await db.delete(offers).where(eq(offers.shopId, shopId));
      ids = await seedCatalog(shopId, 6, 0, 0);
      await nonCombining([ids[1]!]);
      await setShardDomainsEnabled(db, shopId, false);
      await publishOffersForShop(shopId, DOMAIN);
      const off = { mutations: [...shopify.mutations], policies: new Map(shopify.policies), cart: strip(shopify.metafields.get(CART_NODE)!.get("promo_engine")!) };

      shopify.reset();
      await setShardDomainsEnabled(db, shopId, true);
      await publishOffersForShop(shopId, DOMAIN);

      expect(shopify.mutations).toEqual(off.mutations);
      expect(shopify.policies).toEqual(off.policies);
      expect(strip(shopify.metafields.get(CART_NODE)!.get("promo_engine")!)).toEqual(off.cart);
      expect(shopify.policies.get(CART_NODE)).toMatchObject({ productDiscounts: false });
    });
  });

  describe("flag off", () => {
    it("makes the same calls as before sharding: two owners, legacy namespace first, no pool traffic", async () => {
      ids = await seedCatalog(shopId, 6, 1, 1);

      await publishOffersForShop(shopId, DOMAIN);

      expect(shopify.mutations).toEqual([
        "UpdatePromoEngineDiscountCombination",
        "UpdatePromoEngineDiscountCombination",
        "MetafieldsSet",
        "PromoEngineStorefrontMetafields",
      ]);
      expect(shopify.policyUpdates.sort()).toEqual([CART_NODE, DELIVERY_NODE]);
      const [batch] = shopify.metafieldsSets;
      expect(batch!.map((m) => [m.ownerId, m.namespace, m.key])).toEqual([
        [CART_NODE, "promo_engine", "function_config"],
        [CART_NODE, "$app:promo_engine", "function_config"],
        [DELIVERY_NODE, "promo_engine", "function_config"],
        [DELIVERY_NODE, "$app:promo_engine", "function_config"],
      ]);
      expect(batch![0]!.value).toBe(batch![1]!.value);
      const cart = JSON.parse(batch![0]!.value) as { offers: Array<{ id: string }>; shippingOffers: unknown[]; version: string };
      expect(cart.offers.map((offer) => offer.id).sort()).toEqual([...ids].sort());
      expect(cart.shippingOffers ?? []).toEqual([]);
      expect(shopify.created).toEqual([]);
      expect(await shardRows()).toHaveLength(0);
    });

    it("a flag-on publish that fits in one slot writes exactly the flag-off value", async () => {
      ids = await seedCatalog(shopId, 6, 1, 1);
      await publishOffersForShop(shopId, DOMAIN);
      const off = strip(shopify.metafields.get(CART_NODE)!.get("promo_engine")!);

      await setFunctionShardsEnabled(db, shopId, true);
      await publishOffersForShop(shopId, DOMAIN);

      expect(strip(shopify.metafields.get(CART_NODE)!.get("promo_engine")!)).toEqual(off);
      expect(shopify.shardNodeIds()).toEqual([]);
      expect(shopify.metafieldsSets.at(-1)).toHaveLength(4);
    });
  });

  describe("an offer bigger than one node", () => {
    const WHOLE = 900;
    const wholeProducts = Array.from({ length: WHOLE }, (_, n) => `gid://shopify/Product/${20000000000000 + n}`);

    async function seedHeavy(rewardTarget: Record<string, unknown> = { scopeMode: "sitewide", productIds: wholeProducts }) {
      const offerId = await seedOffer(db, shopId, {
        type: "discount",
        codeRedemption: "automatic",
        priority: 50,
        internalName: "Heavy catalog sale",
        publicTitle: "Catalog sale",
      });
      await db.insert(offerRewards).values({
        shopId,
        offerId,
        rewardType: "product_discount",
        discountType: "percentage",
        value: { amount: 15, currencyCode: "USD" },
        target: rewardTarget,
      });
      const [small] = await seedCatalog(shopId, 1, 0, 0);
      return { offerId, small: small! };
    }

    it("publishes the parts across slots under the same id and title, and a second publish moves nothing", async () => {
      const { offerId, small } = await seedHeavy();
      await setFunctionShardsEnabled(db, shopId, true);

      await publishOffersForShop(shopId, DOMAIN);

      const rows = await shardRows();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const covered: string[] = [];
      for (const row of rows) {
        const raw = shopify.metafields.get(slotOwner(row))!.get("promo_engine")!;
        expect(bytes(raw)).toBeLessThanOrEqual(SLOT_LIMITS.slotBytes);
        const published = shopify.value(slotOwner(row)).offers.filter((entry) => entry.id === offerId) as Array<{
          id: string;
          title?: string;
          productRewards: Array<{ targetProductIds: string[] }>;
        }>;
        expect(published.length).toBeLessThanOrEqual(1);
        for (const entry of published) {
          expect(entry.title).toBe("Catalog sale");
          covered.push(...entry.productRewards[0]!.targetProductIds);
        }
      }
      expect([...covered].sort()).toEqual([...wholeProducts].sort());
      const keys = rows.flatMap((row) => row.unitKeys);
      expect(keys.filter((key) => key.startsWith(`${offerId}#`)).length).toBeGreaterThanOrEqual(2);
      expect(keys).toContain(small);
      expect(keys).not.toContain(offerId);

      const before = await assignment();
      await publishOffersForShop(shopId, DOMAIN);
      expect(await assignment()).toEqual(before);
    });

    it("keeps today's cap with the flag off: the same offer is refused as too large", async () => {
      await seedHeavy();

      const error = await publishOffersForShop(shopId, DOMAIN).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ShardPlanBlockedError);
      expect(shopify.metafieldsSets).toHaveLength(0);
    });

    it("blocks an offer the Function cannot split without changing what it does", async () => {
      await seedHeavy({
        scopeMode: "sitewide",
        productIds: wholeProducts,
        maxUnitsTotal: 3,
      });
      await setFunctionShardsEnabled(db, shopId, true);

      const error = await publishOffersForShop(shopId, DOMAIN).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ShardPlanBlockedError);
      expect((error as InstanceType<typeof ShardPlanBlockedError>).blocked).toMatchObject({ code: "OFFER_TOO_LARGE", splitRefusal: "AGGREGATING_REWARD" });
      expect(shopify.metafieldsSets).toHaveLength(0);
    });
  });
});

const { preflightCapacity } = await import("../capacity-preflight.server.js");
const { automaticNodeBudget } = await import("../discount-node.server.js");
const { setFunctionCompactIdsEnabled } = await import("../function-compact-ids-flag.server.js");
const { setLimitsEnforced } = await import("../limits-enforced.server.js");

describe("preflight plans the same cart slots the publish writes", () => {

  const heavyProducts = Array.from({ length: 900 }, (_, n) => `gid://shopify/Product/${30000000000000 + n}`);

  async function seedSplitOffer() {
    const offerId = await seedOffer(db, shopId, { type: "discount", codeRedemption: "automatic", priority: 50, internalName: "Heavy", publicTitle: "Heavy" });
    await db.insert(offerRewards).values({
      shopId,
      offerId,
      rewardType: "product_discount",
      discountType: "percentage",
      value: { amount: 15, currencyCode: "USD" },
      target: { scopeMode: "sitewide", productIds: heavyProducts },
    });
    return offerId;
  }

  async function seedLegacyGated() {
    const offerId = await seedOffer(db, shopId, { type: "discount", codeRedemption: "automatic", priority: 60, internalName: "Legacy", publicTitle: "Legacy" });
    await db.insert(offerRewards).values({
      shopId,
      offerId,
      rewardType: "product_discount",
      discountType: "percentage",
      value: { amount: 5, currencyCode: "USD" },
      target: { scopeMode: "sitewide", productIds: heavyProducts.slice(0, 300) },
    });
    await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "discount_code", operator: "eq", value: { code: "OLD" } });
  }

  async function expectParity() {
    const preflight = await preflightCapacity(db, shopId, [], { loadBudget: (_db, id) => automaticNodeBudget(id, DOMAIN, "token") });
    if (!preflight.ok) throw new Error(`preflight blocked: ${preflight.code} ${preflight.message}`);
    const planned = preflight.plan;
    await publishOffersForShop(shopId, DOMAIN);
    const rows = (await shardRows()).filter((row) => row.unitKeys.length > 0);
    expect(planned.slots).toBe(rows.length);
    expect(planned.bytesPerSlot).toEqual(rows.map((row) => row.configBytes!));
    if (planned.policyPerSlot) expect(planned.policyPerSlot).toEqual(rows.map((row) => shopify.policies.get(slotOwner(row))));
    return rows;
  }

  describe("combination groups on, mixed non-combining offers", () => {
    beforeEach(async () => {
      shopId = await freshShop();
      await setFunctionShardsEnabled(db, shopId, true);
      await setShardDomainsEnabled(db, shopId, true);
    });

    it("preflight plans the persisted nodes: count, bytes and per-node combinesWith", async () => {
      const ids = await seedCatalog(shopId, COUNT, 10, 10);
      const flags = [
        { combinesWithProductDiscounts: false },
        { combinesWithOrderDiscounts: false },
        { combinesWithShippingDiscounts: false },
      ];
      await db.delete(offerCombinationPolicies).where(inArray(offerCombinationPolicies.offerId, ids.slice(30, 60)));
      await db
        .insert(offerCombinationPolicies)
        .values(ids.slice(30, 60).map((offerId, i) => ({ shopId, offerId, ...flags[i % 3]! })));
      const rows = await expectParity();
      expect(rows.length).toBeGreaterThanOrEqual(3);
      const policies = new Set(rows.map((row) => JSON.stringify(shopify.policies.get(slotOwner(row)))));
      expect(policies.size).toBeGreaterThanOrEqual(2);
      await expectParity();
    });
  });

  for (const compactIds of [false, true]) {
    describe(`compact ids ${compactIds ? "on" : "off"}`, () => {
      beforeEach(async () => {
        shopId = await freshShop();
        await setFunctionShardsEnabled(db, shopId, true);
        await setFunctionCompactIdsEnabled(db, shopId, compactIds);
      });

      it("100 offers", async () => {
        await seedCatalog(shopId, COUNT, 10, 10);
        await expectParity();
        await expectParity();
      });

      it("100 offers with per-cart limits enforced", async () => {
        const ids = await seedCatalog(shopId, COUNT, 10, 10);
        await db
          .insert(offerCombinationPolicies)
          .values(ids.map((offerId) => ({ shopId, offerId, maxApplicationsPerCart: 2, maxApplicationsPerCustomer: 3 })))
          .onConflictDoUpdate({ target: offerCombinationPolicies.offerId, set: { maxApplicationsPerCart: 2, maxApplicationsPerCustomer: 3 } });
        await setLimitsEnforced(db, shopId, true);
        await expectParity();
      });

      it("100 offers plus a split offer and a held-back legacy offer", async () => {
        await seedCatalog(shopId, COUNT, 10, 10);
        const heavy = await seedSplitOffer();
        await seedLegacyGated();
        const rows = await expectParity();
        expect(rows.flatMap((row) => row.unitKeys).filter((key) => key.startsWith(`${heavy}#`)).length).toBeGreaterThanOrEqual(2);
        await expectParity();
      });
    });
  }
});

import type * as PromoDb from "@promo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { discountCodes, offers, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => currentDb,
}));
vi.mock("./token-crypto.server.js", () => ({ decryptToken: async () => "token" }));
vi.mock("./sync/offer-publisher.server.js", () => ({
  FUNCTION_CONFIG_NAMESPACES: ["promo_engine", "$app:promo_engine"],
  publishOffersForShop: vi.fn(),
}));
const captureMessage = vi.fn();
const captureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
  captureException: (...args: unknown[]) => captureException(...args),
}));

const { runDiscountDriftRepair } = await import("./discount-reconciliation.server.js");
const { setDriftRepairPaused } = await import("./drift-repair-settings.server.js");
const { ManifestCollector, readPublishManifest, writePublishManifest } = await import("./publish-manifest.server.js");

let db: Db;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  currentDb = db;
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  captureMessage.mockClear();
  captureException.mockClear();
});

interface FakeNode {
  kind: "automatic" | "code";
  value: string | null;
  /** The $app:promo_engine copy; defaults to `value`. */
  appValue?: string | null;
  status: string;
  codesCount?: number;
  /** Codes the node actually holds, for the node-codes listing (defaults to none). */
  codes?: string[];
  /** Purchase-type flags Shopify holds; omitted means the node reports both true. */
  appliesOnSubscription?: boolean;
  appliesOnOneTimePurchase?: boolean;
}

/** A tiny stand-in for the part of Shopify the drift check reads, with a publish that can restore it. */
function fakeShopify(initial: Record<string, FakeNode>, validation: { present: boolean; value: string | null } = { present: false, value: null }) {
  const nodes: Record<string, FakeNode | null> = { ...initial };
  const calls: string[] = [];
  const graphQL = vi.fn(async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
    if (query.includes("PromoEngineDriftCheck")) {
      calls.push("drift-check");
      return {
        nodes: (variables!.ids as string[]).map((id) => {
          const node = nodes[id];
          if (!node) return null;
          const appValue = node.appValue === undefined ? node.value : node.appValue;
          const copies = {
            m0: node.value ? { value: node.value } : null,
            m1: appValue ? { value: appValue } : null,
          };
          const flags = {
            appliesOnSubscription: node.appliesOnSubscription ?? true,
            appliesOnOneTimePurchase: node.appliesOnOneTimePurchase ?? true,
          };
          return node.kind === "automatic"
            ? { __typename: "DiscountAutomaticNode", id, ...copies, automaticDiscount: { status: node.status, ...flags } }
            : {
                __typename: "DiscountCodeNode",
                id,
                ...copies,
                codeDiscount: { status: node.status, ...flags, codesCount: { count: node.codesCount ?? 0 } },
              };
        }),
      };
    }
    if (query.includes("PromoEngineNodeCodes")) {
      const node = nodes[variables!.id as string];
      return {
        codeDiscountNode: node
          ? { codeDiscount: { codes: { nodes: (node.codes ?? []).map((code) => ({ code })), pageInfo: { hasNextPage: false, endCursor: null } } } }
          : null,
      };
    }
    if (query.includes("PromoEngineValidationDrift")) {
      return {
        validations: {
          nodes: validation.present
            ? [{ shopifyFunction: { handle: "promo-engine-cart-validation" }, metafield: validation.value ? { value: validation.value } : null, appMetafield: validation.value ? { value: validation.value } : null }]
            : [],
        },
      };
    }
    if (query.includes("PromoEngineActivateAutomatic")) {
      calls.push(`activate:${variables!.id as string}`);
      nodes[variables!.id as string]!.status = "ACTIVE";
      return { discountAutomaticActivate: { userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
  return { nodes, calls, graphQL, validation };
}

async function seedPublishedShop(opts: { cartValue?: string; deliveryValue?: string } = {}) {
  counter += 1;
  const domain = `drift-${counter}.myshopify.com`;
  const shopId = await seedShop(db, domain);
  const cart = `gid://shopify/DiscountAutomaticNode/cart-${counter}`;
  const delivery = `gid://shopify/DiscountAutomaticNode/delivery-${counter}`;
  await db.update(shops).set({ discountId: cart, deliveryDiscountId: delivery }).where(eq(shops.id, shopId));
  const cartValue = opts.cartValue ?? JSON.stringify({ offers: [{ id: "o1" }], version: "1" });
  const collector = new ManifestCollector();
  collector.record(cart, "cart", cartValue);
  collector.record(delivery, "delivery", cartValue);
  await writePublishManifest(shopId, collector.build());
  return { shopId, domain, cart, delivery, cartValue, collector };
}

const run = (graphQL: ReturnType<typeof fakeShopify>["graphQL"], publish = vi.fn(async () => undefined)) =>
  runDiscountDriftRepair({ graphQL: graphQL as never, publish, settleMs: 0 }).then((result) => ({ result, publish }));

/** Other tests' shops are in the same database; look only at one's own. */
const onlyMine = (publish: ReturnType<typeof vi.fn>, shopId: string) =>
  publish.mock.calls.filter((call) => call[0] === shopId);

describe("runDiscountDriftRepair", () => {
  it("leaves a healthy shop alone and spends no publish on it", async () => {
    const shop = await seedPublishedShop();
    const { graphQL } = fakeShopify({
      [shop.cart]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
      [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
    });

    const { publish } = await run(graphQL);

    expect(onlyMine(publish, shop.shopId)).toEqual([]);
  });

  it("compares metafields by content, not by whitespace or key order", async () => {
    const shop = await seedPublishedShop({ cartValue: JSON.stringify({ b: 2, a: { y: 1, x: [1, 2] } }) });
    const reordered = '{ "a": { "x": [1,2], "y": 1 },\n  "b": 2 }';
    const { graphQL } = fakeShopify({
      [shop.cart]: { kind: "automatic", value: reordered, status: "ACTIVE" },
      [shop.delivery]: { kind: "automatic", value: reordered, status: "ACTIVE" },
    });
    const { publish } = await run(graphQL);
    expect(onlyMine(publish, shop.shopId)).toEqual([]);
  });

  it("repairs a deleted node by republishing, then confirms it is back", async () => {
    const shop = await seedPublishedShop();
    const fake = fakeShopify({
      [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
    });
    const publish = vi.fn(async (shopId: string) => {
      if (shopId === shop.shopId) fake.nodes[shop.cart] = { kind: "automatic", value: shop.cartValue, status: "ACTIVE" };
    });

    const { result } = await run(fake.graphQL, publish as never);

    expect(onlyMine(publish, shop.shopId)).toHaveLength(1);
    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
    expect(captureMessage).toHaveBeenCalledWith("Discount drift repaired", expect.objectContaining({ level: "warning" }));
  });

  it("repairs a function_config metafield the merchant edited or removed", async () => {
    for (const tampered of ['{"offers":[]}', null]) {
      const shop = await seedPublishedShop();
      const fake = fakeShopify({
        [shop.cart]: { kind: "automatic", value: tampered, status: "ACTIVE" },
        [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
      });
      const publish = vi.fn(async (shopId: string) => {
        if (shopId === shop.shopId) fake.nodes[shop.cart]!.value = shop.cartValue;
      });

      const { result } = await run(fake.graphQL, publish as never);

      expect(onlyMine(publish, shop.shopId)).toHaveLength(1);
      expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
    }
  });

  it("republishes a shop whose $app:promo_engine copy was never written (pre-namespace publish)", async () => {
    const shop = await seedPublishedShop();
    const fake = fakeShopify({
      [shop.cart]: { kind: "automatic", value: shop.cartValue, appValue: null, status: "ACTIVE" },
      [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
    });
    const publish = vi.fn(async (shopId: string) => {
      if (shopId === shop.shopId) fake.nodes[shop.cart]!.appValue = shop.cartValue;
    });

    const { result } = await run(fake.graphQL, publish as never);

    expect(onlyMine(publish, shop.shopId)).toHaveLength(1);
    expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
  });

  it("re-activates an automatic node the merchant switched off, then republishes", async () => {
    const shop = await seedPublishedShop();
    const fake = fakeShopify({
      [shop.cart]: { kind: "automatic", value: shop.cartValue, status: "EXPIRED" },
      [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
    });

    const { publish, result } = await run(fake.graphQL);

    expect(fake.calls).toContain(`activate:${shop.cart}`);
    expect(onlyMine(publish, shop.shopId)).toHaveLength(1);
    expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
  });

  it("treats a node with appliesOnSubscription=false as drift (it never discounts selling-plan lines) and republishes", async () => {
    const shop = await seedPublishedShop();
    const fake = fakeShopify({
      [shop.cart]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE", appliesOnSubscription: false },
      [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
    });
    let republished = false;
    const publish = vi.fn(async (shopId: string, _domain: string) => {
      if (shopId !== shop.shopId) return;
      republished = true;
      fake.nodes[shop.cart]!.appliesOnSubscription = true;
    });

    const { result } = await run(fake.graphQL, publish);

    expect(republished).toBe(true);
    expect(onlyMine(publish, shop.shopId)).toHaveLength(1);
    expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
  });

  it("expects the flags the manifest recorded for a per-offer code node", async () => {
    const shop = await seedPublishedShop();
    const codeId = `gid://shopify/DiscountCodeNode/restricted-${counter}`;
    shop.collector.record(codeId, "code", shop.cartValue, {
      purchaseTypes: { appliesOnSubscription: false, appliesOnOneTimePurchase: true },
    });
    await writePublishManifest(shop.shopId, shop.collector.build());
    const fake = fakeShopify({
      [shop.cart]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
      [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
      [codeId]: { kind: "code", value: shop.cartValue, status: "ACTIVE", appliesOnSubscription: false },
    });

    const { publish } = await run(fake.graphQL);

    expect(onlyMine(publish, shop.shopId)).toHaveLength(0);
  });

  describe("kill switch", () => {
    afterEach(() => vi.unstubAllEnvs());

    async function driftedShop() {
      const shop = await seedPublishedShop();
      const fake = fakeShopify({
        [shop.cart]: { kind: "automatic", value: shop.cartValue, status: "EXPIRED" },
        [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
      });
      return { shop, fake };
    }

    it("a shop with drift_repair.paused is detected but neither re-activated nor republished", async () => {
      const { shop, fake } = await driftedShop();
      await setDriftRepairPaused(shop.shopId, true);

      const { publish, result } = await run(fake.graphQL);

      expect(fake.calls.filter((call) => call.startsWith("activate:"))).toEqual([]);
      expect(onlyMine(publish, shop.shopId)).toEqual([]);
      expect(result.paused).toBeGreaterThanOrEqual(1);
      expect(captureMessage).toHaveBeenCalledWith(
        "Discount drift detected, repair is paused",
        expect.objectContaining({ level: "info", tags: expect.objectContaining({ shopId: shop.shopId }) }),
      );
      const mine = captureMessage.mock.calls.filter((call) => (call[1] as { tags?: { shopId?: string } })?.tags?.shopId === shop.shopId);
      expect(mine.map((call) => call[0])).toEqual(["Discount drift detected, repair is paused"]);

      // Un-pausing resumes the repair.
      await setDriftRepairPaused(shop.shopId, false);
      expect(onlyMine((await run(fake.graphQL)).publish, shop.shopId)).toHaveLength(1);
    });

    it("DRIFT_REPAIR_DISABLED=true pauses every shop", async () => {
      const { shop, fake } = await driftedShop();
      vi.stubEnv("DRIFT_REPAIR_DISABLED", "true");

      const { publish } = await run(fake.graphQL);

      expect(fake.calls.filter((call) => call.startsWith("activate:"))).toEqual([]);
      expect(onlyMine(publish, shop.shopId)).toEqual([]);
    });
  });

  it("re-reads the shop's node ids after the repair publish: a node the publish recreated is not reported missing", async () => {
    const shop = await seedPublishedShop();
    const newCart = `gid://shopify/DiscountAutomaticNode/recreated-${counter}`;
    const fake = fakeShopify({ [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" } });
    const publish = vi.fn(async (shopId: string) => {
      if (shopId !== shop.shopId) return;
      fake.nodes[newCart] = { kind: "automatic", value: shop.cartValue, status: "ACTIVE" };
      await db.update(shops).set({ discountId: newCart }).where(eq(shops.id, shopId));
      const collector = new ManifestCollector();
      collector.record(newCart, "cart", shop.cartValue);
      collector.record(shop.delivery, "delivery", shop.cartValue);
      await writePublishManifest(shopId, collector.build());
    });

    const { result } = await run(fake.graphQL, publish as never);

    expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
  });

  it("does not raise an unresolved alert when the repair publish was parked as pending (the retry finishes the job)", async () => {
    const shop = await seedPublishedShop();
    const fake = fakeShopify({ [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" } });
    const publish = vi.fn(async () => "pending");

    const { result } = await run(fake.graphQL, publish as never);

    expect(result.deferred).toBeGreaterThanOrEqual(1);
    expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
  });

  it("does not flag a code node that was deliberately expired", async () => {
    const shop = await seedPublishedShop();
    const code = `gid://shopify/DiscountCodeNode/stale-${counter}`;
    shop.collector.record(shop.cart, "cart", shop.cartValue);
    shop.collector.record(shop.delivery, "delivery", shop.cartValue);
    shop.collector.record(code, "code", '{"offers":[]}', { active: false });
    await writePublishManifest(shop.shopId, shop.collector.build());
    const { graphQL } = fakeShopify({
      [shop.cart]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
      [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
      [code]: { kind: "code", value: '{"offers":[]}', status: "EXPIRED", codesCount: 4 },
    });

    const { publish } = await run(graphQL);
    expect(onlyMine(publish, shop.shopId)).toEqual([]);
  });

  describe("code nodes", () => {
    async function withCodeNode(opts: { synced: number; shopifyCount: number; inFlight?: boolean }) {
      const shop = await seedPublishedShop();
      const codeNode = `gid://shopify/DiscountCodeNode/own-${counter}`;
      const offerId = await seedOffer(db, shop.shopId, { requiresCode: true });
      await db.update(offers).set({ codeDiscountId: codeNode }).where(eq(offers.id, offerId));
      await db.insert(discountCodes).values(
        Array.from({ length: opts.synced }, (_, i) => ({
          shopId: shop.shopId,
          offerId,
          code: `DRIFT${counter}-${i}`,
          shopifySyncedAt: new Date(),
          ...(opts.inFlight && i === 0 ? { shopifySyncPendingAt: new Date() } : {}),
        })),
      );
      shop.collector.record(shop.cart, "cart", shop.cartValue);
      shop.collector.record(shop.delivery, "delivery", shop.cartValue);
      shop.collector.record(codeNode, "code", '{"offers":[{"id":"x"}]}');
      await writePublishManifest(shop.shopId, shop.collector.build());
      const fake = fakeShopify({
        [shop.cart]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
        [shop.delivery]: { kind: "automatic", value: shop.cartValue, status: "ACTIVE" },
        [codeNode]: { kind: "code", value: '{"offers":[{"id":"x"}]}', status: "ACTIVE", codesCount: opts.shopifyCount },
      });
      return { ...shop, codeNode, fake };
    }

    it("is healthy when Shopify holds exactly the codes the database says it holds", async () => {
      const shop = await withCodeNode({ synced: 3, shopifyCount: 3 });
      const { publish } = await run(shop.fake.graphQL);
      expect(onlyMine(publish, shop.shopId)).toEqual([]);
    });

    it("repairs a node whose code count differs (codes deleted in the Shopify admin)", async () => {
      const shop = await withCodeNode({ synced: 3, shopifyCount: 1 });
      const publish = vi.fn(async (shopId: string) => {
        if (shopId === shop.shopId) shop.fake.nodes[shop.codeNode]!.codesCount = 3;
      });

      const { result } = await run(shop.fake.graphQL, publish as never);

      expect(onlyMine(publish, shop.shopId)).toHaveLength(1);
      expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
    });

    it("reports the node as unresolved when the repair publish cannot fix it (Shopify holds codes the app doesn't know)", async () => {
      const shop = await withCodeNode({ synced: 1, shopifyCount: 3 });
      shop.fake.nodes[shop.codeNode]!.codes = [`DRIFT${counter}-0`, "STRANGER-1", "STRANGER-2"];

      const { result } = await run(shop.fake.graphQL);

      const mine = result.unresolved.filter((f) => f.shopId === shop.shopId);
      expect(mine).toEqual([
        expect.objectContaining({ issue: "code_count_mismatch", nodeId: shop.codeNode, detail: "Shopify has 3 codes, the app expects 1" }),
      ]);
      expect(captureMessage).toHaveBeenCalledWith("Discount drift could not be repaired", expect.objectContaining({ level: "error" }));
    });

    it("queues a code deleted in the Shopify admin for exactly one re-add, then the node is whole again", async () => {
      const shop = await withCodeNode({ synced: 3, shopifyCount: 2 });
      shop.fake.nodes[shop.codeNode]!.codes = [`DRIFT${counter}-0`, `DRIFT${counter}-1`];
      let queuedBeforePublish: Array<{ code: string; readd: Date | null; synced: Date | null }> = [];
      const publish = vi.fn(async (shopId: string) => {
        if (shopId !== shop.shopId) return;
        queuedBeforePublish = (await db.select().from(discountCodes).where(eq(discountCodes.shopId, shopId))).map((row) => ({
          code: row.code,
          readd: row.shopifyReaddAttemptedAt,
          synced: row.shopifySyncedAt,
        }));
        // The publisher adds the queued code back and marks it synced.
        shop.fake.nodes[shop.codeNode]!.codesCount = 3;
        await db
          .update(discountCodes)
          .set({ shopifySyncedAt: new Date(), shopifyReaddAttemptedAt: null })
          .where(eq(discountCodes.code, `DRIFT${counter}-2`));
      });

      const { result } = await run(shop.fake.graphQL, publish as never);

      expect(queuedBeforePublish.filter((row) => row.readd)).toEqual([
        expect.objectContaining({ code: `DRIFT${counter}-2`, synced: null }),
      ]);
      expect(result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);
    });

    it("a code the publisher had to disable (taken / rejected on re-add) leaves the counts equal: no endless loop", async () => {
      const shop = await withCodeNode({ synced: 3, shopifyCount: 2 });
      shop.fake.nodes[shop.codeNode]!.codes = [`DRIFT${counter}-0`, `DRIFT${counter}-1`];
      const publish = vi.fn(async (shopId: string) => {
        if (shopId !== shop.shopId) return;
        await db
          .update(discountCodes)
          .set({ status: "disabled", syncNote: "taken", shopifySyncedAt: null, shopifyReaddAttemptedAt: null })
          .where(eq(discountCodes.code, `DRIFT${counter}-2`));
      });

      const first = await run(shop.fake.graphQL, publish as never);
      expect(first.result.unresolved.filter((f) => f.shopId === shop.shopId)).toEqual([]);

      const second = await run(shop.fake.graphQL);
      expect(onlyMine(second.publish, shop.shopId)).toEqual([]);
    });

    it("does not read a count mismatch as drift while codes are in flight", async () => {
      const shop = await withCodeNode({ synced: 3, shopifyCount: 1, inFlight: true });
      const { publish } = await run(shop.fake.graphQL);
      expect(onlyMine(publish, shop.shopId)).toEqual([]);
    });
  });

  it("checks the cart-validation config too", async () => {
    const shop = await seedPublishedShop();
    shop.collector.validationHash = (await import("./publish-manifest.server.js")).configHash('{"offerRules":{}}');
    await writePublishManifest(shop.shopId, shop.collector.build());
    const nodes = {
      [shop.cart]: { kind: "automatic" as const, value: shop.cartValue, status: "ACTIVE" },
      [shop.delivery]: { kind: "automatic" as const, value: shop.cartValue, status: "ACTIVE" },
    };

    const healthy = fakeShopify(nodes, { present: true, value: '{ "offerRules": {} }' });
    expect(onlyMine((await run(healthy.graphQL)).publish, shop.shopId)).toEqual([]);

    const edited = fakeShopify(nodes, { present: true, value: '{"offerRules":{"x":1}}' });
    expect(onlyMine((await run(edited.graphQL)).publish, shop.shopId)).toHaveLength(1);

    const deleted = fakeShopify(nodes, { present: false, value: null });
    const { result } = await run(deleted.graphQL);
    expect(result.unresolved.filter((f) => f.shopId === shop.shopId).map((f) => f.issue)).toEqual(["validation_missing"]);
  });

  it("republishes a shop that has no manifest (published before manifests and the $app copy existed)", async () => {
    counter += 1;
    const shopId = await seedShop(db, `drift-nomanifest-${counter}.myshopify.com`);
    const cart = `gid://shopify/DiscountAutomaticNode/c-${counter}`;
    const delivery = `gid://shopify/DiscountAutomaticNode/d-${counter}`;
    await db.update(shops).set({ discountId: cart, deliveryDiscountId: delivery }).where(eq(shops.id, shopId));
    expect(await readPublishManifest(shopId)).toBeNull();

    const present = fakeShopify({
      [cart]: { kind: "automatic", value: "{}", status: "ACTIVE" },
      [delivery]: { kind: "automatic", value: "{}", status: "ACTIVE" },
    });
    expect(onlyMine((await run(present.graphQL)).publish, shopId)).toHaveLength(1);

    const missing = fakeShopify({ [cart]: { kind: "automatic", value: "{}", status: "ACTIVE" } });
    expect(onlyMine((await run(missing.graphQL)).publish, shopId)).toHaveLength(1);
  });

  it("skips a shop whose publish just finished: its metafields may be mid-write", async () => {
    const shop = await seedPublishedShop();
    const { graphQL } = fakeShopify({});
    const publish = vi.fn(async () => undefined);

    await runDiscountDriftRepair({ graphQL: graphQL as never, publish });

    expect(onlyMine(publish, shop.shopId)).toEqual([]);
  });

  it("ignores shops that never published and shops that are uninstalled", async () => {
    counter += 1;
    const neverPublished = await seedShop(db, `drift-never-${counter}.myshopify.com`);
    const uninstalled = await seedPublishedShop();
    await db.update(shops).set({ isActive: false }).where(eq(shops.id, uninstalled.shopId));

    const { publish } = await run(fakeShopify({}).graphQL);

    expect(onlyMine(publish, neverPublished)).toEqual([]);
    expect(onlyMine(publish, uninstalled.shopId)).toEqual([]);
  });

  it("keeps going after one shop's repair throws, and reports it", async () => {
    const broken = await seedPublishedShop();
    const fine = await seedPublishedShop();
    const fake = fakeShopify({
      // Both lose their cart node.
      [broken.delivery]: { kind: "automatic", value: broken.cartValue, status: "ACTIVE" },
      [fine.delivery]: { kind: "automatic", value: fine.cartValue, status: "ACTIVE" },
    });
    const publish = vi.fn(async (shopId: string) => {
      if (shopId === broken.shopId) throw new Error("Shopify down");
      if (shopId === fine.shopId) fake.nodes[fine.cart] = { kind: "automatic", value: fine.cartValue, status: "ACTIVE" };
    });

    const { result } = await run(fake.graphQL, publish as never);

    expect(result.failures).toContainEqual({ shopId: broken.shopId, error: "Shopify down" });
    expect(captureException).toHaveBeenCalled();
    expect(onlyMine(publish, fine.shopId)).toHaveLength(1);
    expect(result.unresolved.filter((f) => f.shopId === fine.shopId)).toEqual([]);
  });
});

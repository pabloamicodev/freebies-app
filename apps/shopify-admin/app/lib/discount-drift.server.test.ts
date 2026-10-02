import type * as PromoDb from "@promo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
          return node.kind === "automatic"
            ? { __typename: "DiscountAutomaticNode", id, ...copies, automaticDiscount: { status: node.status } }
            : {
                __typename: "DiscountCodeNode",
                id,
                ...copies,
                codeDiscount: { status: node.status, codesCount: { count: node.codesCount ?? 0 } },
              };
        }),
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

    it("reports the node as unresolved when the repair publish cannot fix it", async () => {
      const shop = await withCodeNode({ synced: 3, shopifyCount: 1 });

      const { result } = await run(shop.fake.graphQL);

      const mine = result.unresolved.filter((f) => f.shopId === shop.shopId);
      expect(mine).toEqual([
        expect.objectContaining({ issue: "code_count_mismatch", nodeId: shop.codeNode, detail: "Shopify has 1 codes, the app expects 3" }),
      ]);
      expect(captureMessage).toHaveBeenCalledWith("Discount drift could not be repaired", expect.objectContaining({ level: "error" }));
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

  it("without a manifest it can only verify that the shop's two nodes still exist", async () => {
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
    expect(onlyMine((await run(present.graphQL)).publish, shopId)).toEqual([]);

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

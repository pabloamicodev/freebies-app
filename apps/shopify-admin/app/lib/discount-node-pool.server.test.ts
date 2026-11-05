import type * as DrizzleOrm from "drizzle-orm";
import type * as PromoDb from "@promo/db";
import type * as ShopifyFetch from "./shopify-fetch.server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  shards: [] as Array<{ slot: number; discountNodeId: string }>,
  shopRow: { discountId: null as string | null, deliveryDiscountId: null as string | null },
  gql: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof DrizzleOrm>()),
  eq: (column: { name: string }, value: unknown) => ({ column, value }),
  and: (...conds: unknown[]) => ({ conds }),
  gt: (column: { name: string }, value: number) => ({ column, value }),
}));

vi.mock("@promo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof PromoDb>();
  const getDb = () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: { conds?: Array<{ column: { name: string }; value: string }> }) => {
          const run = () => {
            if (table === actual.shops) return [h.shopRow];
            if (table === actual.discountShards) {
              return h.shards.map((row) => ({ slot: row.slot, id: row.discountNodeId }));
            }
            const key = cond.conds?.find((c) => c.column.name === "key")?.value as string;
            return h.settings.has(key) ? [{ value: h.settings.get(key) }] : [];
          };
          return {
            limit: async () => run(),
            then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
              Promise.resolve(run()).then(resolve, reject),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: { key: string; value: string; slot?: number; discountNodeId?: string }) => ({
        onConflictDoUpdate: async () => {
          if (table === actual.discountShards) {
            h.shards = [...h.shards.filter((s) => s.slot !== row.slot), { slot: row.slot!, discountNodeId: row.discountNodeId! }];
          } else h.settings.set(row.key, row.value);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (cond: { conds: Array<{ column: { name: string }; value: unknown }> }) => {
        if (table === actual.discountShards) {
          const above = cond.conds.find((c) => c.column.name === "slot")!.value as number;
          h.shards = h.shards.filter((s) => s.slot <= above);
        } else h.settings.delete(cond.conds.find((c) => c.column.name === "key")!.value as string);
      },
    }),
  });
  return { ...actual, getDb };
});

vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));

vi.mock("./shopify-fetch.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ShopifyFetch>()),
  shopifyGraphQL: h.gql,
}));

import {
  AUTOMATIC_OTHERS_SETTING,
  AutomaticDiscountLimitError,
  CART_SHARD_POOL_SETTING,
  CODE_NODE_SETTING,
  CODED_SHIPPING_POOL_SETTING,
  EMPTY_CART_SHARD_CONFIG,
  automaticNodeBudget,
  cartShardTitle,
  ensureCartShardNodes,
  migrateLegacyCartShardIds,
  ensureCodedShippingNodes,
  readCartShardNodeIds,
} from "./discount-node.server.js";




const SHOP_ID = "shop-1";
const DOMAIN = "s.myshopify.com";
const CART_FN = { id: "gid://shopify/ShopifyFunction/cart", apiType: "discount", handle: "promo-engine-discount", title: "Promo Engine Discount" };
const DELIVERY_FN = { id: "gid://shopify/ShopifyFunction/del", apiType: "discount", handle: "promo-engine-delivery-discount", title: "Promo Engine Delivery Discount" };
const nodeId = (n: string) => `gid://shopify/DiscountAutomaticNode/${n}`;

interface FakeNode {
  id: string;
  title: string;
  functionId: string;
  status?: string;
}

/** In-memory Shopify: automatic app nodes, an active count, and a call log. */
function installShopify(opts: { nodes?: FakeNode[]; active?: number | null; failCreateAt?: number }) {
  const nodes = [...(opts.nodes ?? [])];
  const creates: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  let seq = 100;
  h.gql.mockImplementation(async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
    if (query.includes("FindDiscountFunction")) return { shopifyFunctions: { nodes: [CART_FN, DELIVERY_FN] } };
    if (query.includes("discountNodesCount")) {
      if (opts.active === null) throw new Error("no count");
      return { discountNodesCount: { count: opts.active ?? nodes.length } };
    }
    if (query.includes("discountNodes(")) {
      return {
        discountNodes: {
          nodes: nodes.map((n) => ({
            id: n.id,
            discount: { __typename: "DiscountAutomaticApp", title: n.title, appDiscountType: { functionId: n.functionId } },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    if (query.includes("PromoEngineNodesActive")) {
      const ids = variables!.ids as string[];
      return {
        nodes: ids.map((id) => {
          const n = nodes.find((x) => x.id === id);
          return n ? { id, automaticDiscount: { status: n.status ?? "ACTIVE" } } : null;
        }),
      };
    }
    if (query.includes("PromoEngineNodesExist")) {
      const ids = variables!.ids as string[];
      return {
        nodes: ids.map((id) => {
          const n = nodes.find((x) => x.id === id);
          return n ? { id, automaticDiscount: { title: n.title } } : null;
        }),
      };
    }
    if (query.includes("discountAutomaticAppCreate")) {
      if (opts.failCreateAt !== undefined && creates.length === opts.failCreateAt) throw new Error("boom");
      const input = variables!.discount as Record<string, unknown>;
      creates.push(input);
      const fn = input.functionHandle === CART_FN.handle ? CART_FN : DELIVERY_FN;
      const id = nodeId(String(seq++));
      nodes.push({ id, title: input.title as string, functionId: fn.id });
      return { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: id }, userErrors: [] } };
    }
    if (query.includes("discountAutomaticDelete")) {
      const id = variables!.id as string;
      deletes.push(id);
      nodes.splice(nodes.findIndex((n) => n.id === id), 1);
      return { discountAutomaticDelete: { deletedAutomaticDiscountId: id, userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 60)}`);
  });
  return { nodes, creates, deletes };
}

const seedShards = (ids: string[]) => {
  h.shards = ids.map((discountNodeId, index) => ({ slot: index + 1, discountNodeId }));
};
const storedShards = () => [...h.shards].sort((a, b) => a.slot - b.slot).map((row) => row.discountNodeId);

const cartNode = (n: string, title: string): FakeNode => ({ id: nodeId(n), title, functionId: CART_FN.id });

beforeEach(() => {
  h.settings.clear();
  h.shards = [];
  h.shopRow = { discountId: null, deliveryDiscountId: null };
  h.gql.mockReset();
});

describe("cart shard pool", () => {
  it("writes the same metafield namespaces the publisher reads", async () => {
    const { FUNCTION_CONFIG_NAMESPACES } = await import("./sync/offer-publisher.server.js");
    const shopify = installShopify({ active: 1 });
    await ensureCartShardNodes(SHOP_ID, DOMAIN, "t", 1);
    const written = (shopify.creates[0]!.metafields as Array<{ namespace: string }>).map((m) => m.namespace);
    expect(written).toEqual([...FUNCTION_CONFIG_NAMESPACES]);
  });

  it("titles shards from slot 2 and creates them PRODUCT-only with an inert config in both namespaces", async () => {
    const shopify = installShopify({ active: 3 });
    const ids = await ensureCartShardNodes(SHOP_ID, DOMAIN, "t", 2);

    expect(ids).toHaveLength(2);
    expect(shopify.creates.map((c) => c.title)).toEqual(["Promo Engine 2", "Promo Engine 3"]);
    expect(cartShardTitle(1)).toBe("Promo Engine 2");
    for (const input of shopify.creates) {
      expect(input.discountClasses).toEqual(["PRODUCT"]);
      expect(input.functionHandle).toBe(CART_FN.handle);
      expect(input.metafields).toEqual([
        { namespace: "promo_engine", key: "function_config", type: "json", value: EMPTY_CART_SHARD_CONFIG },
        { namespace: "$app:promo_engine", key: "function_config", type: "json", value: EMPTY_CART_SHARD_CONFIG },
      ]);
    }
    const value = JSON.parse(EMPTY_CART_SHARD_CONFIG);
    expect(value).toMatchObject({ offers: [], c1: "_promo_engine_unused", c2: "_promo_engine_unused", c3: "_promo_engine_unused", version: "1", compiledAt: "1970-01-01T00:00:00.000Z" });
    expect(Object.keys(value)).toEqual(expect.arrayContaining(["c1", "c2", "c3", "customerTags", "version", "compiledAt"]));
    expect(JSON.parse((shopify.creates[0]!.metafields as Array<{ value: string }>)[0]!.value)).toEqual(value);
    expect(storedShards()).toEqual(ids);
    expect(h.settings.has(CART_SHARD_POOL_SETTING)).toBe(false);
  });

  it("reuses an existing shard by exact title instead of creating or picking slot 0", async () => {
    h.shopRow.discountId = nodeId("slot0");
    const slot0 = cartNode("slot0", "Promo Engine");
    const shard2 = cartNode("s2", "Promo Engine 2");
    const shopify = installShopify({ nodes: [slot0, shard2], active: 2 });

    const ids = await ensureCartShardNodes(SHOP_ID, DOMAIN, "t", 1);

    expect(ids).toEqual([shard2.id]);
    expect(shopify.creates).toHaveLength(0);
  });

  it("finds an unrecorded shard by exact title and never confuses it with a neighbour", async () => {
    const shard3 = cartNode("s3", "Promo Engine 3");
    const shopify = installShopify({ nodes: [shard3], active: 1 });

    const ids = await ensureCartShardNodes(SHOP_ID, DOMAIN, "t", 2);

    expect(shopify.creates.map((c) => c.title)).toEqual(["Promo Engine 2"]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(shard3.id);
  });

  it("deletes only surplus shards and never touches slot 0 or the delivery node", async () => {
    h.shopRow = { discountId: nodeId("slot0"), deliveryDiscountId: nodeId("deliv") };
    const nodes = [
      cartNode("slot0", "Promo Engine"),
      { id: nodeId("deliv"), title: "Promo Engine Shipping", functionId: DELIVERY_FN.id },
      cartNode("s2", "Promo Engine 2"),
      cartNode("s3", "Promo Engine 3"),
      cartNode("s4", "Promo Engine 4"),
    ];
    seedShards([nodeId("s2"), nodeId("s3"), nodeId("s4")]);
    const shopify = installShopify({ nodes, active: 5 });

    const ids = await ensureCartShardNodes(SHOP_ID, DOMAIN, "t", 1);

    expect(ids).toEqual([nodeId("s2")]);
    expect(shopify.deletes).toEqual([nodeId("s3"), nodeId("s4")]);
    expect(storedShards()).toEqual([nodeId("s2")]);
  });

  it("reads a list an earlier release kept in app_settings without writing anything", async () => {
    h.settings.set(CART_SHARD_POOL_SETTING, JSON.stringify([nodeId("s2"), nodeId("s3")]));

    expect(await readCartShardNodeIds(SHOP_ID)).toEqual([nodeId("s2"), nodeId("s3")]);

    expect(storedShards()).toEqual([]);
    expect(h.settings.has(CART_SHARD_POOL_SETTING)).toBe(true);
  });

  it("migrates that list into discount_shards once, and drops the setting", async () => {
    h.settings.set(CART_SHARD_POOL_SETTING, JSON.stringify([nodeId("s2"), nodeId("s3")]));

    await migrateLegacyCartShardIds(SHOP_ID);

    expect(storedShards()).toEqual([nodeId("s2"), nodeId("s3")]);
    expect(h.settings.has(CART_SHARD_POOL_SETTING)).toBe(false);
    await migrateLegacyCartShardIds(SHOP_ID);
    expect(await readCartShardNodeIds(SHOP_ID)).toEqual([nodeId("s2"), nodeId("s3")]);
  });

  it("persists each id as soon as it is created, so a later failed create loses nothing", async () => {
    installShopify({ active: 3, failCreateAt: 1 });

    await expect(ensureCartShardNodes(SHOP_ID, DOMAIN, "t", 3)).rejects.toThrow("boom");

    expect(storedShards()).toHaveLength(1);
  });

  it("refuses to create past Shopify's 25 with cart-shard copy", async () => {
    installShopify({ active: 24 });
    const error = await ensureCartShardNodes(SHOP_ID, DOMAIN, "t", 2).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AutomaticDiscountLimitError);
    expect((error as AutomaticDiscountLimitError).message).toMatch(/^Your offers need 2 more automatic discounts in Shopify/);
    expect((error as AutomaticDiscountLimitError).kind).toBe("cart-shard");
  });
});

describe("coded shipping wrapper", () => {
  it("keeps the shipping copy, titles and inert-free create input", async () => {
    const shopify = installShopify({ active: 24 });
    const error = await ensureCodedShippingNodes(SHOP_ID, DOMAIN, "t", 2).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^Free shipping on code offers needs 2 more automatic discounts in Shopify/);
    expect(shopify.creates).toHaveLength(0);

    const ok = installShopify({ active: 3 });
    await ensureCodedShippingNodes(SHOP_ID, DOMAIN, "t", 2);
    expect(ok.creates.map((c) => c.title)).toEqual(["Promo Engine Coded Shipping 1", "Promo Engine Coded Shipping 2"]);
    expect(ok.creates.every((c) => c.metafields === undefined)).toBe(true);
    expect(JSON.parse(h.settings.get(CODED_SHIPPING_POOL_SETTING)!)).toHaveLength(2);
  });
});

describe("automaticNodeBudget", () => {
  const setup = (opts: { active: number | null; shards?: number; pool?: number; code?: boolean }) => {
    h.shopRow = { discountId: nodeId("slot0"), deliveryDiscountId: nodeId("deliv") };
    const nodes: FakeNode[] = [
      cartNode("slot0", "Promo Engine"),
      { id: nodeId("deliv"), title: "Promo Engine Shipping", functionId: DELIVERY_FN.id },
    ];
    const shardIds = Array.from({ length: opts.shards ?? 0 }, (_, i) => nodeId(`s${i}`));
    shardIds.forEach((id, i) => nodes.push(cartNode(id.split("/").pop()!, `Promo Engine ${i + 2}`)));
    const poolIds = Array.from({ length: opts.pool ?? 0 }, (_, i) => nodeId(`p${i}`));
    poolIds.forEach((id, i) => nodes.push({ id, title: `Promo Engine Coded Shipping ${i + 1}`, functionId: DELIVERY_FN.id }));
    seedShards(shardIds);
    if (poolIds.length) h.settings.set(CODED_SHIPPING_POOL_SETTING, JSON.stringify(poolIds));
    if (opts.code) {
      nodes.push({ id: nodeId("code"), title: "Promo Engine Codes", functionId: "x" });
      h.settings.set(CODE_NODE_SETTING, JSON.stringify(nodeId("code")));
    }
    installShopify({ nodes, active: opts.active });
  };

  it("counts ours = slot 0 + delivery + code + pool + shards and applies 25 - others - nonShard - 2", async () => {
    setup({ active: 20, shards: 2, pool: 1, code: true });
    const budget = await automaticNodeBudget(SHOP_ID, DOMAIN, "t");

    expect(budget).toEqual({ storeActive: 20, ours: 6, others: 14, maxCartSlots: 25 - 14 - 3 - 2 });
  });

  it("caps at 11 and floors at 1", async () => {
    setup({ active: 2 });
    expect((await automaticNodeBudget(SHOP_ID, DOMAIN, "t")).maxCartSlots).toBe(11);

    setup({ active: 24 });
    expect((await automaticNodeBudget(SHOP_ID, DOMAIN, "t")).maxCartSlots).toBe(1);
  });

  it("matches the spec table: 15 others and 1 non-shard node give 7 slots", async () => {
    setup({ active: 17 });
    const budget = await automaticNodeBudget(SHOP_ID, DOMAIN, "t");
    expect(budget.others).toBe(15);
    expect(budget.maxCartSlots).toBe(7);
  });

  it("remembers others and falls back to it when the count is null", async () => {
    setup({ active: 17 });
    await automaticNodeBudget(SHOP_ID, DOMAIN, "t");
    expect(h.settings.get(AUTOMATIC_OTHERS_SETTING)).toBe("15");

    setup({ active: null });
    h.settings.set(AUTOMATIC_OTHERS_SETTING, "15");
    const budget = await automaticNodeBudget(SHOP_ID, DOMAIN, "t");
    expect(budget).toMatchObject({ storeActive: null, others: 15, maxCartSlots: 7 });
  });

  it("with no count and no last known value, grows by one slot beyond the current shards", async () => {
    setup({ active: null, shards: 2 });
    const budget = await automaticNodeBudget(SHOP_ID, DOMAIN, "t");
    expect(budget).toMatchObject({ storeActive: null, others: null, maxCartSlots: 4 });

    setup({ active: null });
    expect((await automaticNodeBudget(SHOP_ID, DOMAIN, "t")).maxCartSlots).toBe(2);
  });

  it("does not count our inactive nodes, which Shopify's active count excludes", async () => {
    setup({ active: 10, shards: 2 });
    h.gql.mockImplementation(((impl) => async (arg: { query: string; variables?: { ids: string[] } }) => {
      if (arg.query.includes("PromoEngineNodesActive")) {
        return {
          nodes: arg.variables!.ids.map((id) => ({ id, automaticDiscount: { status: id === nodeId("s1") ? "EXPIRED" : "ACTIVE" } })),
        };
      }
      return impl(arg);
    })(h.gql.getMockImplementation()!));
    const budget = await automaticNodeBudget(SHOP_ID, DOMAIN, "t");
    expect(budget.ours).toBe(3);
    expect(budget.others).toBe(7);
  });

  it("writes the last known value only when the live count was obtained", async () => {
    setup({ active: null });
    await automaticNodeBudget(SHOP_ID, DOMAIN, "t");
    expect(h.settings.has(AUTOMATIC_OTHERS_SETTING)).toBe(false);
  });

  it("ignores recorded ids that no longer exist in Shopify", async () => {
    setup({ active: 5, shards: 1 });
    seedShards([nodeId("s0"), nodeId("gone")]);
    const budget = await automaticNodeBudget(SHOP_ID, DOMAIN, "t");
    expect(budget.ours).toBe(3);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  appSettings,
  auditLogs,
  bundleDefinitions,
  bundleSteps,
  giftCloneProducts,
  mcpOperators,
  offerConditions,
  offerRewards,
  offers,
  type Db,
} from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { duplicateTool } from "./write-tools.server.js";

type FakeVariant = { id: string; sku: string | null; options: string[]; product: string };
type Catalog = { products: Record<string, string>; collections: Record<string, string>; variants: FakeVariant[] };
type Call = { shopDomain: string; query: string; variables: Record<string, any> };

const shopify = vi.hoisted(() => ({ handler: null as null | ((a: Call) => unknown) }));
vi.mock("../../shopify-fetch.server.js", () => ({ shopifyGraphQL: async (a: Call) => shopify.handler!(a) }));
vi.mock("../../token-crypto.server.js", () => ({ decryptToken: async (s: string) => s }));
vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const SRC = "hpn-test-store.myshopify.com";
const DST = "second-test.myshopify.com";
const LOCKED = "hpn.myshopify.com";
const ENV = { MCP_WRITE_SHOPS: `${SRC}, ${DST}`, MCP_CONFIRM_SECRET: "x".repeat(40) } as unknown as NodeJS.ProcessEnv;
const P = (n: number) => `gid://shopify/Product/${n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const C = (n: number) => `gid://shopify/Collection/${n}`;

const catalogs = new Map<string, Catalog>();
const resetCatalogs = () => {
  catalogs.set(SRC, {
    products: { whey: P(1), creatine: P(2), gone: P(3) },
    collections: { sale: C(10) },
    variants: [
      { id: V(1), sku: "WHEY-1KG", options: ["1kg"], product: "whey" },
      { id: V(2), sku: null, options: ["Berry"], product: "creatine" },
      { id: V(3), sku: "NOPE", options: ["x"], product: "gone" },
    ],
  });
  catalogs.set(DST, {
    products: { whey: P(101), creatine: P(102) },
    collections: { sale: C(110) },
    variants: [
      { id: V(1001), sku: "WHEY-1KG", options: ["1kg"], product: "whey" },
      { id: V(1002), sku: "CRE-B", options: ["Berry"], product: "creatine" },
    ],
  });
};

function fakeShopify({ shopDomain, query, variables }: Call) {
  const cat = catalogs.get(shopDomain)!;
  const handleOf = (map: Record<string, string>, id: string) => Object.entries(map).find(([, v]) => v === id)?.[0];
  if (query.includes("nodes(ids")) {
    return {
      nodes: (variables["ids"] as string[]).map((id) => {
        const p = handleOf(cat.products, id);
        if (p) return { __typename: "Product", handle: p };
        const c = handleOf(cat.collections, id);
        if (c) return { __typename: "Collection", handle: c };
        const v = cat.variants.find((x) => x.id === id);
        return v ? { __typename: "ProductVariant", sku: v.sku, selectedOptions: v.options.map((value) => ({ name: "o", value })), product: { handle: v.product } } : null;
      }),
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries<string>(variables)) {
    const alias = `a${k.slice(1)}`;
    if (query.includes("variants(first")) {
      out[alias] = cat.products[val]
        ? { variants: { nodes: cat.variants.filter((x) => x.product === val).map((x) => ({ id: x.id, selectedOptions: x.options.map((value) => ({ value })) })) } }
        : null;
    } else if (query.includes("productVariants(")) {
      const sku = /sku:"(.*)"/.exec(val)![1]!;
      out[alias] = { nodes: cat.variants.filter((x) => x.sku === sku).map((x) => ({ id: x.id, sku: x.sku })) };
    } else {
      const map = query.includes("collectionByIdentifier") ? cat.collections : cat.products;
      out[alias] = map[val] ? { id: map[val] } : null;
    }
  }
  return out;
}

type Body = { code?: string; message?: string; data: Record<string, any>; meta: { confirmToken?: string }; warnings: { code: string; message: string }[] };
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
const shopIds: Record<string, string> = {};
const operators: Record<string, Operator> = {};
const ctxFor = (op: Operator): McpContext => ({ db, env: ENV, operator: op, now: () => new Date(), rateLimit: async () => ({ ok: true as const }), publish: async () => null });
const run = (args: Record<string, unknown>, op = operators["admin"]!) => duplicateTool(ctxFor(op), { requestId: "r", client: "vitest" }, args);
const refOf = (id: string) => `promo:hpn-test-store:${id}`;

async function sourceOffer(opts: { gone?: boolean; clone?: boolean } = {}) {
  const shopId = shopIds["src"]!;
  const id = await seedOffer(db, shopId, { status: "active", internalName: `[MCP test] cross ${Math.random().toString(36).slice(2, 8)}` });
  await db.insert(offerConditions).values({
    shopId, offerId: id, scope: "main", conditionType: "products", operator: "in",
    value: { productIds: opts.gone ? [P(1), P(3)] : [P(1)], collectionIds: [C(10)], minQty: 2 }, sortOrder: 0, isEnabled: true,
  });
  const variantIds = [V(1), V(2), ...(opts.gone ? [V(3)] : []), ...(opts.clone ? [V(9001)] : [])];
  await db.insert(offerRewards).values({ shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 }, target: { productId: P(2), variantIds } });
  const [bundle] = await db.insert(bundleDefinitions).values({ shopId, offerId: id, bundleType: "classic", title: "b", bundleProductGid: P(77) }).returning();
  await db.insert(bundleSteps).values({ shopId, bundleId: bundle!.id, title: "s", sourceType: "products", sourceConfig: { productGids: opts.gone ? [P(1), P(3)] : [P(1)], collectionGid: C(10) } });
  if (opts.clone) {
    await db.insert(giftCloneProducts).values({ shopId, offerId: id, rewardId: id, sourceProductGid: P(2), sourceVariantGid: V(2), cloneProductGid: P(9000), cloneVariantGid: V(9001), cloneHandle: "creatine-gift" });
  }
  return id;
}

const copyOf = async (id: string) => {
  const [offer] = await db.select().from(offers).where(eq(offers.id, id));
  const [cond] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, id));
  const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
  const [bundle] = await db.select().from(bundleDefinitions).where(eq(bundleDefinitions.offerId, id));
  const [step] = await db.select().from(bundleSteps).where(eq(bundleSteps.bundleId, bundle!.id));
  return { offer: offer!, cond: cond!, reward: reward!, bundle: bundle!, step: step! };
};

async function twoStep(args: Record<string, unknown>) {
  const dry = await run(args);
  expect(dry.isError, JSON.stringify(dry.structuredContent)).toBeFalsy();
  return { dry, done: await run({ ...args, dryRun: false, confirmToken: body(dry).meta.confirmToken }) };
}
const offerCount = async () => (await db.select().from(offers)).length;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const [key, domain] of [["src", SRC], ["dst", DST], ["locked", LOCKED]] as const) shopIds[key] = await seedShop(db, domain);
  for (const key of ["src", "dst", "locked"]) await db.insert(appSettings).values({ shopId: shopIds[key]!, key: "mcp.writeMode", value: JSON.stringify("write") });
  const make = async (name: string, role: "editor" | "admin", shopAllowList: string[]) => {
    const [op] = await db.insert(mcpOperators).values({ email: `${name}@example.com`, name, role, shopAllowList }).returning();
    operators[name] = { id: op!.id, email: op!.email, name, role, shopAllowList };
  };
  await make("editor", "editor", ["*"]);
  await make("admin", "admin", ["*"]);
  await make("narrow", "admin", [SRC]);
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  resetCatalogs();
  shopify.handler = fakeShopify;
  resetMemoryRateLimits();
});

describe("promo_duplicate across shops", () => {
  it("full match: the dry run reports the mapping and the copy points at the target shop's resources", async () => {
    const id = await sourceOffer();
    const { dry, done } = await twoStep({ ref: refOf(id), targetShop: DST });
    const report = body(dry).data["resourceMapping"];
    expect(report.unmatched).toEqual([]);
    expect(report.mapped).toEqual(
      expect.arrayContaining([
        { from: P(1), to: P(101), kind: "product", key: "whey" },
        { from: P(2), to: P(102), kind: "product", key: "creatine" },
        { from: C(10), to: C(110), kind: "collection", key: "sale" },
        { from: V(1), to: V(1001), kind: "variant", key: "sku:WHEY-1KG" },
        { from: V(2), to: V(1002), kind: "variant", key: "creatine#Berry" },
      ]),
    );
    expect(body(dry).warnings.map((w) => w.code)).not.toContain("UNMATCHED_RESOURCES");
    const newId = body(done).data["offerId"] as string;
    const copy = await copyOf(newId);
    expect(copy.offer).toMatchObject({ shopId: shopIds["dst"], status: "draft", codeDiscountId: null, functionMetafieldGid: null });
    expect(copy.cond.value).toEqual({ productIds: [P(101)], collectionIds: [C(110)], minQty: 2 });
    expect(copy.reward.target).toEqual({ productId: P(102), variantIds: [V(1001), V(1002)] });
    expect(copy.bundle.bundleProductGid).toBeNull();
    expect(copy.step.sourceConfig).toEqual({ productGids: [P(101)], collectionGid: C(110) });
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopIds["dst"]!), eq(auditLogs.entityId, newId)));
    expect(audit).toMatchObject({ action: "duplicate", before: { sourceOfferId: id, sourceShop: SRC } });
    expect(audit!.after).toMatchObject({ sourceShop: SRC, sourceOfferId: id });
    const [source] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, id));
    expect(source!.value).toMatchObject({ productIds: [P(1)] });
  });

  it("a tiered gift offer keeps its tier mode and every tier threshold", async () => {
    const shopId = shopIds["src"]!;
    const id = await seedOffer(db, shopId, { type: "gift", status: "active", internalName: `[MCP test] tiers ${Math.random().toString(36).slice(2, 8)}`, tierMode: "highest" });
    for (const [sortOrder, [variant, min]] of ([[1, 7000], [2, 11000]] as const).entries()) {
      await db.insert(offerRewards).values({ shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 }, target: { variantIds: [V(variant)] }, isAutoAdd: true, sortOrder, minCartSubtotalCents: min });
    }
    const { done } = await twoStep({ ref: refOf(id), targetShop: DST });
    const newId = body(done).data["offerId"] as string;
    const [copy] = await db.select().from(offers).where(eq(offers.id, newId));
    expect(copy).toMatchObject({ shopId: shopIds["dst"], tierMode: "highest" });
    const rewards = (await db.select().from(offerRewards).where(eq(offerRewards.offerId, newId))).sort((x, y) => x.sortOrder - y.sortOrder);
    expect(rewards.map((r) => r.minCartSubtotalCents)).toEqual([7000, 11000]);
    expect(rewards.map((r) => r.target)).toEqual([{ variantIds: [V(1001)] }, { variantIds: [V(1002)] }]);
  });

  it("partial match: unmatched references are stripped and listed in warnings, the draft stays draft", async () => {
    const id = await sourceOffer({ gone: true });
    const { dry, done } = await twoStep({ ref: refOf(id), targetShop: DST });
    expect(body(dry).data["resourceMapping"].unmatched).toEqual([
      expect.objectContaining({ from: P(3), kind: "product", key: "gone" }),
      expect.objectContaining({ from: V(3), kind: "variant", key: "sku:NOPE" }),
    ]);
    expect(body(dry).warnings.map((w) => w.code)).toContain("UNMATCHED_RESOURCES");
    expect(body(done).warnings.map((w) => w.code)).toContain("UNMATCHED_RESOURCES");
    expect(body(done).data["unmatched"]).toHaveLength(2);
    const copy = await copyOf(body(done).data["offerId"] as string);
    expect(copy.offer.status).toBe("draft");
    expect(copy.cond.value).toEqual({ productIds: [P(101)], collectionIds: [C(110)], minQty: 2 });
    expect(copy.reward.target).toEqual({ productId: P(102), variantIds: [V(1001), V(1002)] });
    expect(copy.step.sourceConfig).toEqual({ productGids: [P(101)], collectionGid: C(110) });
    expect(JSON.stringify(copy)).not.toMatch(/Product\/3\b|ProductVariant\/3\b/);
  });

  it("gift clone products are never copied: reported as unmatched and stripped from the reward", async () => {
    const id = await sourceOffer({ clone: true });
    const { dry, done } = await twoStep({ ref: refOf(id), targetShop: DST });
    const clones = body(dry).data["resourceMapping"].unmatched.filter((u: { kind: string }) => u.kind === "gift_clone");
    expect(clones.map((c: { from: string }) => c.from).sort()).toEqual([P(9000), V(9001)].sort());
    expect(clones[0].reason).toMatch(/recreate/);
    const copy = await copyOf(body(done).data["offerId"] as string);
    expect(copy.reward.target).toEqual({ productId: P(102), variantIds: [V(1001), V(1002)] });
    expect(await db.select().from(giftCloneProducts).where(eq(giftCloneProducts.shopId, shopIds["dst"]!))).toHaveLength(0);
  });

  it("an editor is FORBIDDEN cross-shop and nothing is created", async () => {
    const id = await sourceOffer();
    const before = await offerCount();
    for (const args of [{ ref: refOf(id), targetShop: DST }, { ref: refOf(id), targetShop: DST, dryRun: false, confirmToken: "x.y" }]) {
      expect(body(await run(args, operators["editor"]!)).code).toBe("FORBIDDEN");
    }
    expect(await offerCount()).toBe(before);
  });

  it("the target shop must pass the write locks (SHOP_READ_ONLY), even for an admin", async () => {
    const id = await sourceOffer();
    const before = await offerCount();
    expect(body(await run({ ref: refOf(id), targetShop: LOCKED })).code).toBe("SHOP_READ_ONLY");
    expect(await offerCount()).toBe(before);
  });

  it("both shops must be visible to the operator (SHOP_NOT_FOUND)", async () => {
    const id = await sourceOffer();
    expect(body(await run({ ref: refOf(id), targetShop: DST }, operators["narrow"]!)).code).toBe("SHOP_NOT_FOUND");
  });

  it("a mapping that changed after the dry run is STATE_CONFLICT and nothing is created", async () => {
    const id = await sourceOffer();
    const args = { ref: refOf(id), targetShop: DST };
    const dry = await run(args);
    const before = await offerCount();
    catalogs.get(DST)!.products["whey"] = P(555);
    const res = await run({ ...args, dryRun: false, confirmToken: body(dry).meta.confirmToken });
    expect(body(res).code).toBe("STATE_CONFLICT");
    expect(await offerCount()).toBe(before);
  });

  it("a Shopify failure while mapping is UPSTREAM_UNAVAILABLE", async () => {
    const id = await sourceOffer();
    shopify.handler = () => {
      throw new Error("boom");
    };
    expect(body(await run({ ref: refOf(id), targetShop: DST })).code).toBe("UPSTREAM_UNAVAILABLE");
  });
});

import type * as OfferDefinitionsTypeModule from "../../offer-definitions.server.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bundleDefinitions, discountCodes, mcpOperators, offerCombinationPolicies, offerConditions, offerRewards, offers, productCache, variantCache, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../../test-support/pglite-db.js";
import type { ShopPublishFn } from "../../offer-publish-flow.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerPromoAuthoringTools } from "./register-promo-authoring.server.js";

vi.mock("../../offer-definitions.server.js", async (importActual) => {
  const actual = await importActual<typeof OfferDefinitionsTypeModule>();
  return { ...actual, invalidateOfferDefinitions: async () => undefined };
});
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const SHOP = "families.myshopify.com";
const PRODUCT_ID = "9208279269615";
const PRODUCT_GID = `gid://shopify/Product/${PRODUCT_ID}`;
const VARIANT_ID = "48000000000001";
const VARIANT_GID = `gid://shopify/ProductVariant/${VARIANT_ID}`;

type Body = { summary: string; data: Record<string, any>; warnings: { code: string }[]; code?: string; message?: string };
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let operator: Operator;
let client: Client;
let n = 0;
const publish = vi.fn<ShopPublishFn>(async () => null);

const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const create = (extra: Record<string, unknown>) => call("promo_create", { shop: "families", internalName: `family offer ${++n}`, status: "draft", ...extra });
const conditionsOf = (offerId: string) => db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, SHOP);
  await db.insert(productCache).values({ shopId, productGid: PRODUCT_GID, handle: "bundle-product", title: "Bundle product", raw: {} });
  await db.insert(variantCache).values({ shopId, productGid: PRODUCT_GID, variantGid: VARIANT_GID, title: "Default Title", price: "59.99", currencyCode: "USD", raw: {} });
  const [op] = await db.insert(mcpOperators).values({ email: "editor@example.com", name: "editor", role: "editor", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "editor", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  publish.mockClear();
  const server = new McpServer({ name: "families-test", version: "0.0.0" });
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: async () => ({ ok: true }), publish };
  registerPromoAuthoringTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "vitest", version: "0.0.0" });
  await client.connect(clientSide);
});

describe("promo_create across reward families", () => {
  it("shipping: stored as a discount offer with the wizard policy and the derived main condition", async () => {
    const result = await create({
      type: "shipping",
      rewards: [{ kind: "shipping_discount", tiers: [{ minimumSubtotal: 75, discountType: "percentage", value: 100 }] }],
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const id = body(result).data["offerId"] as string;
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]).toMatchObject({ type: "discount" });
    expect((await db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, id)))[0]).toMatchObject({ combinesWithShippingDiscounts: false, combinesWithProductDiscounts: true });
    expect((await conditionsOf(id))[0]).toMatchObject({ scope: "main", conditionType: "cart_value", value: expect.objectContaining({ thresholdCents: 7500 }) });
    expect((await db.select().from(offerRewards).where(eq(offerRewards.offerId, id)))[0]).toMatchObject({ rewardType: "shipping_discount" });
  });

  it("bundle: writes the bundle definition and swaps the offer-id placeholder; an active bundle needs products", async () => {
    const reward = { kind: "bundle_discount", bundleType: "classic", products: [PRODUCT_ID], tiers: [{ minQuantity: 2, discountType: "percentage", value: 10 }] };
    const result = await create({ type: "bundle", rewards: [reward] });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const id = body(result).data["offerId"] as string;
    expect(await db.select({ id: bundleDefinitions.id }).from(bundleDefinitions).where(eq(bundleDefinitions.offerId, id))).toHaveLength(1);
    const [stored] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect((stored!.target as Record<string, unknown>)["requiredOfferId"]).toBe(id);
    expect((await conditionsOf(id))[0]).toMatchObject({ scope: "main", conditionType: "cart_quantity", value: expect.objectContaining({ minQuantity: 2 }) });

    const empty = await create({ type: "bundle", status: "active", rewards: [{ kind: "bundle_discount", bundleType: "classic", discountValue: 10 }] });
    expect(body(empty).code).toBe("VALIDATION");
    expect(body(empty).message).toContain("Select at least one bundle product");
  });

  it("gift: the trigger becomes the main condition; trigger plus a main condition is refused; tiers default to cumulative", async () => {
    const gift = { kind: "product_gift", gifts: [{ variantIds: [VARIANT_ID] }] };
    const result = await create({ type: "gift", rewards: [gift], trigger: { type: "cart_value", minAmount: 50 } });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const id = body(result).data["offerId"] as string;
    expect((await conditionsOf(id))[0]).toMatchObject({ scope: "main", conditionType: "cart_value", value: expect.objectContaining({ thresholdCents: 5000 }) });

    const both = await create({ type: "gift", rewards: [gift], trigger: { type: "cart_quantity", minQuantity: 2 }, conditions: [{ type: "cart_value", scope: "main", threshold: 10 }] });
    expect(body(both).code).toBe("VALIDATION");
    const wrongType = await create({ type: "discount", rewards: [{ kind: "order_discount", by: "quantity", tiers: [{ minimum: 1, discountType: "percentage", value: 10 }] }], trigger: { type: "cart_quantity", minQuantity: 2 } });
    expect(body(wrongType).code).toBe("VALIDATION");

    const tiered = await create({ type: "gift", rewards: [{ kind: "product_gift", tiers: [{ minCartSubtotal: 40, gifts: [{ variantIds: [VARIANT_ID] }] }] }] });
    expect(tiered.isError, JSON.stringify(tiered.structuredContent)).toBeFalsy();
    const tieredId = body(tiered).data["offerId"] as string;
    expect((await db.select().from(offers).where(eq(offers.id, tieredId)))[0]).toMatchObject({ tierMode: "cumulative" });
  });

  it("upsell: derives the main and visibility conditions and keeps the caller conditions as sub-conditions", async () => {
    const result = await create({
      type: "upsell",
      rewards: [{ kind: "upsell_discount", template: "checkout", upsellProducts: [PRODUCT_ID], discountType: "percentage", discountValue: 10 }],
      conditions: [{ type: "customer_tags", includeTags: ["vip"] }],
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const rows = await conditionsOf(body(result).data["offerId"] as string);
    expect(rows.map((row) => [row.scope, row.conditionType]).sort()).toEqual([["main", "cart_quantity"], ["sub", "customer_tags"], ["visibility", "sales_channels"]]);
  });

  it("codes: a typed code makes it a code offer and is created with it; a taken code creates nothing", async () => {
    const reward = { kind: "order_discount", by: "quantity", tiers: [{ minimum: 1, discountType: "percentage", value: 10 }] };
    const result = await create({ type: "discount", rewards: [reward], codes: { code: "FAMILY10" } });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const id = body(result).data["offerId"] as string;
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]).toMatchObject({ requiresCode: true });
    expect((await db.select().from(discountCodes).where(eq(discountCodes.offerId, id))).map((row) => row.code)).toEqual(["FAMILY10"]);

    const before = (await db.select({ id: offers.id }).from(offers).where(eq(offers.shopId, shopId))).length;
    const taken = await create({ type: "discount", rewards: [reward], codes: { code: "FAMILY10" } });
    expect(taken.isError).toBe(true);
    expect((await db.select({ id: offers.id }).from(offers).where(eq(offers.shopId, shopId))).length).toBe(before);
  });
});

describe("promo_update re-derives the main condition", () => {
  const rewardWithMinimum = (minQuantity: number) => ({
    kind: "product_discount",
    target: { scope: "selected", products: [PRODUCT_ID] },
    quantityTiers: [{ minQuantity, discountType: "percentage", value: 15 }],
  });

  it("follows the new tier minimum when the stored main condition is the derived one", async () => {
    const created = await create({ type: "discount", rewards: [rewardWithMinimum(2)] });
    const id = body(created).data["offerId"] as string;
    const result = await call("promo_update", { ref: `promo:families:${id}`, rewards: [rewardWithMinimum(4)] });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect((await conditionsOf(id)).find((row) => row.scope === "main")).toMatchObject({ value: expect.objectContaining({ minQuantity: 4 }) });
    expect(body(result).warnings.map((w) => w.code)).not.toContain("MAIN_CONDITION_KEPT");
  });

  it("keeps a hand-made main condition and says so", async () => {
    const created = await create({ type: "discount", rewards: [rewardWithMinimum(2)], conditions: [{ type: "cart_value", scope: "main", threshold: 30, includeGiftValues: true }] });
    const id = body(created).data["offerId"] as string;
    const result = await call("promo_update", { ref: `promo:families:${id}`, rewards: [rewardWithMinimum(4)] });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect((await conditionsOf(id)).find((row) => row.scope === "main")).toMatchObject({ conditionType: "cart_value" });
    expect(body(result).warnings.map((w) => w.code)).toContain("MAIN_CONDITION_KEPT");
  });

  it("refuses to replace the rewards of a bundle", async () => {
    const created = await create({ type: "bundle", rewards: [{ kind: "bundle_discount", bundleType: "classic", products: [PRODUCT_ID], discountValue: 10 }] });
    const id = body(created).data["offerId"] as string;
    const result = await call("promo_update", { ref: `promo:families:${id}`, rewards: [{ kind: "bundle_discount", bundleType: "classic", products: [PRODUCT_ID], discountValue: 20 }] });
    expect(body(result).code).toBe("VALIDATION");
  });
});

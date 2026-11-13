import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditLogs, mcpOperators, offerConditions, offerRewards, type Db } from "@promo/db";
import { ConditionTypeSchema, validateConditionValue } from "@promo/shared-types";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import { ANY_OF_CONFLICT_ERROR } from "../../product-condition.js";
import { AuthoringConditionSchema, toStoredConditions, type AuthoringCondition } from "../../offer-authoring/conditions.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerPromoConditionsTools } from "./register-promo-conditions.server.js";

vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));
vi.mock("../../token-crypto.server.js", () => ({ decryptToken: async () => "tok" }));

const SHOP = "hpn-test-store.myshopify.com";
const REF = (id: string) => `promo:hpn-test-store:${id}`;

type Body = { code?: string; message?: string; summary: string; data: Record<string, any>; meta: { dryRun?: boolean }; warnings: { code: string }[] };
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let operator: Operator;
let publish = vi.fn<ShopPublishFn>(async () => null);
let seq = 0;

async function connect() {
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: async () => ({ ok: true as const }), publish };
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerPromoConditionsTools(server, ctx);
  const client = new Client({ name: "vitest", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const call = async (tool: string, args: Record<string, unknown>) => {
  const client = await connect();
  try {
    return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
};

async function draftOffer(status: "draft" | "active" = "draft") {
  const id = await seedOffer(db, shopId, { status, internalName: `[cond] ${seq++}` });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100, currencyCode: "USD" }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
    target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
  });
  return id;
}
const conditionsOf = (offerId: string) => db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, SHOP);
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publish = vi.fn<ShopPublishFn>(async () => null);
  resetMemoryRateLimits();
});

/** One valid example of every condition type the editor supports. */
const EXAMPLES: AuthoringCondition[] = [
  { type: "cart_value", threshold: 50, includeGiftValues: true },
  { type: "cart_quantity", minQuantity: 2, maxQuantity: 5 },
  { type: "cart_value_multiplier", threshold: 100, maxMultiplier: 3 },
  { type: "customer_tags", includeTags: ["VIP"], excludeTags: ["wholesale"], treatGuestAsNoTags: true },
  { type: "order_history_total_spent", value: 250, operator: "gte" },
  { type: "order_history_last_order_spent", value: 40.5, operator: "lt" },
  { type: "order_history_total_orders", value: 3 },
  { type: "one_use_per_customer" },
  { type: "markets", includeMarketIds: ["123456", "gid://shopify/Market/789"] },
  { type: "customer_location", includeCountryCodes: ["us", "CA"] },
  { type: "sales_channels", channels: ["online_store", "pos"] },
  { type: "subscription_product_type", mode: "one_time_only" },
  { type: "specific_link", requiredUrl: "/pages/vip", paramName: "ref", paramValue: "abc" },
  { type: "page_types", pageTypes: ["product", "collection", "page"], pageUrls: ["/pages/about"], excludeUrls: ["/collections/hidden"], onlyMatchedLines: true },
  { type: "template", templates: ["product.bundle"] },
  { type: "section_shown", sections: [{ template: "product", key: "featured", label: "Featured" }] },
  { type: "experiment", experimentId: "exp12345a", variantKeys: ["b"], experimentName: "Hero test" },
  { type: "page_url", patterns: ["/collections/summer"], matchMode: "contains" },
  { type: "specific_product", matchBy: "product", ids: ["111", "gid://shopify/Product/222"], matchRule: "any" },
  { type: "pack_of_products", matchBy: "variant", ids: ["333", "444"], minQuantityPerProduct: 2 },
  { type: "line_attribute", key: "__bundle_type", value: "mix_match", minMatchingQuantity: 2 },
  { type: "cart_attribute", key: "source", value: "bogos" },
  { type: "utm_parameters", utmSource: "klaviyo", utmMedium: "email", visitScope: "visit" },
];

describe("toStoredConditions", () => {
  const deps = { db: undefined as unknown as Db, shopId: "s", shopDomain: SHOP, shopCurrency: "USD", timezone: "UTC" };

  it("covers every condition type the editor supports", () => {
    const covered = new Set(EXAMPLES.map((e) => e.type));
    const unsupported = new Set(["discount_code", "product_quantity_limits", "collection_quantity_limits", "vendor_quantity_limits", "product_type_quantity_limits", "exclude_products", "exclude_collections", "exclude_vendors", "exclude_types"]);
    for (const type of ConditionTypeSchema.options) {
      expect(covered.has(type as never) || unsupported.has(type), type).toBe(true);
    }
  });

  it.each(EXAMPLES.map((e) => [e.type, e] as const))("round-trips %s", async (_type, example) => {
    expect(AuthoringConditionSchema.safeParse(example).success).toBe(true);
    const result = await toStoredConditions([example], deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [stored] = result.value;
    expect(stored!.conditionType).toBe(example.type);
    expect(validateConditionValue(stored!.conditionType, stored!.value).success).toBe(true);
  });

  it("stores human units and normalised ids", async () => {
    const result = await toStoredConditions(
      [
        { type: "cart_value", threshold: 50 },
        { type: "markets", includeMarketIds: ["123456"] },
        { type: "specific_product", matchBy: "product", ids: ["111"], matchRule: "any" },
        { type: "customer_location", includeCountryCodes: ["us"] },
      ],
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ scope: "main", operator: "gte", value: { thresholdCents: 5000 } });
    expect(result.value[1]).toMatchObject({ scope: "sub", value: { includeMarketIds: ["gid://shopify/Market/123456"] } });
    expect(result.value[2]).toMatchObject({ operator: "any", value: { requirements: [{ productId: "gid://shopify/Product/111", trackMode: "product" }] } });
    expect(result.value[3]!.value).toMatchObject({ includeCountryCodes: ["US"] });
  });

  it("reports the failing index", async () => {
    const result = await toStoredConditions([{ type: "cart_value", threshold: 5 }, { type: "markets" }], deps);
    expect(result).toMatchObject({ ok: false, path: "conditions[1]", error: "Select at least one Shopify Market." });
  });
});

describe("promo_condition_upsert on a draft", () => {
  it.each([
    ["page_types", { type: "page_types", pageTypes: ["product", "collection"] }, { pageTypes: ["product", "collection"] }, "main"],
    ["customer_tags", { type: "customer_tags", includeTags: ["VIP"] }, { includeTags: ["VIP"], excludeTags: [] }, "sub"],
    ["markets", { type: "markets", includeMarketIds: ["1", "2"] }, { includeMarketIds: ["gid://shopify/Market/1", "gid://shopify/Market/2"] }, "sub"],
    ["cart_value", { type: "cart_value", threshold: 50 }, { thresholdCents: 5000 }, "main"],
    ["cart_quantity", { type: "cart_quantity", minQuantity: 3 }, { minQuantity: 3 }, "main"],
  ])("adds %s without publishing", async (type, condition, value, scope) => {
    const id = await draftOffer("draft");
    const res = await call("promo_condition_upsert", { ref: REF(id), condition });
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    expect(body(res).data).toMatchObject({ conditionType: type, scope });
    const rows = (await conditionsOf(id)).filter((r) => r.conditionType === type && r.id === body(res).data["conditionId"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toMatchObject(value);
    expect(rows[0]!.scope).toBe(scope);
    expect(publish).not.toHaveBeenCalled();
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.entityId, id)));
    expect(audit.some((a) => a.action === "condition_added")).toBe(true);
  });

  it("updates in place and keeps the stored scope when none is given", async () => {
    const id = await draftOffer("draft");
    const added = await call("promo_condition_upsert", { ref: REF(id), condition: { type: "cart_quantity", minQuantity: 2, scope: "sub" } });
    const conditionId = body(added).data["conditionId"] as string;
    const res = await call("promo_condition_upsert", { ref: REF(id), conditionId, condition: { type: "cart_quantity", minQuantity: 4 } });
    expect(res.isError).toBeFalsy();
    const [row] = (await conditionsOf(id)).filter((r) => r.id === conditionId);
    expect(row).toMatchObject({ scope: "sub", value: expect.objectContaining({ minQuantity: 4 }) });
  });

  it("rejects a bad value with the editor's message and writes nothing", async () => {
    const id = await draftOffer("draft");
    const before = (await conditionsOf(id)).length;
    const res = await call("promo_condition_upsert", { ref: REF(id), condition: { type: "markets" } });
    expect(res.isError).toBe(true);
    expect(body(res).message).toContain("Select at least one Shopify Market.");
    expect((await conditionsOf(id)).length).toBe(before);
  });

  it("refuses a second any-of product condition", async () => {
    const id = await draftOffer("draft");
    const any = { type: "specific_product", matchBy: "product", ids: ["1"], matchRule: "any" };
    expect((await call("promo_condition_upsert", { ref: REF(id), condition: any })).isError).toBeFalsy();
    const res = await call("promo_condition_upsert", { ref: REF(id), condition: { ...any, ids: ["2"] } });
    expect(res.isError).toBe(true);
    expect(body(res).message).toContain(ANY_OF_CONFLICT_ERROR.slice(0, 60));
    expect((await conditionsOf(id)).filter((r) => r.operator === "any")).toHaveLength(1);
  });

  it("dryRun previews the stored value and writes nothing", async () => {
    const id = await draftOffer("active");
    const before = (await conditionsOf(id)).length;
    const res = await call("promo_condition_upsert", { ref: REF(id), dryRun: true, condition: { type: "customer_tags", includeTags: ["VIP"] } });
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    expect(body(res).meta.dryRun).toBe(true);
    expect(body(res).data).toMatchObject({ conditionType: "customer_tags", value: { includeTags: ["VIP"] } });
    expect((await conditionsOf(id)).length).toBe(before);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("promo_condition_upsert on an active offer", () => {
  it.each([
    { type: "page_types", pageTypes: ["product", "collection"] },
    { type: "customer_tags", includeTags: ["VIP"] },
    { type: "customer_location", includeCountryCodes: ["US", "CA"] },
    { type: "cart_value", threshold: 50, scope: "sub" },
    { type: "cart_quantity", minQuantity: 2 },
  ])("republishes the shop after adding $type", async (condition) => {
    const id = await draftOffer("active");
    const res = await call("promo_condition_upsert", { ref: REF(id), condition });
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(body(res).summary).toContain("republished");
  });

  it("returns PUBLISH_FAILED and pauses the offer when the publish fails for it", async () => {
    const id = await draftOffer("active");
    publish = vi.fn<ShopPublishFn>(async () => ({ message: "boom", scope: "offer", offerId: id }));
    const res = await call("promo_condition_upsert", { ref: REF(id), condition: { type: "cart_quantity", minQuantity: 2 } });
    expect(res.isError).toBe(true);
    expect(body(res).code).toBe("PUBLISH_FAILED");
  });
});

describe("promo_condition_delete", () => {
  it("deletes a condition and republishes an active offer", async () => {
    const id = await draftOffer("active");
    const added = await call("promo_condition_upsert", { ref: REF(id), condition: { type: "cart_quantity", minQuantity: 2 } });
    publish.mockClear();
    const res = await call("promo_condition_delete", { ref: REF(id), conditionId: body(added).data["conditionId"] });
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    expect((await conditionsOf(id)).some((r) => r.conditionType === "cart_quantity")).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("refuses to delete the last enabled main condition of an active offer", async () => {
    const id = await draftOffer("active");
    const [main] = await conditionsOf(id);
    const res = await call("promo_condition_delete", { ref: REF(id), conditionId: main!.id });
    expect(res.isError).toBe(true);
    expect(body(res).message).toContain("Cannot delete the last enabled main condition");
    expect(await conditionsOf(id)).toHaveLength(1);
  });

  it("dryRun leaves the row", async () => {
    const id = await draftOffer("draft");
    const [main] = await conditionsOf(id);
    const res = await call("promo_condition_delete", { ref: REF(id), conditionId: main!.id, dryRun: true });
    expect(res.isError).toBeFalsy();
    expect(await conditionsOf(id)).toHaveLength(1);
  });

  it("answers NOT_FOUND for an unknown condition", async () => {
    const id = await draftOffer("draft");
    const res = await call("promo_condition_delete", { ref: REF(id), conditionId: "00000000-0000-4000-8000-000000000000" });
    expect(body(res).code).toBe("NOT_FOUND");
  });
});

describe("promo_subconditions_set", () => {
  it("replaces every sub-condition and keeps main ones", async () => {
    const id = await draftOffer("active");
    await call("promo_condition_upsert", { ref: REF(id), condition: { type: "customer_tags", includeTags: ["old"] } });
    publish.mockClear();
    const res = await call("promo_subconditions_set", {
      ref: REF(id),
      subconditions: [{ type: "customer_tags", includeTags: ["VIP"] }, { type: "customer_location", includeCountryCodes: ["US"] }],
    });
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    const rows = await conditionsOf(id);
    const subs = rows.filter((r) => r.scope === "sub");
    expect(subs.map((r) => r.conditionType).sort()).toEqual(["customer_location", "customer_tags"]);
    expect(subs.find((r) => r.conditionType === "customer_tags")!.value).toMatchObject({ includeTags: ["VIP"] });
    expect(rows.filter((r) => r.scope === "main")).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("[] clears them; dryRun writes nothing", async () => {
    const id = await draftOffer("draft");
    await call("promo_subconditions_set", { ref: REF(id), subconditions: [{ type: "one_use_per_customer" }] });
    expect((await conditionsOf(id)).filter((r) => r.scope === "sub")).toHaveLength(1);
    await call("promo_subconditions_set", { ref: REF(id), subconditions: [], dryRun: true });
    expect((await conditionsOf(id)).filter((r) => r.scope === "sub")).toHaveLength(1);
    await call("promo_subconditions_set", { ref: REF(id), subconditions: [] });
    expect((await conditionsOf(id)).filter((r) => r.scope === "sub")).toHaveLength(0);
  });
});

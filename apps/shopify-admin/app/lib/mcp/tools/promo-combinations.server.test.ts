import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditLogs, mcpOperators, offerCombinationPolicies, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { setLimitsEnforced } from "../../limits-enforced.server.js";
import type { ShopPublishFn } from "../../offer-publish-flow.server.js";
import { type Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerPromoCombinationsTools } from "./register-promo-combinations.server.js";

const SHOP = "combos-test.myshopify.com";
const ctxHolder = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));

vi.mock("../../shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctxHolder.db,
    shopId: ctxHolder.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: SHOP, accessToken: "tok", scope: "write_customers" },
  }),
}));
vi.mock("../../../shopify.server.js", () => ({ authenticate: { admin: async () => ({ session: { shop: SHOP } }) } }));
vi.mock("@promo/db", async (importOriginal) => ({ ...(await importOriginal<typeof PromoDb>()), getDb: () => ctxHolder.db }));
vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const combinationRoute = await import("../../../routes/app.offers.$id.combination.js");
const priorityRoute = await import("../../../routes/app.offers.$id.priority.js");
const indexRoute = await import("../../../routes/app.offers.$id._index.js");

type Body = { summary: string; data: Record<string, any>; warnings: { code: string }[]; code?: string; details?: Record<string, any> };

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let client: Client;
let publish = vi.fn<ShopPublishFn>(async () => null);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctxHolder.db = db;
  shopId = await seedShop(db, SHOP);
  ctxHolder.shopId = shopId;
  const env = { MCP_TOKEN_PEPPER: "test-pepper-0123456789" } as NodeJS.ProcessEnv;
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "Viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  const operator: Operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
  const ctx: McpContext = {
    db,
    env,
    operator,
    now: () => new Date(),
    rateLimit: async () => ({ ok: true as const }),
    publish: (...args) => publish(...args),
  };
  const server = new McpServer({ name: "test", version: "0" });
  registerPromoCombinationsTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t", version: "0" });
  await client.connect(b);
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publish = vi.fn<ShopPublishFn>(async () => null);
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { res, body: res.structuredContent as unknown as Body };
};
const ref = (id: string) => `promo:combos-test:${id}`;

async function makeOffer(overrides: Partial<typeof offers.$inferInsert> = {}, variant = "1") {
  const id = await seedOffer(db, shopId, { internalName: `[T] ${Math.random().toString(36).slice(2, 8)}`, ...overrides });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
    target: { variantIds: [`gid://shopify/ProductVariant/${variant}`] },
  });
  return id;
}
const policyOf = async (offerId: string) => (await db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)))[0];
const auditsOf = (offerId: string, action: string) => db.select().from(auditLogs).where(and(eq(auditLogs.entityId, offerId), eq(auditLogs.action, action)));

describe("promo_set_combinations", () => {
  it("round trips on a draft offer without publishing", async () => {
    const id = await makeOffer({ status: "draft" });
    const { res, body } = await call("promo_set_combinations", {
      ref: ref(id), combinesWithProductDiscounts: false, combinesWithOrderDiscounts: false, canStackWithGiftOffers: false,
      giftValueCountsForOtherOffers: true, maxApplicationsPerCart: 3, maxApplicationsPerCustomer: 2, requireIdentifiedCustomer: true,
    });
    expect(res.isError).toBeFalsy();
    expect(body.data["before"]).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(await policyOf(id)).toMatchObject({
      combinesWithProductDiscounts: false, combinesWithOrderDiscounts: false, combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true,
      canStackWithGiftOffers: false, giftValueCountsForOtherOffers: true, maxApplicationsPerCart: 3, maxApplicationsPerCustomer: 2,
      requireIdentifiedCustomer: true, stopLowerPriority: false,
    });
    expect((await auditsOf(id, "set_combination")).length).toBe(1);

    // omitted fields keep their value; null clears a limit
    const second = await call("promo_set_combinations", { ref: ref(id), combinesWithShippingDiscounts: false, maxApplicationsPerCart: null });
    expect(second.body.data["before"]).toMatchObject({ combinesWithProductDiscounts: false, maxApplicationsPerCart: 3 });
    expect(await policyOf(id)).toMatchObject({ combinesWithProductDiscounts: false, combinesWithShippingDiscounts: false, maxApplicationsPerCart: null, maxApplicationsPerCustomer: 2 });
  });

  it("republishes an active offer through ctx.publish", async () => {
    const id = await makeOffer({ status: "active" });
    const { res, body } = await call("promo_set_combinations", { ref: ref(id), combinesWithOtherAppOffers: false });
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(body.warnings.map((w) => w.code)).not.toContain("SHOP_WIDE_COMBINATION");
    expect((await policyOf(id))?.combinesWithOtherAppOffers).toBe(false);

    const strict = await call("promo_set_combinations", { ref: ref(id), combinesWithProductDiscounts: false });
    expect(strict.body.warnings.map((w) => w.code)).toContain("SHOP_WIDE_COMBINATION");
  });

  it("dryRun previews and writes nothing", async () => {
    const id = await makeOffer({ status: "active" });
    const { res, body } = await call("promo_set_combinations", { ref: ref(id), combinesWithOrderDiscounts: false, dryRun: true });
    expect(res.isError).toBeFalsy();
    expect(body.summary).toContain("DRY RUN");
    expect(body.data["after"]).toMatchObject({ combinesWithOrderDiscounts: false });
    expect(await policyOf(id)).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects limits outside 1..1000 at the schema, and the service rejects NaN with the route message", async () => {
    const id = await makeOffer({ status: "draft" });
    const { res } = await call("promo_set_combinations", { ref: ref(id), maxApplicationsPerCustomer: 0 });
    expect(res.isError).toBe(true);
    expect(await policyOf(id)).toBeUndefined();
    const { setCombinationPolicy, LIMIT_ERROR } = await import("../../offer-combination.server.js");
    const out = await setCombinationPolicy({ db, shopId, shopDomain: SHOP }, id, { maxApplicationsPerCart: Number.NaN }, { performedBy: SHOP });
    expect(out).toEqual({ ok: false, code: "validation", error: LIMIT_ERROR });
  });

  it("a per-customer limit needs a unique public title: warning first, error once limits are enforced", async () => {
    const id = await makeOffer({ status: "draft", publicTitle: "" });
    const warn = await call("promo_set_combinations", { ref: ref(id), maxApplicationsPerCustomer: 1 });
    expect(warn.res.isError).toBeFalsy();
    expect(warn.body.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["LIMITED_TITLE", "GUESTS_NOT_LIMITED"]));

    await setLimitsEnforced(db, shopId, true, "test");
    const blocked = await call("promo_set_combinations", { ref: ref(id), maxApplicationsPerCustomer: 2 });
    expect(blocked.res.isError).toBe(true);
    expect(blocked.body.code).toBe("VALIDATION");
    expect((await policyOf(id))?.maxApplicationsPerCustomer).toBe(1);
    await setLimitsEnforced(db, shopId, false, "test");
  });

  it("requireIdentifiedCustomer silences the guest advisory", async () => {
    const id = await makeOffer({ status: "draft", publicTitle: "Unique title one" });
    const { body } = await call("promo_set_combinations", { ref: ref(id), maxApplicationsPerCustomer: 1, requireIdentifiedCustomer: true });
    expect(body.warnings.map((w) => w.code)).not.toContain("GUESTS_NOT_LIMITED");
  });

  it("drops the per-cart limit of an order-level offer and says so", async () => {
    const id = await seedOffer(db, shopId, { internalName: "[T] order level", status: "draft" });
    await db.insert(offerRewards).values({ shopId, offerId: id, rewardType: "order_discount", discountType: "percentage", value: { percentage: 10 }, target: {} });
    const { body } = await call("promo_set_combinations", { ref: ref(id), maxApplicationsPerCart: 5 });
    expect(body.warnings.map((w) => w.code)).toContain("PER_CART_IGNORED");
    expect((await policyOf(id))?.maxApplicationsPerCart).toBeNull();
  });

  it("a failed publish keeps the saved policy and reports PUBLISH_FAILED; a capacity block reports CAPACITY_LIMIT", async () => {
    const id = await makeOffer({ status: "active" });
    publish = vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
    const failed = await call("promo_set_combinations", { ref: ref(id), combinesWithShippingDiscounts: false });
    expect(failed.res.isError).toBe(true);
    expect(failed.body.code).toBe("PUBLISH_FAILED");
    expect((await policyOf(id))?.combinesWithShippingDiscounts).toBe(false);

    const { recordCapacityBlock } = await import("../../capacity-capture.server.js");
    publish = vi.fn<ShopPublishFn>(async () => {
      recordCapacityBlock({ shopId, code: "SLOT_FULL", offerIds: [id], numbers: { slotBytes: 10 } });
      return { message: "Too big", scope: "shop" };
    });
    const capacity = await call("promo_set_combinations", { ref: ref(id), combinesWithShippingDiscounts: true });
    expect(capacity.body.code).toBe("CAPACITY_LIMIT");
    expect(capacity.body.details?.["capacity"]).toMatchObject({ code: "SLOT_FULL", offerIds: [id] });
    expect(capacity.body.details?.["limit"]).toEqual(expect.any(String));
  });

  it("unknown offer is NOT_FOUND", async () => {
    const { body } = await call("promo_set_combinations", { ref: ref("00000000-0000-4000-8000-000000000000"), combinesWithOrderDiscounts: false });
    expect(body.code).toBe("NOT_FOUND");
  });
});

describe("promo_set_priority", () => {
  it("sets priority and stop-lower-priority, listing the conflicts of this offer", async () => {
    const a = await makeOffer({ status: "active", priority: 100 }, "777");
    const b = await makeOffer({ status: "active", priority: 100 }, "777");
    const { res, body } = await call("promo_set_priority", { ref: ref(a), priority: 5, stopLowerPriority: true });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(offers).where(eq(offers.id, a)))[0]?.priority).toBe(5);
    expect((await policyOf(a))?.stopLowerPriority).toBe(true);
    expect(body.data["before"]).toEqual({ priority: 100, stopLowerPriority: false });
    const conflicts = body.data["conflicts"] as { type: string; offerIds: string[] }[];
    expect(conflicts.some((c) => c.type === "gift_variant_overlap" && c.offerIds.includes(a) && c.offerIds.includes(b))).toBe(true);
    expect(body.warnings.some((w) => w.code === "CONFLICT_GIFT_VARIANT_OVERLAP")).toBe(true);
    expect(publish).toHaveBeenCalled();
    expect((await auditsOf(a, "set_priority")).length).toBe(1);
  });

  it("omitted stopLowerPriority keeps the stored value; dryRun writes nothing", async () => {
    const id = await makeOffer({ status: "draft", priority: 50 });
    await db.insert(offerCombinationPolicies).values({ shopId, offerId: id, stopLowerPriority: true });
    const dry = await call("promo_set_priority", { ref: ref(id), priority: 7, dryRun: true });
    expect(dry.body.summary).toContain("DRY RUN");
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]?.priority).toBe(50);
    await call("promo_set_priority", { ref: ref(id), priority: 7 });
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]?.priority).toBe(7);
    expect((await policyOf(id))?.stopLowerPriority).toBe(true);
  });

  it("rejects a non-integer priority", async () => {
    const id = await makeOffer({ status: "draft" });
    expect((await call("promo_set_priority", { ref: ref(id), priority: 1.5 })).res.isError).toBe(true);
  });
});

describe("route adapters call the same service", () => {
  type Action = (a: unknown) => Promise<{ error?: string; success?: boolean; warning?: string | null } | null>;
  const post = (action: unknown, id: string, form: Record<string, string>) =>
    (action as Action)({ request: new Request(`http://localhost/app/offers/${id}`, { method: "POST", body: new URLSearchParams(form) }), params: { id }, context: {} });

  it("combination route writes the same row as the MCP tool", async () => {
    const viaTool = await makeOffer({ status: "draft", publicTitle: "Title via tool" });
    const viaRoute = await makeOffer({ status: "draft", publicTitle: "Title via route" });
    await call("promo_set_combinations", {
      ref: ref(viaTool), combinesWithOrderDiscounts: true, combinesWithProductDiscounts: false, combinesWithShippingDiscounts: true,
      combinesWithOtherAppOffers: false, stopLowerPriority: true, giftValueCountsForOtherOffers: true, canStackWithGiftOffers: false,
      maxApplicationsPerCart: 4, maxApplicationsPerCustomer: 2, requireIdentifiedCustomer: true,
    });
    const result = await post(combinationRoute.action, viaRoute, {
      order_discounts: "on", shipping_discounts: "on", stop_lower_priority: "on", gift_value_counts: "on",
      max_per_cart: "4", max_per_customer: "2", require_identified_customer: "on",
    });
    expect(result).toMatchObject({ success: true });
    const strip = ({ id: _i, offerId: _o, createdAt: _c, updatedAt: _u, ...rest }: NonNullable<Awaited<ReturnType<typeof policyOf>>>) => rest;
    expect(strip((await policyOf(viaRoute))!)).toEqual(strip((await policyOf(viaTool))!));
  });

  it("combination route keeps its limit error message", async () => {
    const id = await makeOffer({ status: "draft" });
    const result = await post(combinationRoute.action, id, { max_per_customer: "abc" });
    expect(result?.error).toBe("Limits must be whole numbers between 1 and 1000, or blank for unlimited.");
    expect(await policyOf(id)).toBeUndefined();
  });

  it("set_combination on the offer page only touches the four toggles", async () => {
    const id = await makeOffer({ status: "draft" });
    await db.insert(offerCombinationPolicies).values({ shopId, offerId: id, maxApplicationsPerCustomer: 3, combinesWithOtherAppOffers: false });
    await post(indexRoute.action, id, { intent: "set_combination", product_discounts: "on" });
    expect(await policyOf(id)).toMatchObject({
      combinesWithOrderDiscounts: false, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: false, canStackWithGiftOffers: false,
      maxApplicationsPerCustomer: 3, combinesWithOtherAppOffers: false,
    });
  });

  it("priority route writes the same rows as the MCP tool", async () => {
    const viaTool = await makeOffer({ status: "draft", priority: 100 });
    const viaRoute = await makeOffer({ status: "draft", priority: 100 });
    await call("promo_set_priority", { ref: ref(viaTool), priority: 9, stopLowerPriority: true });
    await post(priorityRoute.action, viaRoute, { priority: "9", stop_lower_priority: "on" });
    const prio = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]?.priority;
    expect(await prio(viaRoute)).toBe(await prio(viaTool));
    expect((await policyOf(viaRoute))?.stopLowerPriority).toBe((await policyOf(viaTool))?.stopLowerPriority);
  });
});

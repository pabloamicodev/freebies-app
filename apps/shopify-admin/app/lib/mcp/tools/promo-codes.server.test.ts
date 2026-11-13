import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  discountCodes,
  mcpOperators,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  type Db,
} from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type * as ExperimentDirectory from "../../experiment-directory.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import { runOfferCodesCommand } from "../../offer-codes.server.js";
import { streamDiscountCodesCsv } from "../../discount-codes.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerPromoCodesTools } from "./register-promo-codes.server.js";

vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));
vi.mock("../../token-crypto.server.js", () => ({ decryptToken: async () => "tok" }));
vi.mock("../../experiment-directory.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ExperimentDirectory>()),
  getExperimentWarnings: vi.fn(async () => [] as string[]),
}));

const SHOP = "codes-test.myshopify.com";
const ENV = { MCP_CONFIRM_SECRET: "x".repeat(40) } as unknown as NodeJS.ProcessEnv;
const PRODUCT = 9208279269615;

type Out = {
  code?: string;
  message?: string;
  summary: string;
  data: Record<string, any>;
  meta: { dryRun?: boolean; page?: { hasMore: boolean; cursor?: string } };
  warnings: { code: string }[];
};

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let operator: Operator;
let publish: ReturnType<typeof vi.fn<ShopPublishFn>>;
let client: Client;

async function connect() {
  const ctx: McpContext = { db, env: ENV, operator, now: () => new Date(), rateLimit: async () => ({ ok: true }), publish };
  const server = new McpServer({ name: "test", version: "0" });
  registerPromoCodesTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "vitest", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), out: result.structuredContent as unknown as Out };
}
const create = (args: Record<string, unknown>) => call("promo_create_code_offer", { shop: SHOP, ...args });

const ref = (id: string) => `promo:codes-test:${id}`;
const codesOf = (offerId: string) => db.select().from(discountCodes).where(eq(discountCodes.offerId, offerId)).orderBy(asc(discountCodes.createdAt), asc(discountCodes.code));
const offerOf = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;

async function liveOffer(extra: Partial<typeof offers.$inferInsert> = {}) {
  const id = await seedOffer(db, shopId, { type: "discount", status: "active", internalName: `live-${Math.random().toString(36).slice(2, 8)}`, ...extra });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "page_types", operator: "in", value: { pageTypes: ["home", "product"] }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({ shopId, offerId: id, rewardType: "order_discount", discountType: "percentage", value: { amount: 10, currencyCode: "USD" }, target: { scope: "cart" } });
  return id;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, SHOP);
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  resetMemoryRateLimits();
  publish = vi.fn<ShopPublishFn>(async () => null);
  client = await connect();
});

describe("promo_create_code_offer", () => {
  it("creates a draft offer with one typed code, the page-types condition, reward and policy", async () => {
    const { isError, out } = await create({ internalName: "Summer 10", code: "summer10", target: "order", discountType: "percentage", value: 10 });
    expect(isError, out.message).toBe(false);
    const id = out.data["offerId"] as string;
    const offer = await offerOf(id);
    expect(offer).toMatchObject({ status: "draft", requiresCode: true, codeRedemption: "checkout_code", publicTitle: "Summer 10", type: "discount" });
    expect((await codesOf(id)).map((c) => c.code)).toEqual(["SUMMER10"]);
    const [cond] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, id));
    expect(cond).toMatchObject({ scope: "main", conditionType: "page_types", value: { pageTypes: ["home", "collection", "product"] } });
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect(reward).toMatchObject({ rewardType: "order_discount", discountType: "percentage", value: { amount: 10, currencyCode: "USD" } });
    const [policy] = await db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, id));
    expect(policy).toMatchObject({ combinesWithOrderDiscounts: false, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true });
    expect(publish).not.toHaveBeenCalled();
  });

  it("creates an active offer with a generated batch and publishes through the injected publish", async () => {
    const { isError, out } = await create({
      internalName: "VIP codes",
      discountMessage: "VIP perk",
      status: "active",
      batch: { count: 5, prefix: "vip-", length: 8 },
      usageLimit: 1,
      oncePerCustomer: true,
      target: "shipping",
      pageTypes: ["cart", "product"],
      utm: { source: "amazon", medium: "cpc" },
    });
    expect(isError, out.message).toBe(false);
    const id = out.data["offerId"] as string;
    expect(out.data).toMatchObject({ status: "active", codesCreated: 5 });
    expect(publish).toHaveBeenCalled();
    expect(await offerOf(id)).toMatchObject({ status: "active", publicTitle: "VIP perk", requiresCode: true });
    const codes = await codesOf(id);
    expect(codes).toHaveLength(5);
    expect(codes.every((c) => c.code.startsWith("VIP-") && c.usageLimit === 1 && c.oncePerCustomer)).toBe(true);
    const conds = await db.select().from(offerConditions).where(eq(offerConditions.offerId, id));
    expect(conds.map((c) => c.conditionType).sort()).toEqual(["page_types", "utm_parameters"]);
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect(reward).toMatchObject({ rewardType: "shipping_discount", discountType: "free" });
  });

  it("discounts selected products (numeric ids become GIDs) and keeps the subscription mode", async () => {
    const { isError, out } = await create({ internalName: "Bundle code", code: "BUNDLE20", target: "products", discountType: "fixed_amount", value: 5.5, productIds: [String(PRODUCT)], subscriptionMode: "one_time_only" });
    expect(isError, out.message).toBe(false);
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, out.data["offerId"]));
    expect(reward).toMatchObject({
      rewardType: "product_discount",
      discountType: "fixed_amount",
      value: { amount: 550, currencyCode: "USD" },
      target: { scopeMode: "sitewide", productIds: [`gid://shopify/Product/${PRODUCT}`], subscriptionMode: "one_time_only" },
    });
  });

  it("automatic redemption creates no codes and runs on conditions alone", async () => {
    const { isError, out } = await create({ internalName: "Auto promo", redemption: "automatic", value: 15 });
    expect(isError, out.message).toBe(false);
    const id = out.data["offerId"] as string;
    expect(out.data["codesCreated"]).toBe(0);
    expect(await codesOf(id)).toHaveLength(0);
    expect(await offerOf(id)).toMatchObject({ codeRedemption: "automatic", requiresCode: false });
  });

  it("rejects bad input with the wizard's messages and dryRun writes nothing", async () => {
    const before = (await db.select().from(offers)).length;
    for (const [args, message] of [
      [{ internalName: "x", value: 10 }, /Enter the discount code/],
      [{ internalName: "x", code: "A B", value: 10 }, /letters, numbers, dashes/],
      [{ internalName: "x", code: "OKCODE", value: 150 }, /more than 100%/],
      [{ internalName: "x", code: "OKCODE", target: "products", value: 10 }, /Select at least one product/],
      [{ internalName: "x", batch: { count: 3, length: 4 }, value: 10 }, /./],
      [{ internalName: "x", code: "OKCODE", value: 10, utm: {} }, /at least one UTM/],
    ] as const) {
      const { isError, out } = await create(args as unknown as Record<string, unknown>);
      expect(isError).toBe(true);
      expect(out.code).toBe("VALIDATION");
      expect(out.message).toMatch(message);
    }
    const dry = await create({ internalName: "Dry", code: "DRYCODE1", value: 10, dryRun: true });
    expect(dry.isError).toBe(false);
    expect(dry.out.meta.dryRun).toBe(true);
    expect((await db.select().from(offers)).length).toBe(before);
  });

  it("a failed Shopify publish leaves a complete draft and says so", async () => {
    publish = vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
    client = await connect();
    const { isError, out } = await create({ internalName: "Doomed", code: "DOOMED10", value: 10, status: "active" });
    expect(isError).toBe(true);
    expect(out.code).toBe("PUBLISH_FAILED");
    expect(out.message).toMatch(/saved as a draft/);
    const [offer] = await db.select().from(offers).where(eq(offers.internalName, "Doomed"));
    expect(offer?.status).toBe("draft");
    expect((await codesOf(offer!.id)).map((c) => c.code)).toEqual(["DOOMED10"]);
  });
});

describe("codes_add and the codes service on a live offer", () => {
  it("adds a typed code and republishes; dryRun validates only", async () => {
    const id = await liveOffer();
    const dry = await call("codes_add", { ref: ref(id), code: "WELCOME15", dryRun: true });
    expect(dry.isError).toBe(false);
    expect(await codesOf(id)).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();

    const done = await call("codes_add", { ref: ref(id), code: "welcome15", usageLimit: 100 });
    expect(done.isError, done.out.message).toBe(false);
    expect(done.out.data).toMatchObject({ code: "WELCOME15" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await codesOf(id)).toMatchObject([{ code: "WELCOME15", usageLimit: 100 }]);
    expect((await offerOf(id)).requiresCode).toBe(true);

    const taken = await call("codes_add", { ref: ref(id), code: "WELCOME15" });
    expect(taken.isError).toBe(true);
    expect(taken.out.code).toBe("VALIDATION");
  });

  it("generates a batch and returns its id; the codes come back through codes_export", async () => {
    const id = await liveOffer();
    const added = await call("codes_add", { ref: ref(id), batch: { count: 4, prefix: "BF-" } });
    expect(added.isError, added.out.message).toBe(false);
    const batchId = added.out.data["batchId"] as string;
    const exported = await call("codes_export", { ref: ref(id), batchId });
    expect(exported.out.data["total"]).toBe(4);
    expect((exported.out.data["rows"] as { code: string }[]).every((r) => r.code.startsWith("BF-") && !r.code.includes("•"))).toBe(true);
  });

  it("deleting a code of a live offer republishes (service shared with the Codes tab)", async () => {
    const id = await liveOffer();
    await call("codes_add", { ref: ref(id), code: "TEMP1234" });
    publish.mockClear();
    const [row] = await codesOf(id);
    const deps = { db, shopId, shopDomain: SHOP, shopCurrency: "USD", timezone: "UTC" };
    const result = await runOfferCodesCommand(deps, id, { intent: "delete", ids: [row!.id] }, { performedBy: "test", publish });
    expect(result).toMatchObject({ ok: true, deleted: 1 });
    expect(await codesOf(id)).toHaveLength(0);
    // delete never republishes in the admin tab either: only unsynced rows can be deleted, so Shopify never saw them.
    expect(publish).not.toHaveBeenCalled();
  });

  it("deactivating codes of a live offer republishes", async () => {
    const id = await liveOffer();
    await call("codes_add", { ref: ref(id), code: "PAUSEME1" });
    publish.mockClear();
    const deps = { db, shopId, shopDomain: SHOP, shopCurrency: "USD", timezone: "UTC" };
    const result = await runOfferCodesCommand(deps, id, { intent: "set_status", status: "disabled", target: { all: true } }, { performedBy: "test", publish });
    expect(result).toMatchObject({ ok: true, changed: 1 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await codesOf(id))[0]?.status).toBe("disabled");
  });
});

describe("redemption mode, discount message, retry original", () => {
  it("switches checkout_code to automatic and back; automatic needs an enabled main condition", async () => {
    const bare = await seedOffer(db, shopId, { type: "discount", status: "draft", internalName: "bare" });
    const refused = await call("codes_set_redemption_mode", { ref: ref(bare), mode: "automatic" });
    expect(refused.isError).toBe(true);
    expect(refused.out.message).toMatch(/at least one enabled condition/);
    expect((await offerOf(bare)).codeRedemption).toBe("checkout_code");

    const id = await liveOffer();
    const auto = await call("codes_set_redemption_mode", { ref: ref(id), mode: "automatic" });
    expect(auto.isError, auto.out.message).toBe(false);
    expect((await offerOf(id)).codeRedemption).toBe("automatic");
    expect(publish).toHaveBeenCalled();
    const same = await call("codes_set_redemption_mode", { ref: ref(id), mode: "automatic" });
    expect(same.out.data["unchanged"]).toBe(true);
    const back = await call("codes_set_redemption_mode", { ref: ref(id), mode: "checkout_code" });
    expect(back.isError, back.out.message).toBe(false);
    expect((await offerOf(id)).codeRedemption).toBe("checkout_code");
  });

  it("sets the discount message, falls back to the name and rejects over-long text", async () => {
    const id = await liveOffer({ internalName: "Spring promo" });
    expect((await call("codes_set_discount_message", { ref: ref(id), message: "  10% off today " })).isError).toBe(false);
    expect((await offerOf(id)).publicTitle).toBe("10% off today");
    await call("codes_set_discount_message", { ref: ref(id), message: "" });
    expect((await offerOf(id)).publicTitle).toBe("Spring promo");
    const long = await call("codes_set_discount_message", { ref: ref(id), message: "x".repeat(61) });
    expect(long.isError).toBe(true);
    expect(long.out.message).toMatch(/at most 60/);
  });

  it("retry_original refuses a code that has no original", async () => {
    const id = await liveOffer();
    await call("codes_add", { ref: ref(id), code: "PLAIN123" });
    const [row] = await codesOf(id);
    const out = await call("codes_retry_original", { ref: ref(id), codeId: row!.id });
    expect(out.isError).toBe(true);
    expect(out.out.message).toMatch(/no original/);
  });
});

describe("codes_export", () => {
  it("returns the same CSV as the admin export route, unmasked", async () => {
    const id = await liveOffer();
    await call("codes_add", { ref: ref(id), batch: { count: 7, prefix: "EXP-" }, usageLimit: 3 });
    await call("codes_add", { ref: ref(id), code: "TYPEDONE" });
    const route = await new Response(streamDiscountCodesCsv(db, shopId, id, {}, 3)).text();
    const { isError, out } = await call("codes_export", { ref: ref(id) });
    expect(isError, out.message).toBe(false);
    expect(out.data["csv"]).toBe(route);
    expect(out.data["total"]).toBe(8);
    expect(out.warnings.map((w) => w.code)).toContain("UNMASKED_CODES");
  });

  it("pages with a cursor and filters by status; a page concatenation equals the full export", async () => {
    const id = await liveOffer();
    await call("codes_add", { ref: ref(id), batch: { count: 5, prefix: "PG-" } });
    const first = await call("codes_export", { ref: ref(id), limit: 2 });
    expect(first.out.meta.page).toMatchObject({ hasMore: true });
    const rows: string[] = (first.out.data["rows"] as { code: string }[]).map((r) => r.code);
    let cursor = first.out.meta.page?.cursor;
    while (cursor) {
      const next = await call("codes_export", { ref: ref(id), limit: 2, cursor });
      rows.push(...(next.out.data["rows"] as { code: string }[]).map((r) => r.code));
      cursor = next.out.meta.page?.cursor;
    }
    const all = await call("codes_export", { ref: ref(id) });
    expect(rows).toEqual((all.out.data["rows"] as { code: string }[]).map((r) => r.code));
    expect(rows).toHaveLength(5);
    const none = await call("codes_export", { ref: ref(id), status: "exhausted" });
    expect(none.out.data["total"]).toBe(0);
    const bad = await call("codes_export", { ref: ref(id), cursor: "garbage" });
    expect(bad.isError).toBe(true);
  });
});

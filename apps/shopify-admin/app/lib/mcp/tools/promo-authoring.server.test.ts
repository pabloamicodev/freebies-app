import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  auditLogs,
  mcpOperators,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  productCache,
  variantCache,
  type Db,
} from "@promo/db";
import { evaluate, type OfferDefinition } from "@promo/rule-engine";
import type { EvaluationInput, NormalizedCart } from "@promo/shared-types";
import { createTestDb, seedShop } from "../../test-support/pglite-db.js";
import { compileCartOffers } from "../../sync/cart-offers.server.js";
import { serializeFunctionConfig } from "../../sync/compile-config.js";
import { loadOfferDefinitions } from "../../offer-definitions.server.js";
import * as preflight from "../../capacity-preflight.server.js";
import type { ShopPublishFn } from "../../offer-publish-flow.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerPromoAuthoringTools } from "./register-promo-authoring.server.js";

vi.mock("../../offer-definitions.server.js", async (importActual) => {
  const actual = await importActual<typeof import("../../offer-definitions.server.js")>();
  return { ...actual, invalidateOfferDefinitions: async () => undefined };
});
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));
vi.mock("../../capacity-preflight.server.js", async (importActual) => {
  const actual = await importActual<typeof import("../../capacity-preflight.server.js")>();
  return { ...actual, preflightCapacity: vi.fn(actual.preflightCapacity) };
});

const SHOP = "onesolsupps.myshopify.com";
const PRODUCT_ID = "9208279269615";
const PRODUCT_GID = `gid://shopify/Product/${PRODUCT_ID}`;
const VARIANT_GID = "gid://shopify/ProductVariant/48000000000001";
const FIXTURE_DIR = fileURLToPath(new URL("../../../../../../packages/rule-engine/test-fixtures/parity/", import.meta.url));
const FIXTURE_OFFER_ID = "eeeeeeee-0000-4000-8000-000000000001";
const FIXTURE_REWARD_ID = "eeeeeeee-0000-4000-8000-000000000002";

type Body = {
  summary: string;
  data: Record<string, any>;
  warnings: { code: string }[];
  meta: { dryRun?: boolean };
  code?: string;
  message?: string;
  details?: Record<string, any>;
};
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let operator: Operator;
let publish = vi.fn<ShopPublishFn>(async () => null);
let client: Client;
let actualPreflight: typeof preflight.preflightCapacity;

const OWNER_REWARD = {
  kind: "product_discount",
  target: { scope: "selected", products: [PRODUCT_ID] },
  quantityTiers: [
    { minQuantity: 1, maxQuantity: 1, discountType: "percentage", value: 20 },
    { minQuantity: 2, discountType: "percentage", value: 30 },
  ],
};
const ownerCall = (extra: Record<string, unknown> = {}) => ({
  shop: "onesolsupps",
  type: "discount",
  internalName: "Protein & Creatine Bundle volume",
  status: "active",
  rewards: [OWNER_REWARD],
  ...extra,
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "promo-engine-test", version: "0.0.0" });
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: async () => ({ ok: true }), publish };
  registerPromoAuthoringTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: "vitest", version: "0.0.0" });
  await c.connect(clientSide);
  return c;
}
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const offerRow = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const offerCount = async () => (await db.select({ id: offers.id }).from(offers).where(eq(offers.shopId, shopId))).length;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, SHOP);
  await db.insert(productCache).values({ shopId, productGid: PRODUCT_GID, handle: "protein-creatine-bundle", title: "Protein & Creatine Bundle", raw: {} });
  await db.insert(variantCache).values({ shopId, productGid: PRODUCT_GID, variantGid: VARIANT_GID, title: "Default Title", price: "59.99", currencyCode: "USD", raw: {} });
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
  actualPreflight = (await vi.importActual<typeof import("../../capacity-preflight.server.js")>("../../capacity-preflight.server.js")).preflightCapacity;
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  publish = vi.fn<ShopPublishFn>(async () => null);
  client = await connect();
});
afterEach(() => {
  vi.mocked(preflight.preflightCapacity).mockImplementation(actualPreflight);
});

/** The rule the Function applies to a unit count: the highest tier whose range holds it. */
const tierFor = (tiers: Array<{ minimumQuantity: number; maximumQuantity?: number; discountValue: number }>, units: number) =>
  tiers.filter((t) => units >= t.minimumQuantity && (t.maximumQuantity === undefined || units <= t.maximumQuantity)).sort((a, b) => b.minimumQuantity - a.minimumQuantity)[0];

function cartOf(units: number): NormalizedCart {
  return {
    token: "t",
    id: null,
    lines: [
      {
        key: "l1",
        variantId: VARIANT_GID,
        productId: PRODUCT_GID,
        quantity: units,
        priceCents: 5999,
        compareAtPriceCents: null,
        properties: {},
        requiresSellingPlan: false,
        sellingPlanId: null,
        productHandle: "protein-creatine-bundle",
        productTitle: "Protein & Creatine Bundle",
        variantTitle: null,
        vendor: "v",
        productType: "t",
        tags: [],
        collections: [],
        availableForSale: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: null,
      },
    ],
    subtotalCents: 5999 * units,
    discountCodes: [],
    currencyCode: "USD",
    totalQuantity: units,
  };
}
const evaluationInput = (units: number): EvaluationInput => ({
  shopDomain: SHOP,
  cart: cartOf(units),
  customer: null,
  market: { id: "gid://shopify/Market/1", handle: "m", currencyCode: "USD", countryCode: "US", primaryLocale: "en" },
  locale: "en",
  salesChannel: "online_store",
  requestedUrl: null,
  sessionId: "mcpfa-03",
});

async function compileOffer(offerId: string) {
  const [offer] = await db.select().from(offers).where(eq(offers.id, offerId));
  const [conditions, rewards, policies] = await Promise.all([
    db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)),
    db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)),
  ]);
  const [entry] = await compileCartOffers(db, shopId, [offer!], { conditions, rewards, policies, shopCurrencyCode: "USD", limitsEnforced: false, caller: "offer-publisher" });
  return { entry: entry!, offer: offer!, conditions, rewards };
}

describe("owner acceptance: Protein & Creatine Bundle 1x -> 20%, 2x -> 30% on onesolsupps", () => {
  let offerId: string;

  it("promo_create stores an active offer, publishes it and compiles both tiers on the product", async () => {
    const result = await call("promo_create", ownerCall());
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    offerId = body(result).data["offerId"];
    expect(body(result).data["status"]).toBe("active");
    expect(body(result).data["offer"]).toEqual(expect.anything());
    expect(publish).toHaveBeenCalledTimes(1);

    const row = await offerRow(offerId);
    expect(row).toMatchObject({ status: "active", type: "discount", internalName: "Protein & Creatine Bundle volume", priority: 100, createdBy: `mcp:${operator.id}` });
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId));
    expect(reward).toMatchObject({ rewardType: "product_discount", discountType: "percentage", trackMode: "product", isAutoAdd: false, isCustomerSelectable: false });
    expect(reward!.value).toEqual({
      amount: 0,
      currencyCode: "USD",
      tiers: [
        { minimumQuantity: 1, maximumQuantity: 1, discountType: "percentage", discountValue: 20 },
        { minimumQuantity: 2, discountType: "percentage", discountValue: 30 },
      ],
    });
    expect(reward!.target).toEqual({ scopeMode: "sitewide", scope: "cart", productIds: [PRODUCT_GID], variantIds: [], selectionLevel: "product", selectionMode: "all", countRule: "all", displayType: "quantity_options" });
    const conditions = await db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId));
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ scope: "main", conditionType: "cart_quantity", operator: "gte", value: { minQuantity: 1, includeGiftValues: false }, isEnabled: true });
    const [policy] = await db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId));
    expect(policy).toMatchObject({ combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true, stopLowerPriority: false });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, offerId), eq(auditLogs.action, "create_offer")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ performedBy: `mcp:${operator.id}` });
    expect(JSON.stringify(audit[0]!.after)).toContain("_mcp");

    const { entry } = await compileOffer(offerId);
    expect(entry.offer.productRewards).toHaveLength(1);
    const compiled = entry.offer.productRewards[0]!;
    expect(compiled.targetProductIds).toEqual([PRODUCT_GID]);
    expect(compiled.quantityTiers.map((t) => [t.minimumQuantity, t.maximumQuantity, t.discountType, t.discountValue])).toEqual([
      [1, 1, "percentage", 20],
      [2, undefined, "percentage", 30],
    ]);
    expect(entry.offer.cartQuantityThreshold).toBe(1);
  });

  it("the rule engine qualifies 1 unit at the 20% tier and 2 units at the 30% tier", async () => {
    const definitions: OfferDefinition[] = (await loadOfferDefinitions(shopId, db)) as unknown as OfferDefinition[];
    expect(definitions.map((d) => d.id)).toContain(offerId);
    const { entry } = await compileOffer(offerId);
    const tiers = entry.offer.productRewards[0]!.quantityTiers;
    for (const [units, percent] of [[1, 20], [2, 30], [3, 30]] as const) {
      const result = await evaluate(evaluationInput(units), { offers: definitions, usageStates: [], now: new Date() });
      expect(result.qualifiedOffers.map((o) => o.offerId)).toContain(offerId);
      expect(tierFor(tiers, units)?.discountValue).toBe(percent);
    }
  });

  it("matches the parity golden fixtures compiled from this offer (UPDATE_MCP_FIXTURES=1 rewrites them)", async () => {
    const { entry, conditions, rewards, offer } = await compileOffer(offerId);
    const swapIds = (text: string) => text.split(offer.id).join(FIXTURE_OFFER_ID).split(rewards[0]!.id).join(FIXTURE_REWARD_ID);
    const compiled = { ...entry.offer, version: 1 };
    const config = JSON.parse(swapIds(JSON.stringify(JSON.parse(serializeFunctionConfig({ offers: [compiled], shippingOffers: [], version: "parity", compiledAt: "2026-01-01T00:00:00.000Z" }))))) as unknown;
    const source = {
      offers: [
        {
          id: FIXTURE_OFFER_ID,
          version: 1,
          type: "discount",
          priority: 100,
          stopLowerPriority: false,
          conditions: conditions.map((c) => ({ conditionType: c.conditionType, value: c.value, scope: c.scope, operator: c.operator, sortOrder: c.sortOrder })),
          rewards: rewards.map((r) => ({
            id: FIXTURE_REWARD_ID,
            rewardType: r.rewardType,
            discountType: r.discountType,
            value: r.value,
            target: r.target,
            quantity: null,
            isAutoAdd: false,
            isCustomerSelectable: false,
            trackMode: r.trackMode,
            sortOrder: r.sortOrder,
            label: null,
          })),
        },
      ],
    };
    const fixture = (name: string, description: string, units: number) => ({
      name,
      description,
      source,
      config,
      cart: {
        currency: "USD",
        presentmentCurrencyRate: 1,
        country: "US",
        customerTags: [] as string[],
        enteredCodes: [] as string[],
        lines: [{ id: "l1", variantId: VARIANT_GID, productId: PRODUCT_GID, quantity: units, unitPrice: "59.99", lineType: null, metadata: null }],
      },
      expected: {
        qualifiedOfferIds: [FIXTURE_OFFER_ID],
        discountedLineIds: { [FIXTURE_OFFER_ID]: ["l1"] },
        discountedQuantities: { [FIXTURE_OFFER_ID]: { l1: units } },
      },
    });
    const fixtures = [
      fixture("mcp-quantity-tiers-single", "promo_create volume offer, tiers 1x -> 20% and 2+ -> 30% on one product: 1 unit is discounted (20% tier).", 1),
      fixture("mcp-quantity-tiers", "promo_create volume offer, tiers 1x -> 20% and 2+ -> 30% on one product: both units are discounted (30% tier).", 2),
    ];
    for (const f of fixtures) {
      const path = `${FIXTURE_DIR}${f.name}.json`;
      const text = `${JSON.stringify(f, null, 2)}\n`;
      if (process.env["UPDATE_MCP_FIXTURES"] === "1") writeFileSync(path, text);
      expect(existsSync(path), `missing ${f.name}.json, run with UPDATE_MCP_FIXTURES=1`).toBe(true);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as typeof f;
      expect(onDisk.config).toEqual(f.config);
      expect(onDisk.source).toEqual(f.source);
      expect(onDisk.expected).toEqual(f.expected);
    }
  });

  it("dryRun previews without writing or publishing", async () => {
    const before = await offerCount();
    const result = await call("promo_create", ownerCall({ internalName: "Dry run only", dryRun: true }));
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(body(result).meta.dryRun).toBe(true);
    expect(body(result).data["status"]).toBe("active");
    expect(await offerCount()).toBe(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it("promo_update with a stale expectedUpdatedAt is a STATE_CONFLICT and changes nothing", async () => {
    const stale = await call("promo_update", { ref: `promo:onesolsupps:${offerId}`, priority: 7, expectedUpdatedAt: new Date(0).toISOString() });
    expect(stale.isError).toBe(true);
    expect(body(stale).code).toBe("STATE_CONFLICT");
    expect((await offerRow(offerId)).priority).toBe(100);
  });

  it("promo_update with the current updatedAt replaces the rewards, republishes and bumps updatedAt", async () => {
    const current = (await offerRow(offerId)).updatedAt;
    const result = await call("promo_update", {
      ref: `promo:onesolsupps:${offerId}`,
      priority: 7,
      rewards: [{ ...OWNER_REWARD, quantityTiers: [{ minQuantity: 1, discountType: "percentage", value: 25 }] }],
      expectedUpdatedAt: current.toISOString(),
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    const row = await offerRow(offerId);
    expect(row.priority).toBe(7);
    expect(row.status).toBe("active");
    expect(row.updatedAt.getTime()).toBeGreaterThan(current.getTime());
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId));
    expect((reward!.value as { tiers: unknown[] }).tiers).toEqual([{ minimumQuantity: 1, discountType: "percentage", discountValue: 25 }]);
    expect((await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)))).toHaveLength(1);
  });
});

describe("promo_update edge cases", () => {
  it("dryRun previews the patch and leaves the offer untouched", async () => {
    const [existing] = await db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.internalName, "Protein & Creatine Bundle volume")));
    const result = await call("promo_update", { ref: `promo:onesolsupps:${existing!.id}`, priority: 3, dryRun: true });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(body(result).meta.dryRun).toBe(true);
    expect((await offerRow(existing!.id)).priority).toBe(7);
    expect(publish).not.toHaveBeenCalled();
  });

  it("an unknown offer is NOT_FOUND", async () => {
    const result = await call("promo_update", { ref: "promo:onesolsupps:00000000-0000-4000-8000-000000000000", priority: 3 });
    expect(result.isError).toBe(true);
    expect(body(result).code).toBe("NOT_FOUND");
  });
});

describe("capacity", () => {
  const tooLarge = (offerIds: string[]) => ({ ok: false as const, code: "OFFER_TOO_LARGE" as const, offerIds, offerNames: ["x"], numbers: { bytes: 20000, max: 10000 }, message: "The offer is too large for one Shopify discount." });

  it("a capacity block on create answers CAPACITY_LIMIT and keeps the offer as a draft", async () => {
    vi.mocked(preflight.preflightCapacity).mockImplementation(async (_db, _shop, ids) => tooLarge([...ids]));
    const result = await call("promo_create", ownerCall({ internalName: "Capacity blocked" }));
    expect(result.isError).toBe(true);
    expect(body(result).code).toBe("CAPACITY_LIMIT");
    const details = body(result).details!;
    expect(details["capacity"]).toMatchObject({ code: "OFFER_TOO_LARGE", numbers: { bytes: 20000, max: 10000 } });
    expect(typeof details["limit"]).toBe("string");
    expect(Array.isArray(details["workarounds"])).toBe(true);
    const [saved] = await db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.internalName, "Capacity blocked")));
    expect(saved?.status).toBe("draft");
  });

  it("dryRun reports the same CAPACITY_LIMIT and writes nothing", async () => {
    vi.mocked(preflight.preflightCapacity).mockImplementation(async (_db, _shop, ids) => tooLarge([...ids]));
    const before = await offerCount();
    const result = await call("promo_create", ownerCall({ internalName: "Capacity dry run", dryRun: true }));
    expect(result.isError).toBe(true);
    expect(body(result).code).toBe("CAPACITY_LIMIT");
    expect(await offerCount()).toBe(before);
  });
});

describe("validation and the other reward shape", () => {
  it("rejects a product that is not in the shop's catalog", async () => {
    const result = await call("promo_create", ownerCall({ internalName: "Ghost", rewards: [{ ...OWNER_REWARD, target: { scope: "selected", products: ["111"] } }] }));
    expect(result.isError).toBe(true);
    expect(body(result).code).toBe("VALIDATION");
    expect(body(result).message).toMatch(/not found in/);
  });

  it("rejects overlapping tiers and percentages over 100", async () => {
    const overlap = await call("promo_create", ownerCall({ internalName: "Overlap", rewards: [{ ...OWNER_REWARD, quantityTiers: [{ minQuantity: 1, discountType: "percentage", value: 20 }, { minQuantity: 2, discountType: "percentage", value: 30 }] }] }));
    expect(body(overlap).code).toBe("VALIDATION");
    const over = await call("promo_create", ownerCall({ internalName: "Over", rewards: [{ ...OWNER_REWARD, quantityTiers: [{ minQuantity: 1, discountType: "percentage", value: 120 }] }] }));
    expect(body(over).code).toBe("VALIDATION");
  });

  it("a taken name gets a unique suffix, like the wizards", async () => {
    const first = await call("promo_create", ownerCall({ internalName: "Same name", status: "draft" }));
    const second = await call("promo_create", ownerCall({ internalName: "Same name", status: "draft" }));
    expect(second.isError, JSON.stringify(second.structuredContent)).toBeFalsy();
    expect(body(second).data["internalName"]).not.toBe("Same name");
    expect(String(body(second).data["internalName"])).toContain("Same name (");
    expect(body(first).data["status"]).toBe("draft");
  });

  it("an order_discount by subtotal derives a cart_value main condition and stores cents", async () => {
    const result = await call("promo_create", {
      shop: "onesolsupps",
      type: "discount",
      internalName: "Spend more save more",
      status: "draft",
      rewards: [{ kind: "order_discount", by: "subtotal", tiers: [{ minimum: 50, maximum: 99.99, value: 10 }, { minimum: 100, value: 15 }] }],
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const id = body(result).data["offerId"];
    const [condition] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, id));
    expect(condition).toMatchObject({ scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false } });
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect(reward!.rewardType).toBe("order_discount");
    expect((reward!.value as { tiers: unknown[] }).tiers).toEqual([
      { minimumSubtotalCents: 5000, maximumSubtotalCents: 9999, discountType: "percentage", discountValue: 10, label: "" },
      { minimumSubtotalCents: 10000, discountType: "percentage", discountValue: 15, label: "" },
    ]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("a flat fixed_amount discount is stored in minor units", async () => {
    const result = await call("promo_create", {
      shop: "onesolsupps",
      type: "discount",
      internalName: "Ten off",
      status: "draft",
      rewards: [{ kind: "product_discount", target: { scope: "all_products" }, discount: { discountType: "fixed_amount", value: 10 } }],
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, body(result).data["offerId"]));
    expect(reward).toMatchObject({ discountType: "fixed_amount", value: { amount: 1000, currencyCode: "USD" } });
  });

  it("a scheduled start stores the offer as scheduled and does not publish", async () => {
    const result = await call("promo_create", ownerCall({ internalName: "Future", startsAt: "2099-01-01T09:00", endsAt: "2099-02-01T09:00" }));
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(body(result).data["status"]).toBe("scheduled");
    expect(publish).not.toHaveBeenCalled();
  });

  it("a reward of another family than the offer type is refused", async () => {
    const result = await call("promo_create", ownerCall({ internalName: "Mixed", type: "gift" }));
    expect(result.isError).toBe(true);
    expect(body(result).code).toBe("VALIDATION");
  });
});

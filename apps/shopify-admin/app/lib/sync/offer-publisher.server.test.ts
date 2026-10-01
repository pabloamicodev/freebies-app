import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DrizzleOrm from "drizzle-orm";
import type * as PromoDb from "@promo/db";
import type * as CartValidation from "../cart-validation.server.js";
import { CART_FUNCTION_TITLE } from "../discount-node.server.js";
import { neutralizeCodeDiscountNode, publishOffersForShop } from "./offer-publisher.server.js";

const SHOP_ID = "11111111-1111-1111-1111-111111111111";
const SHOP_DOMAIN = "test-shop.myshopify.com";
const CART_DISCOUNT_ID = "gid://shopify/DiscountAutomaticNode/cart";
const DELIVERY_DISCOUNT_ID = "gid://shopify/DiscountAutomaticNode/delivery";

// Drizzle's eq/and/inArray/isNotNull build opaque SQL nodes — recover the
// column + value/values vitest passed in via simple marker objects instead
// of parsing SQL, mirroring the pattern in analytics-reconcile.server.test.ts.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => ({ kind: "eq", column, value }),
    and: (...conds: unknown[]) => ({ kind: "and", conds }),
    inArray: (column: { name: string }, values: unknown[]) => ({ kind: "inArray", column, values }),
    isNotNull: (column: { name: string }) => ({ kind: "isNotNull", column }),
  };
});

vi.mock("../token-crypto.server.js", () => ({
  decryptToken: async () => "decrypted-token",
}));

// syncCartValidation makes its own Shopify calls unrelated to what this
// suite verifies (shared vs. per-code-offer discount routing) — stub it out
// so it doesn't need its own GraphQL response fixtures, but capture what it
// was called with so tests can assert code offers are actually folded into
// the shop-wide validation config. buildCartValidationConfig is pure and kept real.
const cartValidationCalls: Array<CartValidation.CartValidationConfig> = [];
vi.mock("../cart-validation.server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CartValidation>();
  return {
    ...actual,
    syncCartValidation: async (
      _shopDomain: string,
      _accessToken: string,
      config: CartValidation.CartValidationConfig,
    ) => {
      cartValidationCalls.push(config);
    },
  };
});

interface FakeOffer {
  id: string;
  shopId: string;
  type: string;
  status: string;
  internalName: string;
  publicTitle: string;
  priority: number;
  requiredDiscountCode: string | null;
  requiresCode: boolean;
  codeDiscountId: string | null;
  discountTags: string[];
  compiledConfig: unknown;
}

interface FakeShop {
  id: string;
  myshopifyDomain: string;
  isActive: boolean;
  accessTokenEncrypted: string;
  discountId: string;
  deliveryDiscountId: string;
}

interface FakeCode {
  requestedCode?: string | null;
  collisionNote?: string | null;
  batchId?: string | null;
  id: string;
  shopId: string;
  offerId: string;
  code: string;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usageCount: number;
  oncePerCustomer: boolean;
  shopifySyncedAt: Date | null;
}

interface MetafieldPush {
  ownerIds: string[];
  value: string;
}

const { state, getDbMock, shopifyGraphQLMock } = vi.hoisted(() => {
  const state = {
    offers: [] as FakeOffer[],
    shops: [] as FakeShop[],
    metafieldPushes: [] as MetafieldPush[],
    knownDiscountIds: new Set<string>(),
    nextCodeDiscountId: null as string | null,
    codeRows: [] as FakeCode[],
    batchRows: [] as Array<{ id: string; shopId: string; prefix: string; length: number; charset: string }>,
    /** Codes that exist in Shopify as someone else's discount: code -> {id, title}. */
    shopifyCodes: {} as Record<string, { id: string; title: string }>,
    /** Free at pre-flight, but taken by the time the bulk job runs (a race). */
    raceCodes: new Set<string>(),
    conditionRows: [] as Array<Record<string, unknown>>,
    settings: [] as Array<{ shopId: string; key: string; value: string }>,
    nextAutoNodeId: "gid://shopify/DiscountAutomaticNode/codes",
    createdAutoNodes: [] as Array<{ handle: string; classes: string[] }>,
    /** Function id a code node reports; defaults to the cart-lines Function. */
    nodeFunctionIds: {} as Record<string, string>,
    createdCodeNodes: [] as Array<{ code: string; handle: string; classes: string[]; input: Record<string, unknown> }>,
    updatedCodeNodes: [] as Array<{ id: string; input: Record<string, unknown> }>,
    expiredNodes: [] as string[],
    deletedNodes: [] as string[],
    addedCodes: [] as Array<{ discountId: string; codes: string[] }>,
    removedCodes: [] as Array<{ discountId: string; ids: string[] }>,
    nodeCodes: {} as Record<string, string[]>,
    rejectCodes: new Set<string>(),
    rewardRows: [] as Array<{
      id: string;
      shopId: string;
      offerId: string;
      rewardType: string;
      discountType: string;
      value: unknown;
      target: unknown;
      quantity: number | null;
      sortOrder: number;
    }>,
  };

  function keyFor(columnName: string): string {
    const map: Record<string, string> = {
      id: "id",
      shop_id: "shopId",
      status: "status",
      code_discount_id: "codeDiscountId",
      myshopify_domain: "myshopifyDomain",
      is_active: "isActive",
      offer_id: "offerId",
    };
    return map[columnName] ?? columnName;
  }

  function evalCondition(cond: unknown, row: Record<string, unknown>): boolean {
    if (!cond || typeof cond !== "object") return true;
    const c = cond as { kind?: string; conds?: unknown[]; column?: { name: string }; value?: unknown; values?: unknown[] };
    switch (c.kind) {
      case "and":
        return (c.conds ?? []).every((sub) => evalCondition(sub, row));
      case "eq":
        return row[keyFor(c.column!.name)] === c.value;
      case "inArray":
        return (c.values ?? []).includes(row[keyFor(c.column!.name)]);
      case "isNotNull":
        return row[keyFor(c.column!.name)] != null;
      default:
        return true;
    }
  }

  function withLimit<T>(rows: T[]) {
    return {
      then(resolve: (value: T[]) => void) {
        resolve(rows);
      },
      limit(n: number) {
        return Promise.resolve(rows.slice(0, n));
      },
    };
  }

  function isOffersTable(table: unknown): boolean {
    return Boolean(table) && typeof table === "object" && "internalName" in (table as object);
  }
  function isShopsTable(table: unknown): boolean {
    return Boolean(table) && typeof table === "object" && "myshopifyDomain" in (table as object);
  }
  function isBatchesTable(table: unknown): boolean {
    return Boolean(table) && typeof table === "object" && "charset" in (table as object);
  }
  function isSettingsTable(table: unknown): boolean {
    return Boolean(table) && typeof table === "object" && "key" in (table as object) && "value" in (table as object);
  }
  function isConditionsTable(table: unknown): boolean {
    return Boolean(table) && typeof table === "object" && "conditionType" in (table as object);
  }
  function isCodesTable(table: unknown): boolean {
    return Boolean(table) && typeof table === "object" && "oncePerCustomer" in (table as object);
  }
  function isRewardsTable(table: unknown): boolean {
    return Boolean(table) && typeof table === "object" && "rewardType" in (table as object);
  }

  function rowsFor(table: unknown): Array<Record<string, unknown>> {
    if (isOffersTable(table)) return state.offers as unknown as Array<Record<string, unknown>>;
    if (isShopsTable(table)) return state.shops as unknown as Array<Record<string, unknown>>;
    if (isRewardsTable(table)) return state.rewardRows as unknown as Array<Record<string, unknown>>;
    if (isCodesTable(table)) return state.codeRows as unknown as Array<Record<string, unknown>>;
    if (isConditionsTable(table)) return state.conditionRows;
    if (isBatchesTable(table)) return state.batchRows as unknown as Array<Record<string, unknown>>;
    if (isSettingsTable(table)) return state.settings as unknown as Array<Record<string, unknown>>;
    // offerConditions / offerCombinationPolicies / appSettings — this suite
    // only exercises publisher routing, not condition compilation content, so
    // every offer's conditions/policy stay empty unless a test needs otherwise.
    return [];
  }

  function getDbMock() {
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => withLimit(rowsFor(table).filter((row) => evalCondition(cond, row))),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: { shopId: string; key: string; value: string }) => ({
          onConflictDoUpdate: () => {
            if (isSettingsTable(table)) {
              state.settings = [
                ...state.settings.filter((row) => !(row.shopId === values.shopId && row.key === values.key)),
                values,
              ];
            }
            return Promise.resolve();
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            if (isOffersTable(table)) {
              state.offers = state.offers.map((row) =>
                evalCondition(cond, row as unknown as Record<string, unknown>)
                  ? { ...row, ...values }
                  : row,
              );
            } else if (isCodesTable(table)) {
              state.codeRows = state.codeRows.map((row) =>
                evalCondition(cond, row as unknown as Record<string, unknown>)
                  ? { ...row, ...values }
                  : row,
              );
            } else if (isShopsTable(table)) {
              state.shops = state.shops.map((row) =>
                evalCondition(cond, row as unknown as Record<string, unknown>)
                  ? { ...row, ...values }
                  : row,
              );
            }
            return Promise.resolve();
          },
        }),
      }),
      transaction: async (cb: (tx: { execute: () => Promise<void> }) => Promise<void>) =>
        cb({ execute: async () => {} }),
    };
  }

  const shopifyGraphQLMock = async ({
    query,
    variables,
  }: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<unknown> => {
    if (query.includes("PromoEngineCodeLookup")) {
      const result: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(variables!)) {
        const code = value as string;
        const held = state.shopifyCodes[code];
        const ownCodes = Object.values(state.nodeCodes).flat();
        if (held) result[`c${name.slice(1)}`] = { id: held.id, codeDiscount: { title: held.title } };
        else if (ownCodes.includes(code))
          result[`c${name.slice(1)}`] = {
            id: Object.keys(state.nodeCodes).find((id) => state.nodeCodes[id]!.includes(code)),
            codeDiscount: { title: "Promo Engine" },
          };
        else result[`c${name.slice(1)}`] = null;
      }
      return result;
    }
    if (query.includes("CheckCodeDiscountNode")) {
      const id = variables!.id as string;
      return {
        codeDiscountNode: state.knownDiscountIds.has(id)
          ? {
              id,
              codeDiscount: {
                appDiscountType: {
                  functionId: state.nodeFunctionIds[id] ?? "gid://shopify/ShopifyFunction/cart",
                },
              },
            }
          : null,
      };
    }
    if (query.includes("CheckDiscountNode")) {
      const id = variables!.id as string;
      return { discountNode: state.knownDiscountIds.has(id) ? { id } : null };
    }
    if (query.includes("FindDiscountFunction") || query.includes("FindExistingAppDiscount")) {
      if (query.includes("FindExistingAppDiscount")) {
        return { discountNodes: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      return {
        shopifyFunctions: {
          nodes: [
            {
              id: "gid://shopify/ShopifyFunction/cart",
              apiType: "discount",
              handle: "promo-engine-discount",
              title: "Promo Engine Discount",
            },
            {
              id: "gid://shopify/ShopifyFunction/code",
              apiType: "discount",
              handle: "promo-engine-code-discount",
              title: "Promo Engine Code Discount",
            },
            {
              id: "gid://shopify/ShopifyFunction/delivery",
              apiType: "discount",
              handle: "promo-engine-delivery-discount",
              title: "Promo Engine Delivery Discount",
            },
          ],
        },
      };
    }
    if (query.includes("CreatePromoEngineDiscount")) {
      const discount = variables!.discount as { functionHandle: string; discountClasses: string[] };
      state.createdAutoNodes.push({ handle: discount.functionHandle, classes: discount.discountClasses });
      state.knownDiscountIds.add(state.nextAutoNodeId);
      return {
        discountAutomaticAppCreate: {
          automaticAppDiscount: { discountId: state.nextAutoNodeId },
          userErrors: [],
        },
      };
    }
    if (query.includes("ExpirePromoEngineCodeDiscount")) {
      state.expiredNodes.push(variables!.id as string);
      return { discountCodeAppUpdate: { codeAppDiscount: { discountId: variables!.id }, userErrors: [] } };
    }
    if (query.includes("DeletePromoEngineCodeDiscount")) {
      state.deletedNodes.push(variables!.id as string);
      state.knownDiscountIds.delete(variables!.id as string);
      return { discountCodeDelete: { deletedCodeDiscountId: variables!.id, userErrors: [] } };
    }
    if (query.includes("AddPromoEngineRedeemCodes")) {
      const codes = (variables!.codes as Array<{ code: string }>).map((c) => c.code);
      for (const code of codes) {
        if (state.raceCodes.has(code)) {
          state.shopifyCodes[code] = { id: "gid://shopify/DiscountCodeNode/race", title: "Created a moment ago" };
          state.rejectCodes.add(code);
        }
      }
      state.addedCodes.push({ discountId: variables!.discountId as string, codes });
      state.nodeCodes[variables!.discountId as string] = [
        ...(state.nodeCodes[variables!.discountId as string] ?? []),
        ...codes.filter((code) => !state.rejectCodes.has(code)),
      ];
      return {
        discountRedeemCodeBulkAdd: { bulkCreation: { id: `bulk-${state.addedCodes.length}`, done: false }, userErrors: [] },
      };
    }
    if (query.includes("PromoEngineRedeemCodeBulkCreation")) {
      const last = state.addedCodes.at(-1)!;
      return {
        discountRedeemCodeBulkCreation: {
          done: true,
          codes: {
            nodes: last.codes.map((code) => ({
              code,
              errors: state.rejectCodes.has(code) ? [{ code: "TAKEN", message: "must be unique" }] : [],
            })),
          },
        },
      };
    }
    if (query.includes("FindPromoEngineRedeemCodes")) {
      const codes = state.nodeCodes[variables!.id as string] ?? [];
      return {
        codeDiscountNode: {
          codeDiscount: { codes: { nodes: codes.map((code) => ({ id: `rc:${code}`, code })) } },
        },
      };
    }
    if (query.includes("RemovePromoEngineRedeemCodes")) {
      const ids = variables!.ids as string[];
      state.removedCodes.push({ discountId: variables!.discountId as string, ids });
      state.nodeCodes[variables!.discountId as string] = (state.nodeCodes[variables!.discountId as string] ?? []).filter(
        (code) => !ids.includes(`rc:${code}`),
      );
      return { discountCodeRedeemCodeBulkDelete: { job: { id: "job-1" }, userErrors: [] } };
    }
    if (query.includes("PromoEngineJob")) return { job: { done: true } };
    if (query.includes("CreatePromoEngineCodeDiscount")) {
      const discount = variables!.discount as Record<string, unknown>;
      state.createdCodeNodes.push({
        code: discount.code as string,
        handle: discount.functionHandle as string,
        classes: discount.discountClasses as string[],
        input: discount,
      });
      const discountId = state.nextCodeDiscountId;
      if (discountId) state.knownDiscountIds.add(discountId);
      return {
        discountCodeAppCreate: {
          codeAppDiscount: discountId ? { discountId } : null,
          userErrors: discountId ? [] : [{ field: null, message: "No discount id configured for test" }],
        },
      };
    }
    if (query.includes("UpdatePromoEngineCodeDiscountCombination")) {
      state.updatedCodeNodes.push({ id: variables!.id as string, input: variables!.discount as Record<string, unknown> });
      return {
        discountCodeAppUpdate: {
          codeAppDiscount: { discountId: variables!.id },
          userErrors: [],
        },
      };
    }
    if (query.includes("UpdatePromoEngineDiscountCombination")) {
      return {
        discountAutomaticAppUpdate: {
          automaticAppDiscount: { discountId: variables!.id },
          userErrors: [],
        },
      };
    }
    if (query.includes("MetafieldsSet")) {
      const metafields = variables!.metafields as Array<{ ownerId: string; value: string }>;
      state.metafieldPushes.push({
        ownerIds: metafields.map((m) => m.ownerId),
        value: metafields[0]?.value ?? "{}",
      });
      return { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    throw new Error(`Unhandled GraphQL query in offer-publisher.server.test.ts: ${query.slice(0, 80)}`);
  };

  return { state, getDbMock, shopifyGraphQLMock };
});

vi.mock("@promo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof PromoDb>();
  return { ...actual, getDb: getDbMock };
});

vi.mock("../shopify-fetch.server.js", () => ({
  shopifyGraphQL: shopifyGraphQLMock,
}));

function makeOffer(overrides: Partial<FakeOffer> & { id: string }): FakeOffer {
  return {
    shopId: SHOP_ID,
    type: "gift",
    status: "active",
    internalName: overrides.id,
    publicTitle: overrides.id,
    priority: 100,
    requiredDiscountCode: null,
    requiresCode: false,
    codeDiscountId: null,
    discountTags: [],
    compiledConfig: null,
    ...overrides,
  };
}

function makeShop(): FakeShop {
  return {
    id: SHOP_ID,
    myshopifyDomain: SHOP_DOMAIN,
    isActive: true,
    accessTokenEncrypted: "encrypted-token",
    discountId: CART_DISCOUNT_ID,
    deliveryDiscountId: DELIVERY_DISCOUNT_ID,
  };
}

function parsedConfig(value: string): { offers: Array<{ id: string }> } {
  return JSON.parse(value) as { offers: Array<{ id: string }> };
}

describe("publishOffersForShop — code-gated offers", () => {
  beforeEach(() => {
    state.offers = [];
    state.shops = [makeShop()];
    state.metafieldPushes = [];
    state.knownDiscountIds = new Set([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID]);
    state.nextCodeDiscountId = null;
    state.rewardRows = [];
    state.codeRows = [];
    state.conditionRows = [];
    state.nodeFunctionIds = {};
    state.createdCodeNodes = [];
    state.updatedCodeNodes = [];
    state.expiredNodes = [];
    state.deletedNodes = [];
    state.addedCodes = [];
    state.removedCodes = [];
    state.nodeCodes = {};
    state.rejectCodes = new Set();
    state.shopifyCodes = {};
    state.raceCodes = new Set();
    state.batchRows = [];
    cartValidationCalls.length = 0;
  });

  it("excludes a code-gated offer from the shared config and gives it its own single-offer push", async () => {
    const regular = makeOffer({ id: "regular-1" });
    const codeOffer = makeOffer({
      id: "code-1",
      requiredDiscountCode: "PRIMEDAY2026",
      codeDiscountId: "gid://shopify/DiscountCodeNode/1",
    });
    state.offers = [regular, codeOffer];
    state.knownDiscountIds.add("gid://shopify/DiscountCodeNode/1");

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const sharedPush = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
    expect(sharedPush).toBeDefined();
    expect(parsedConfig(sharedPush!.value).offers.map((o) => o.id)).toEqual(["regular-1"]);

    const codePush = state.metafieldPushes.find((p) =>
      p.ownerIds.includes("gid://shopify/DiscountCodeNode/1"),
    );
    expect(codePush).toBeDefined();
    expect(codePush!.ownerIds).toEqual(["gid://shopify/DiscountCodeNode/1"]);
    expect(parsedConfig(codePush!.value).offers.map((o) => o.id)).toEqual(["code-1"]);
  });

  it("creates and persists a codeDiscountId when the offer doesn't have one yet", async () => {
    const codeOffer = makeOffer({
      id: "code-2",
      requiredDiscountCode: "SUMMER2026",
      codeDiscountId: null,
    });
    state.offers = [codeOffer];
    state.nextCodeDiscountId = "gid://shopify/DiscountCodeNode/new";

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const updated = state.offers.find((o) => o.id === "code-2");
    expect(updated?.codeDiscountId).toBe("gid://shopify/DiscountCodeNode/new");

    const codePush = state.metafieldPushes.find((p) =>
      p.ownerIds.includes("gid://shopify/DiscountCodeNode/new"),
    );
    expect(codePush).toBeDefined();
    expect(parsedConfig(codePush!.value).offers.map((o) => o.id)).toEqual(["code-2"]);
  });

  it("empties a code offer's node once it's no longer active, without touching the discount itself", async () => {
    const staleOffer = makeOffer({
      id: "code-3",
      status: "paused",
      requiredDiscountCode: "OLDCODE",
      codeDiscountId: "gid://shopify/DiscountCodeNode/stale",
    });
    const regular = makeOffer({ id: "regular-2" });
    state.offers = [staleOffer, regular];
    state.knownDiscountIds.add("gid://shopify/DiscountCodeNode/stale");

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const stalePush = state.metafieldPushes.find((p) =>
      p.ownerIds.includes("gid://shopify/DiscountCodeNode/stale"),
    );
    expect(stalePush).toBeDefined();
    expect(parsedConfig(stalePush!.value).offers).toEqual([]);
  });

  it("empties a code offer's own node after it goes inactive on a later, separate publish call — not just when the DB was pre-seeded as already stale", async () => {
    const codeOffer = makeOffer({
      id: "code-5",
      requiredDiscountCode: "FALLTRANS",
      codeDiscountId: null,
    });
    const regular = makeOffer({ id: "regular-3" });
    state.offers = [codeOffer, regular];
    state.nextCodeDiscountId = "gid://shopify/DiscountCodeNode/trans";

    // First publish: the offer is active, so it should get a fresh
    // codeDiscountId and a populated single-offer config.
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const afterFirstPublish = state.offers.find((o) => o.id === "code-5");
    expect(afterFirstPublish?.codeDiscountId).toBe("gid://shopify/DiscountCodeNode/trans");
    const firstCodePush = state.metafieldPushes.find((p) =>
      p.ownerIds.includes("gid://shopify/DiscountCodeNode/trans"),
    );
    expect(firstCodePush).toBeDefined();
    expect(parsedConfig(firstCodePush!.value).offers.map((o) => o.id)).toEqual(["code-5"]);

    // Now the merchant pauses the offer between publishes — a second,
    // independent publish call must neutralize the SAME node that the first
    // call had just populated, using the codeDiscountId persisted by that
    // first call (not one seeded directly into test state).
    state.offers = state.offers.map((o) => (o.id === "code-5" ? { ...o, status: "paused" } : o));
    state.metafieldPushes = [];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const secondCodePush = state.metafieldPushes.find((p) =>
      p.ownerIds.includes("gid://shopify/DiscountCodeNode/trans"),
    );
    expect(secondCodePush).toBeDefined();
    expect(parsedConfig(secondCodePush!.value).offers).toEqual([]);
  });

  it("empties every stale code-offer node even when there are no active offers of any kind", async () => {
    const staleOffer = makeOffer({
      id: "code-4",
      status: "archived",
      requiredDiscountCode: "GONE",
      codeDiscountId: "gid://shopify/DiscountCodeNode/gone",
    });
    state.offers = [staleOffer];
    state.knownDiscountIds.add("gid://shopify/DiscountCodeNode/gone");

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const stalePush = state.metafieldPushes.find((p) =>
      p.ownerIds.includes("gid://shopify/DiscountCodeNode/gone"),
    );
    expect(stalePush).toBeDefined();
    expect(parsedConfig(stalePush!.value).offers).toEqual([]);

    // Still pushes the empty shared config too — same as before this feature.
    const sharedPush = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
    expect(sharedPush).toBeDefined();
    expect(parsedConfig(sharedPush!.value).offers).toEqual([]);
  });

  it("folds a code offer's gift reward into the shop-wide cart-validation config, alongside a regular offer's", async () => {
    const regular = makeOffer({ id: "regular-4" });
    const codeOffer = makeOffer({
      id: "code-6",
      requiredDiscountCode: "GIFTCODE",
      codeDiscountId: "gid://shopify/DiscountCodeNode/gift",
    });
    state.offers = [regular, codeOffer];
    state.knownDiscountIds.add("gid://shopify/DiscountCodeNode/gift");
    state.rewardRows = [
      {
        id: "reward-regular",
        shopId: SHOP_ID,
        offerId: "regular-4",
        rewardType: "product_gift",
        discountType: "free",
        value: {},
        target: { variantIds: ["gid://shopify/ProductVariant/1"] },
        quantity: 1,
        sortOrder: 0,
      },
      {
        id: "reward-code",
        shopId: SHOP_ID,
        offerId: "code-6",
        rewardType: "product_gift",
        discountType: "free",
        value: {},
        target: { variantIds: ["gid://shopify/ProductVariant/2"] },
        quantity: 1,
        sortOrder: 0,
      },
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    // Before the fix, cart validation only ever saw regular offers — a gift
    // reward on a code-gated offer would fail validation as if no offer had
    // authorized it, even though its own discount node was live and correct.
    expect(cartValidationCalls).toHaveLength(1);
    expect(Object.keys(cartValidationCalls[0]!.offerRules).sort()).toEqual(["code-6", "regular-4"]);
    expect(cartValidationCalls[0]!.allowedGiftVariantIds).toEqual(
      ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"].sort(),
    );
  });

  it("does not neutralize an active code offer's node even if a stale archived row shares the same codeDiscountId", async () => {
    // Reproduces the archive-then-reuse-the-same-code collision: an archived
    // offer's Shopify discount node gets recovered for a brand new offer
    // using the same code (createOrFindCodeDiscount's duplicate-recovery
    // path), so two DB rows now point at the same live discountId. Without
    // filtering by discountId (not just offer id), neutralizeStaleCodeOffers
    // would wipe the config this same publish just wrote for the active offer.
    const sharedDiscountId = "gid://shopify/DiscountCodeNode/shared";
    const archived = makeOffer({
      id: "archived-old",
      status: "archived",
      requiredDiscountCode: "REUSEDCODE",
      codeDiscountId: sharedDiscountId,
    });
    const active = makeOffer({
      id: "active-new",
      requiredDiscountCode: "REUSEDCODE",
      codeDiscountId: sharedDiscountId,
    });
    state.offers = [archived, active];
    state.knownDiscountIds.add(sharedDiscountId);

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const pushesToSharedNode = state.metafieldPushes.filter((p) => p.ownerIds.includes(sharedDiscountId));
    expect(pushesToSharedNode.length).toBeGreaterThan(0);
    // The LAST push to this node must be the active offer's real config, not
    // an empty one from a neutralize pass that ran after and clobbered it.
    expect(parsedConfig(pushesToSharedNode.at(-1)!.value).offers.map((o) => o.id)).toEqual([
      "active-new",
    ]);
  });
});

function makeCode(overrides: Partial<FakeCode> & { code: string; offerId: string }): FakeCode {
  return {
    id: `id-${overrides.code}`,
    shopId: SHOP_ID,
    status: "active",
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    usageCount: 0,
    oncePerCustomer: false,
    shopifySyncedAt: null,
    ...overrides,
  };
}

const NODE = "gid://shopify/DiscountCodeNode/own";

function shippingRewardFor(offerId: string) {
  return {
    id: `ship-${offerId}`,
    shopId: SHOP_ID,
    offerId,
    rewardType: "shipping_discount",
    discountType: "free",
    value: { amount: 100 },
    target: { deliveryGroupTypes: ["ONE_TIME_PURCHASE"] },
    quantity: null,
    sortOrder: 0,
  };
}

describe("publishOffersForShop — offers with their own discount codes", () => {
  beforeEach(() => {
    state.offers = [];
    state.shops = [makeShop()];
    state.metafieldPushes = [];
    state.knownDiscountIds = new Set([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID]);
    state.nextCodeDiscountId = NODE;
    state.rewardRows = [];
    state.codeRows = [];
    state.conditionRows = [];
    state.nodeFunctionIds = {};
    state.createdCodeNodes = [];
    state.updatedCodeNodes = [];
    state.expiredNodes = [];
    state.deletedNodes = [];
    state.addedCodes = [];
    state.removedCodes = [];
    state.nodeCodes = {};
    state.rejectCodes = new Set();
    state.shopifyCodes = {};
    state.raceCodes = new Set();
    state.batchRows = [];
    cartValidationCalls.length = 0;
  });

  it("creates one node with the first code, attaches the rest in bulk, and keeps the offer out of the shared config", async () => {
    state.offers = [makeOffer({ id: "regular" }), makeOffer({ id: "coded" })];
    state.codeRows = [
      makeCode({ offerId: "coded", code: "AAA" }),
      makeCode({ offerId: "coded", code: "BBB" }),
      makeCode({ offerId: "coded", code: "CCC" }),
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.createdCodeNodes).toHaveLength(1);
    expect(state.createdCodeNodes[0]).toMatchObject({
      code: "AAA",
      handle: "promo-engine-discount",
      classes: ["PRODUCT", "ORDER"],
    });
    expect(state.createdCodeNodes[0]!.input["title"]).toBe("[Promo Engine] coded");
    expect(state.addedCodes).toEqual([{ discountId: NODE, codes: ["BBB", "CCC"] }]);
    expect(state.codeRows.every((row) => row.shopifySyncedAt)).toBe(true);
    expect(state.offers.find((o) => o.id === "coded")?.codeDiscountId).toBe(NODE);

    const shared = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
    expect(parsedConfig(shared!.value).offers.map((o) => o.id)).toEqual(["regular"]);
    const own = state.metafieldPushes.find((p) => p.ownerIds.includes(NODE));
    expect(parsedConfig(own!.value).offers.map((o) => o.id)).toEqual(["coded"]);
  });

  it("is idempotent: a second publish adds and removes nothing", async () => {
    state.offers = [makeOffer({ id: "coded" })];
    state.codeRows = [makeCode({ offerId: "coded", code: "AAA" }), makeCode({ offerId: "coded", code: "BBB" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    state.addedCodes = [];
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.addedCodes).toEqual([]);
    expect(state.removedCodes).toEqual([]);
    expect(state.createdCodeNodes).toHaveLength(1);
  });

  it("attaches codes 250 per call", async () => {
    state.offers = [makeOffer({ id: "coded" })];
    state.codeRows = Array.from({ length: 601 }, (_, i) =>
      makeCode({ offerId: "coded", code: `C${String(i).padStart(4, "0")}` }),
    );

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    // 1 code is the node's primary; the other 600 go out as 250 + 250 + 100.
    expect(state.addedCodes.map((call) => call.codes.length)).toEqual([250, 250, 100]);
    expect(state.codeRows.every((row) => row.shopifySyncedAt)).toBe(true);
  });

  describe("collisions with the merchant's own Shopify discounts", () => {
    it("publishes a chosen code that already exists in Shopify as a suffixed variant, without touching their discount", async () => {
      state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.shopifyCodes["PRIME"] = { id: "gid://shopify/DiscountCodeNode/influencer", title: "Influencer PRIME" };
      state.codeRows = [
        makeCode({ offerId: "coded", code: "KEEP", shopifySyncedAt: new Date() }),
        makeCode({ offerId: "coded", code: "PRIME" }),
      ];
      state.nodeCodes[NODE] = ["KEEP"];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      const row = state.codeRows.find((r) => r.requestedCode === "PRIME")!;
      expect(row.code).toMatch(/^PRIME-[A-HJ-NP-Z2-9]{3}$/);
      expect(row.collisionNote).toBe("Influencer PRIME");
      expect(state.addedCodes).toEqual([{ discountId: NODE, codes: [row.code] }]);
      expect(row.shopifySyncedAt).toBeTruthy();
      // Their discount is never modified, renamed or deleted.
      expect(state.expiredNodes).toEqual([]);
      expect(state.deletedNodes).toEqual([]);
      expect(state.updatedCodeNodes.every((update) => update.id === NODE)).toBe(true);
    });

    it("picks the same variant every time for the same code and offer (deterministic, readable)", async () => {
      const make = () => {
        state.offers = [makeOffer({ id: "coded" })];
        state.shopifyCodes = { PRIME: { id: "x", title: "T" } };
        state.codeRows = [makeCode({ offerId: "coded", code: "PRIME" })];
        state.nodeCodes = {};
        state.knownDiscountIds = new Set([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID]);
      };
      make();
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      const first = state.codeRows[0]!.code;
      make();
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      expect(state.codeRows[0]!.code).toBe(first);
    });

    it("creates the node with a free suffixed code when the first code is taken", async () => {
      state.offers = [makeOffer({ id: "coded" })];
      state.shopifyCodes["PRIME"] = { id: "x", title: "Influencer" };
      state.codeRows = [makeCode({ offerId: "coded", code: "PRIME" })];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.createdCodeNodes[0]!.code).toMatch(/^PRIME-/);
      expect(state.createdCodeNodes[0]!.code).toBe(state.codeRows[0]!.code);
    });

    it("recognises a code already on our own node and does not re-add or rename it", async () => {
      state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.nodeCodes[NODE] = ["OURS", "OTHER"];
      state.codeRows = [
        makeCode({ offerId: "coded", code: "OTHER", shopifySyncedAt: new Date() }),
        makeCode({ offerId: "coded", code: "OURS" }),
      ];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.addedCodes).toEqual([]);
      expect(state.codeRows.find((r) => r.code === "OURS")?.requestedCode ?? null).toBeNull();
      expect(state.codeRows.every((r) => r.shopifySyncedAt)).toBe(true);
    });

    it("replaces a colliding generated code with a fresh one of the same shape, silently", async () => {
      state.offers = [makeOffer({ id: "coded" })];
      state.batchRows = [{ id: "batch-1", shopId: SHOP_ID, prefix: "AMZ-", length: 6, charset: "numbers" }];
      state.codeRows = [
        makeCode({ offerId: "coded", code: "AMZ-111111", batchId: "batch-1" }),
        makeCode({ offerId: "coded", code: "AMZ-222222", batchId: "batch-1" }),
      ];
      state.shopifyCodes["AMZ-222222"] = { id: "x", title: "Their code" };

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      const codes = state.codeRows.map((r) => r.code);
      expect(codes).toContain("AMZ-111111");
      expect(codes).not.toContain("AMZ-222222");
      expect(codes.every((code) => /^AMZ-\d{6}$/.test(code))).toBe(true);
      // Generated codes are not "requested" by anyone, so no notice is raised.
      expect(state.codeRows.every((r) => !r.requestedCode)).toBe(true);
      expect(new Set(codes).size).toBe(2);
    });

    it("handles a code taken between the pre-flight and the bulk job: suffixes it, and the publish completes", async () => {
      state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.nodeCodes[NODE] = ["FIRST"];
      state.codeRows = [
        makeCode({ offerId: "coded", code: "FIRST", shopifySyncedAt: new Date() }),
        makeCode({ offerId: "coded", code: "RACE1" }),
        makeCode({ offerId: "coded", code: "FINE1" }),
      ];
      state.raceCodes = new Set(["RACE1"]);

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      const raced = state.codeRows.find((r) => r.requestedCode === "RACE1")!;
      expect(raced.code).toMatch(/^RACE1-/);
      expect(state.codeRows.every((r) => r.shopifySyncedAt)).toBe(true);
      expect(state.nodeCodes[NODE]).toEqual(expect.arrayContaining(["FIRST", "FINE1", raced.code]));
      expect(state.nodeCodes[NODE]).not.toContain("RACE1");
    });

    it("still fails loudly (never half-published silently) when Shopify keeps rejecting for an unknown reason", async () => {
      state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.nodeCodes[NODE] = ["FIRST"];
      state.codeRows = [
        makeCode({ offerId: "coded", code: "FIRST", shopifySyncedAt: new Date() }),
        makeCode({ offerId: "coded", code: "BAD!" }),
      ];
      // Rejected by the bulk job, yet the lookup says it is free: nothing to rename around.
      state.rejectCodes = new Set(["BAD!"]);

      await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).rejects.toThrow(/kept rejecting 1 code/);
    });
  });

  it("removes a deactivated code from the node but keeps the node live for the others", async () => {
    state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
    state.knownDiscountIds.add(NODE);
    state.nodeCodes[NODE] = ["AAA", "BBB"];
    state.codeRows = [
      makeCode({ offerId: "coded", code: "AAA", shopifySyncedAt: new Date() }),
      makeCode({ offerId: "coded", code: "BBB", status: "disabled", shopifySyncedAt: new Date() }),
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.removedCodes).toEqual([{ discountId: NODE, ids: ["rc:BBB"] }]);
    expect(state.codeRows.find((row) => row.code === "BBB")?.shopifySyncedAt).toBeNull();
    expect(state.expiredNodes).toEqual([]);
    expect(state.updatedCodeNodes.at(-1)?.input["endsAt"]).toBeNull();
  });

  it("removes an expired or used-up code, not just deactivated ones", async () => {
    state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
    state.knownDiscountIds.add(NODE);
    state.nodeCodes[NODE] = ["AAA", "OLD", "FULL"];
    state.codeRows = [
      makeCode({ offerId: "coded", code: "AAA", shopifySyncedAt: new Date() }),
      makeCode({ offerId: "coded", code: "OLD", endsAt: new Date(Date.now() - 1000), shopifySyncedAt: new Date() }),
      makeCode({
        offerId: "coded",
        code: "FULL",
        status: "exhausted",
        usageLimit: 1,
        usageCount: 1,
        shopifySyncedAt: new Date(),
      }),
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.removedCodes[0]!.ids.sort()).toEqual(["rc:FULL", "rc:OLD"]);
  });

  it("expires the node, and does not reopen it, when no code is redeemable any more", async () => {
    state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE }), makeOffer({ id: "regular" })];
    state.knownDiscountIds.add(NODE);
    state.nodeCodes[NODE] = ["AAA"];
    state.codeRows = [makeCode({ offerId: "coded", code: "AAA", status: "disabled", shopifySyncedAt: new Date() })];
    const gift = (offerId: string, variant: number) => ({
      id: `gift-${offerId}`,
      shopId: SHOP_ID,
      offerId,
      rewardType: "product_gift",
      discountType: "free",
      value: {},
      target: { variantIds: [`gid://shopify/ProductVariant/${variant}`] },
      quantity: 1,
      sortOrder: 0,
    });
    state.rewardRows = [gift("coded", 1), gift("regular", 2)];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.expiredNodes).toEqual([NODE]);
    expect(state.updatedCodeNodes).toEqual([]);
    expect(
      state.metafieldPushes.some((p) => p.ownerIds.includes(NODE) && parsedConfig(p.value).offers.length > 0),
    ).toBe(false);
    expect(Object.keys(cartValidationCalls[0]!.offerRules)).toEqual(["regular"]);
  });

  it("never publishes a code offer ungated: with no redeemable code and no node it publishes nothing for it", async () => {
    state.offers = [makeOffer({ id: "coded" }), makeOffer({ id: "regular" })];
    state.codeRows = [makeCode({ offerId: "coded", code: "AAA", status: "disabled" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.createdCodeNodes).toEqual([]);
    const shared = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
    expect(parsedConfig(shared!.value).offers.map((o) => o.id)).toEqual(["regular"]);
  });

  it("holds a legacy discount_code condition offer back instead of publishing it without the gate", async () => {
    state.offers = [makeOffer({ id: "legacy" }), makeOffer({ id: "regular" })];
    state.conditionRows = [
      { id: "c1", shopId: SHOP_ID, offerId: "legacy", conditionType: "discount_code", isEnabled: true, scope: "main", value: { code: "X" } },
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const shared = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
    expect(parsedConfig(shared!.value).offers.map((o) => o.id)).toEqual(["regular"]);
  });

  it("mirrors a single code's usage limit and an all-once-per-customer rule onto the node", async () => {
    state.offers = [makeOffer({ id: "single", codeDiscountId: NODE })];
    state.knownDiscountIds.add(NODE);
    state.codeRows = [
      makeCode({ offerId: "single", code: "ONE", usageLimit: 50, oncePerCustomer: true, shopifySyncedAt: new Date() }),
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.updatedCodeNodes.at(-1)?.input).toMatchObject({
      usageLimit: 50,
      appliesOncePerCustomer: true,
      endsAt: null,
    });

    state.codeRows.push(makeCode({ offerId: "single", code: "TWO", oncePerCustomer: false, shopifySyncedAt: new Date() }));
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.updatedCodeNodes.at(-1)?.input).toMatchObject({ usageLimit: null, appliesOncePerCustomer: false });
  });

  describe("shipping rewards", () => {
    it("binds a shipping-only code offer to the delivery Function with the SHIPPING class and its shipping config", async () => {
      state.offers = [makeOffer({ id: "ship" })];
      state.codeRows = [makeCode({ offerId: "ship", code: "FREESHIP" }), makeCode({ offerId: "ship", code: "FREESHIP2" })];
      state.rewardRows = [shippingRewardFor("ship")];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.createdCodeNodes[0]).toMatchObject({
        code: "FREESHIP",
        handle: "promo-engine-delivery-discount",
        classes: ["SHIPPING"],
      });
      const own = state.metafieldPushes.find((p) => p.ownerIds.includes(NODE));
      const config = JSON.parse(own!.value) as { offers?: unknown[]; shippingOffers: Array<{ id: string }> };
      expect(config.offers ?? []).toEqual([]);
      expect(config.shippingOffers.map((o) => o.id)).toEqual(["ship:ship-ship"]);
      expect(state.addedCodes).toEqual([{ discountId: NODE, codes: ["FREESHIP2"] }]);
      // The shared delivery node must not also serve it, or the code would be bypassed.
      const sharedDelivery = state.metafieldPushes.find((p) => p.ownerIds.includes(DELIVERY_DISCOUNT_ID));
      expect((JSON.parse(sharedDelivery!.value) as { shippingOffers?: unknown[] }).shippingOffers ?? []).toEqual([]);
    });

    it("keeps combinesWith consistent with automatic delivery offers (shipping can't combine with shipping)", async () => {
      state.offers = [makeOffer({ id: "ship" })];
      state.codeRows = [makeCode({ offerId: "ship", code: "FREESHIP" })];
      state.rewardRows = [shippingRewardFor("ship")];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      const update = state.updatedCodeNodes.at(-1)!;
      expect(update.input["discountClasses"]).toEqual(["SHIPPING"]);
      expect(update.input["combinesWith"]).toMatchObject({
        shippingDiscounts: false,
        orderDiscounts: true,
        productDiscounts: true,
      });
    });

    it("replaces a node that is on the wrong Function when the offer's rewards move to shipping", async () => {
      state.offers = [makeOffer({ id: "ship", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.nodeFunctionIds[NODE] = "gid://shopify/ShopifyFunction/cart";
      state.codeRows = [
        makeCode({ offerId: "ship", code: "FREESHIP", shopifySyncedAt: new Date() }),
        makeCode({ offerId: "ship", code: "FREESHIP2", shopifySyncedAt: new Date() }),
      ];
      state.rewardRows = [shippingRewardFor("ship")];
      state.nextCodeDiscountId = "gid://shopify/DiscountCodeNode/ship-new";

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.deletedNodes).toEqual([NODE]);
      expect(state.createdCodeNodes[0]).toMatchObject({
        handle: "promo-engine-delivery-discount",
        classes: ["SHIPPING"],
      });
      expect(state.offers.find((o) => o.id === "ship")?.codeDiscountId).toBe("gid://shopify/DiscountCodeNode/ship-new");
      expect(state.addedCodes.at(-1)?.codes).toEqual(["FREESHIP2"]);
    });

    it("neutralizeCodeDiscountNode empties the config and expires a shipping code node too", async () => {
      state.knownDiscountIds.add(NODE);

      await neutralizeCodeDiscountNode(SHOP_ID, SHOP_DOMAIN, NODE);

      const push = state.metafieldPushes.find((p) => p.ownerIds.includes(NODE));
      const config = JSON.parse(push!.value) as { offers?: unknown[]; shippingOffers?: unknown[] };
      expect(config.offers ?? []).toEqual([]);
      expect(config.shippingOffers ?? []).toEqual([]);
      expect(state.expiredNodes).toEqual([NODE]);
    });
  });
});


describe("publishOffersForShop — code backend B (code Function)", () => {
  const CODE_NODE = "gid://shopify/DiscountAutomaticNode/codes";
  const flagOn = () => {
    state.settings = [{ shopId: SHOP_ID, key: "code_backend_b.enabled", value: "true" }];
  };

  beforeEach(() => {
    state.offers = [];
    state.shops = [makeShop()];
    state.metafieldPushes = [];
    state.knownDiscountIds = new Set([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID]);
    state.nextCodeDiscountId = NODE;
    state.rewardRows = [];
    state.codeRows = [];
    state.conditionRows = [];
    state.settings = [];
    state.createdAutoNodes = [];
    state.createdCodeNodes = [];
    state.updatedCodeNodes = [];
    state.expiredNodes = [];
    state.addedCodes = [];
    state.nodeCodes = {};
    state.shopifyCodes = {};
    state.raceCodes = new Set();
    state.rejectCodes = new Set();
    cartValidationCalls.length = 0;
  });

  const gift = (offerId: string) => ({
    id: `gift-${offerId}`,
    shopId: SHOP_ID,
    offerId,
    rewardType: "product_gift",
    discountType: "free",
    value: {},
    target: { variantIds: ["gid://shopify/ProductVariant/9"] },
    quantity: 1,
    sortOrder: 0,
  });

  it("stays off by default: code offers still get their own Shopify code node", async () => {
    state.offers = [makeOffer({ id: "coded" })];
    state.codeRows = [makeCode({ offerId: "coded", code: "AAA" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.createdCodeNodes).toHaveLength(1);
    expect(state.createdAutoNodes).toEqual([]);
  });

  it("compiles code offers into the code node's config with code hashes, no per-offer Shopify code node", async () => {
    flagOn();
    state.offers = [makeOffer({ id: "coded" }), makeOffer({ id: "regular" })];
    state.codeRows = [makeCode({ offerId: "coded", code: "summer10" }), makeCode({ offerId: "coded", code: "VIP-2026" })];
    state.rewardRows = [gift("coded"), gift("regular")];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.createdCodeNodes).toEqual([]);
    expect(state.createdAutoNodes).toEqual([{ handle: "promo-engine-code-discount", classes: ["PRODUCT", "ORDER"] }]);
    const push = state.metafieldPushes.find((p) => p.ownerIds.includes(CODE_NODE));
    const config = JSON.parse(push!.value) as Record<string, unknown> & { offers: Array<{ id: string; codeHashes: string[] }> };
    expect(config.offers.map((o) => o.id)).toEqual(["coded"]);
    expect(config.offers[0]!.codeHashes).toEqual(["9e35947c8d25", "e8cf18d732cc"].sort());
    // The code Function's query declares no c1-c3 variables, so they must not be sent.
    expect(config).not.toHaveProperty("c1");
    expect(config).toHaveProperty("customerTags");
    const shared = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
    expect(parsedConfig(shared!.value).offers.map((o) => o.id)).toEqual(["regular"]);
    expect(Object.keys(cartValidationCalls[0]!.offerRules).sort()).toEqual(["coded", "regular"]);
    expect(state.settings.find((row) => row.key === "code_discount_node.id")?.value).toBe(JSON.stringify(CODE_NODE));
  });

  it("reaches parity for shipping: gated shipping offers with accept in the delivery config, no cart node for shipping-only", async () => {
    flagOn();
    state.offers = [makeOffer({ id: "ship" })];
    state.codeRows = [makeCode({ offerId: "ship", code: "summer10" })];
    state.rewardRows = [shippingRewardFor("ship")];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const shared = state.metafieldPushes.find((p) => p.ownerIds.includes(DELIVERY_DISCOUNT_ID));
    const config = JSON.parse(shared!.value) as {
      shippingOffers: Array<{ id: string; codeHashes: string[]; acceptCodes: boolean }>;
    };
    expect(config.shippingOffers).toEqual([
      expect.objectContaining({ id: "ship:ship-ship", codeHashes: ["9e35947c8d25"], acceptCodes: true }),
    ]);
    // Nothing for the cart-lines code Function to do, so no code node is created.
    expect(state.createdAutoNodes).toEqual([]);
    expect(state.createdCodeNodes).toEqual([]);
  });

  it("refuses a custom cart attribute condition combined with codes", async () => {
    flagOn();
    state.offers = [makeOffer({ id: "attr" })];
    state.codeRows = [makeCode({ offerId: "attr", code: "AAA" })];
    state.rewardRows = [gift("attr")];
    state.conditionRows = [
      { id: "c1", shopId: SHOP_ID, offerId: "attr", conditionType: "cart_attribute", isEnabled: true, scope: "main", operator: "eq", value: { key: "source", value: "x", matchMode: "equals" } },
    ];

    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).rejects.toThrow(/cart attribute/);
  });

  it("refuses a code set too large for the metafield", async () => {
    flagOn();
    state.offers = [makeOffer({ id: "big" })];
    state.codeRows = Array.from({ length: 900 }, (_, i) => makeCode({ offerId: "big", code: `BIGCODE${i}` }));
    state.rewardRows = [gift("big")];

    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).rejects.toThrow(/too many codes for backend B/);
  });

  it("retires the offer's old Shopify code node when the shop switches to backend B", async () => {
    flagOn();
    state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
    state.knownDiscountIds.add(NODE);
    state.codeRows = [makeCode({ offerId: "coded", code: "AAA", shopifySyncedAt: new Date() })];
    state.rewardRows = [gift("coded")];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.expiredNodes).toEqual([NODE]);
    const oldNodePush = state.metafieldPushes.find((p) => p.ownerIds.includes(NODE));
    expect(parsedConfig(oldNodePush!.value).offers).toEqual([]);
  });

  it("blanks the code node when backend B is switched off", async () => {
    state.settings = [{ shopId: SHOP_ID, key: "code_discount_node.id", value: JSON.stringify(CODE_NODE) }];
    state.knownDiscountIds.add(CODE_NODE);
    state.offers = [makeOffer({ id: "regular" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const push = state.metafieldPushes.find((p) => p.ownerIds.includes(CODE_NODE));
    expect(parsedConfig(push!.value).offers).toEqual([]);
  });
});


describe("publishOffersForShop — mixed code offers (product/order AND shipping)", () => {
  const gift = (offerId: string) => ({
    id: `gift-${offerId}`,
    shopId: SHOP_ID,
    offerId,
    rewardType: "product_gift",
    discountType: "free",
    value: {},
    target: { variantIds: ["gid://shopify/ProductVariant/9"] },
    quantity: 1,
    sortOrder: 0,
  });
  const reset = () => {
    state.offers = [makeOffer({ id: "mixed" })];
    state.shops = [makeShop()];
    state.metafieldPushes = [];
    state.knownDiscountIds = new Set([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID]);
    state.nextCodeDiscountId = NODE;
    state.codeRows = [];
    state.conditionRows = [];
    state.settings = [];
    state.createdCodeNodes = [];
    state.updatedCodeNodes = [];
    state.expiredNodes = [];
    state.addedCodes = [];
    state.removedCodes = [];
    state.nodeCodes = {};
    state.shopifyCodes = {};
    state.raceCodes = new Set();
    state.rejectCodes = new Set();
    state.rewardRows = [gift("mixed"), shippingRewardFor("mixed")];
  };
  const sharedShipping = () => {
    const push = state.metafieldPushes.find((p) => p.ownerIds.includes(DELIVERY_DISCOUNT_ID));
    return (JSON.parse(push!.value) as { shippingOffers?: Array<{ id: string; codeHashes?: string[] }> }).shippingOffers ?? [];
  };

  it("keeps the product part on the cart-lines code node and gates shipping by code hashes in the shared delivery config", async () => {
    reset();
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10" }), makeCode({ offerId: "mixed", code: "VIP-2026" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.createdCodeNodes[0]).toMatchObject({ handle: "promo-engine-discount", classes: ["PRODUCT", "ORDER"] });
    const own = state.metafieldPushes.find((p) => p.ownerIds.includes(NODE));
    const ownConfig = JSON.parse(own!.value) as { offers: Array<{ id: string }>; shippingOffers?: unknown[] };
    expect(ownConfig.offers.map((o) => o.id)).toEqual(["mixed"]);
    expect(ownConfig.shippingOffers ?? []).toEqual([]);
    expect(sharedShipping()).toEqual([
      expect.objectContaining({ id: "mixed:ship-mixed", codeHashes: ["9e35947c8d25", "e8cf18d732cc"].sort() }),
    ]);
  });

  it("drops exhausted and deactivated codes from the delivery hashes on republish", async () => {
    reset();
    state.offers = [makeOffer({ id: "mixed", codeDiscountId: NODE })];
    state.knownDiscountIds.add(NODE);
    state.nodeCodes[NODE] = ["SUMMER10", "VIP-2026", "A"];
    state.codeRows = [
      makeCode({ offerId: "mixed", code: "SUMMER10", shopifySyncedAt: new Date() }),
      makeCode({ offerId: "mixed", code: "VIP-2026", status: "disabled", shopifySyncedAt: new Date() }),
      makeCode({ offerId: "mixed", code: "A", status: "exhausted", usageLimit: 1, usageCount: 1, shopifySyncedAt: new Date() }),
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(sharedShipping()[0]!.codeHashes).toEqual(["9e35947c8d25"]);
  });

  it("publishes no shipping at all once no code is redeemable (never ungated)", async () => {
    reset();
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10", status: "disabled" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(sharedShipping()).toEqual([]);
  });

  it("uses the code-gated delivery path for a mixed legacy required code too", async () => {
    reset();
    state.offers = [makeOffer({ id: "mixed", requiredDiscountCode: "SUMMER10", codeDiscountId: NODE })];
    state.knownDiscountIds.add(NODE);

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(sharedShipping()[0]!.codeHashes).toEqual(["9e35947c8d25"]);
  });

  it("backend B gates mixed shipping in the delivery config too, with accept", async () => {
    reset();
    state.settings = [{ shopId: SHOP_ID, key: "code_backend_b.enabled", value: "true" }];
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const shipping = JSON.parse(
      state.metafieldPushes.find((p) => p.ownerIds.includes(DELIVERY_DISCOUNT_ID))!.value,
    ) as { shippingOffers: Array<{ codeHashes: string[]; acceptCodes: boolean }> };
    expect(shipping.shippingOffers[0]).toMatchObject({ codeHashes: ["9e35947c8d25"], acceptCodes: true });
    expect(state.createdAutoNodes).toEqual([{ handle: "promo-engine-code-discount", classes: ["PRODUCT", "ORDER"] }]);
  });
});

describe("publishOffersForShop — requiresCode keeps an offer from ever running ungated", () => {
  it("publishes nothing for a requiresCode offer that has no codes (e.g. a fresh duplicate)", async () => {
    state.offers = [makeOffer({ id: "dup", requiresCode: true }), makeOffer({ id: "regular" })];
    state.shops = [makeShop()];
    state.metafieldPushes = [];
    state.codeRows = [];
    state.settings = [];
    state.createdCodeNodes = [];
    state.knownDiscountIds = new Set([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID]);
    state.rewardRows = [
      {
        id: "g",
        shopId: SHOP_ID,
        offerId: "dup",
        rewardType: "product_gift",
        discountType: "free",
        value: {},
        target: { variantIds: ["gid://shopify/ProductVariant/9"] },
        quantity: 1,
        sortOrder: 0,
      },
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const shared = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
    expect(parsedConfig(shared!.value).offers.map((o) => o.id)).toEqual(["regular"]);
    expect(state.createdCodeNodes).toEqual([]);
  });
});

// Referenced only for documentation/clarity above — confirms the real title
// constant this suite's fake FindDiscountFunction response mirrors.
void CART_FUNCTION_TITLE;

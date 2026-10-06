import type * as ShopifyFetch from "../shopify-fetch.server.js";
import type * as PublishPending from "../publish-pending.server.js";
import { ShopifyOutcomeUnknownError } from "../shopify-fetch.server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import type * as DrizzleOrm from "drizzle-orm";
import type * as PromoDb from "@promo/db";
import type * as CartValidation from "../cart-validation.server.js";
import { CART_FUNCTION_TITLE, MAX_CODED_SHIPPING_NODES, ensureCodedShippingNodes } from "../discount-node.server.js";
import {
  neutralizeCodeDiscountNode,
  FUNCTION_CONFIG_NAMESPACES,
  packCodedShippingOffers,
  publishOffersForShop,
  specificLinkParamNames,
} from "./offer-publisher.server.js";

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
  codeRedemption?: "checkout_code" | "automatic";
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
  publishPendingAt?: Date | null;
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
  shopifySyncPendingAt: Date | null;
  shopifyReaddAttemptedAt?: Date | null;
  syncNote?: string | null;
}

interface MetafieldPush {
  ownerIds: string[];
  namespaces: string[];
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
    updatedAutomaticNodes: [] as Array<{ id: string; input: Record<string, unknown> }>,
    expiredNodes: [] as string[],
    deletedNodes: [] as string[],
    addedCodes: [] as Array<{ discountId: string; codes: string[] }>,
    removedCodes: [] as Array<{ discountId: string; ids: string[] }>,
    deletedAutoNodes: [] as string[],
    shopMetafieldPushes: [] as Array<{ ownerId: string; namespace: string; key: string; value: string }>,
    nodeCodes: {} as Record<string, string[]>,
    preflightLookups: 0,
    mutations: [] as Array<{ name: string; retryable: boolean }>,
    failNextLocks: 0,
    lockAttempts: 0,
    /** Shop-wide active automatic discount count reported to the pool's limit check. */
    automaticDiscountCount: 0,
    /** currentAppInstallation answers with an access error (the app lacks the scope). */
    appInstallationError: null as string | null,
    /** A metafield write whose owner id contains this text fails (a non-retryable user error). */
    failMetafieldsFor: null as string | null,
    failNextShopifyCall: null as Error | null,
    onAdd: null as null | (() => void),
    pendingAtAddTime: null as Date | null,
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
      transaction: async (cb: (tx: { execute: () => Promise<void> }) => Promise<void>) => {
        let call = 0;
        return cb({
          execute: async () => {
            call += 1;
            // 1st call is `set local lock_timeout`, 2nd takes the advisory lock.
            if (call === 2) {
              state.lockAttempts += 1;
              if (state.failNextLocks > 0) {
                state.failNextLocks -= 1;
                throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
              }
            }
          },
        });
      },
    };
  }

  const shopifyGraphQLMock = async ({
    query,
    variables,
    retryable,
  }: {
    query: string;
    variables?: Record<string, unknown>;
    retryable?: boolean;
  }): Promise<unknown> => {
    if (state.failNextShopifyCall) {
      const error = state.failNextShopifyCall;
      state.failNextShopifyCall = null;
      throw error;
    }
    if (/^\s*mutation/.test(query)) {
      state.mutations.push({ name: /mutation (\w+)/.exec(query)![1]!, retryable: retryable === true });
    }
    if (query.includes("PromoEngineCodeLookup")) {
      state.preflightLookups += 1;
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
    if (query.includes("PromoEngineCodeOwners")) {
      const ownCodes = state.nodeCodes;
      const result: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(variables!)) {
        const code = value as string;
        const ownerId = Object.keys(ownCodes).find((id) => ownCodes[id]!.includes(code));
        const held = state.shopifyCodes[code];
        result[`c${name.slice(1)}`] = ownerId ? { id: ownerId } : held ? { id: held.id } : null;
      }
      return result;
    }
    if (query.includes("FindExistingCodeDiscount")) {
      const code = variables!.code as string;
      const ownerId = Object.keys(state.nodeCodes).find((id) => state.nodeCodes[id]!.includes(code));
      return {
        codeDiscountNodeByCode: ownerId
          ? { id: ownerId, codeDiscount: { __typename: "DiscountCodeApp", appDiscountType: { functionId: "gid://shopify/ShopifyFunction/cart" } } }
          : null,
      };
    }
    if (query.includes("PromoEngineNodesExist")) {
      return {
        nodes: (variables!.ids as string[]).map((id) => {
          if (!state.knownDiscountIds.has(id)) return null;
          const slot = /\/pool-(\d+)$/.exec(id)?.[1];
          return slot ? { id, automaticDiscount: { title: `Promo Engine Coded Shipping ${slot}` } } : { id };
        }),
      };
    }
    if (query.includes("PromoEngineAutomaticDiscountCount")) {
      return { discountNodesCount: { count: state.automaticDiscountCount } };
    }
    if (query.includes("DeletePromoEngineAutomaticDiscount")) {
      state.deletedAutoNodes.push(variables!.id as string);
      state.knownDiscountIds.delete(variables!.id as string);
      return { discountAutomaticDelete: { deletedAutomaticDiscountId: variables!.id, userErrors: [] } };
    }
    if (query.includes("PromoEngineAppInstallation") && state.appInstallationError) {
      throw new Error(state.appInstallationError);
    }
    if (query.includes("PromoEngineAppInstallation")) return { currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } };
    if (query.includes("PromoEngineSpecificLinkParams")) {
      for (const m of variables!.metafields as Array<{ ownerId: string; namespace: string; key: string; value: string }>) {
        state.shopMetafieldPushes.push(m);
      }
      return { metafieldsSet: { metafields: [], userErrors: [] } };
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
      const discount = variables!.discount as { functionHandle: string; discountClasses: string[]; title: string };
      state.createdAutoNodes.push({ handle: discount.functionHandle, classes: discount.discountClasses });
      const poolSlot = /^Promo Engine Coded Shipping (\d+)$/.exec(discount.title)?.[1];
      const createdId = poolSlot ? `gid://shopify/DiscountAutomaticNode/pool-${poolSlot}` : state.nextAutoNodeId;
      state.knownDiscountIds.add(createdId);
      return {
        discountAutomaticAppCreate: {
          automaticAppDiscount: { discountId: createdId },
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
      state.onAdd?.();
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
      state.updatedAutomaticNodes.push({ id: variables!.id as string, input: variables!.discount as Record<string, unknown> });
      return {
        discountAutomaticAppUpdate: {
          automaticAppDiscount: { discountId: variables!.id },
          userErrors: [],
        },
      };
    }
    if (query.includes("MetafieldsSet")) {
      const metafields = variables!.metafields as Array<{ ownerId: string; namespace: string; value: string }>;
      if (state.failMetafieldsFor && metafields.some((m) => m.ownerId.includes(state.failMetafieldsFor!))) {
        return { metafieldsSet: { metafields: [], userErrors: [{ message: "Shopify says no" }] } };
      }
      state.metafieldPushes.push({
        ownerIds: [...new Set(metafields.map((m) => m.ownerId))],
        namespaces: [...new Set(metafields.map((m) => m.namespace))],
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

vi.mock("../shopify-fetch.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ShopifyFetch>()),
  shopifyGraphQL: shopifyGraphQLMock,
}));

vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));

// The real retry sleeps for seconds and would republish into a later test's state.
const scheduleRetry = vi.fn(async () => undefined);
vi.mock("../publish-pending.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PublishPending>()),
  scheduleBackgroundPublishRetry: (...args: unknown[]) => scheduleRetry(...(args as [])),
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
    state.updatedAutomaticNodes = [];
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

  it("leaves a scheduled offer out of the compiled config until it goes active", async () => {
    state.offers = [makeOffer({ id: "live-1" }), makeOffer({ id: "later-1", status: "scheduled" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const sharedPush = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
    expect(parsedConfig(sharedPush!.value).offers.map((o) => o.id)).toEqual(["live-1"]);
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
    const ruleVariants = Object.values(cartValidationCalls[0]!.offerRules).flatMap((rule) =>
      Object.values(rule.rewards).flatMap((reward) => reward.variantIds),
    );
    expect([...new Set(ruleVariants)].sort()).toEqual(
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
    shopifySyncPendingAt: null,
    ...overrides,
  };
}

const NODE = "gid://shopify/DiscountCodeNode/own";

type PushedShipping = { id: string; codeHashes?: string[]; acceptCodes?: boolean };
const shippingOffersOf = (value: string) =>
  (JSON.parse(value) as { shippingOffers?: PushedShipping[] }).shippingOffers ?? [];
/** Shipping offers pushed to the coded-shipping pool nodes. */
const poolPushes = () => state.metafieldPushes.filter((p) => p.ownerIds.some((id) => id.includes("/pool-")));
const poolShipping = () => poolPushes().flatMap((p) => shippingOffersOf(p.value));
/** Shipping offers in the shared automatic delivery node's config (must never hold code hashes). */
const sharedShippingOffers = () => {
  const push = state.metafieldPushes.find((p) => p.ownerIds.includes(DELIVERY_DISCOUNT_ID));
  return push ? shippingOffersOf(push.value) : [];
};

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
      // Generated codes skip the pre-flight; Shopify rejects this one when it is added.
      state.raceCodes = new Set(["AMZ-222222"]);

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      const codes = state.codeRows.map((r) => r.code);
      expect(codes).toContain("AMZ-111111");
      expect(codes).not.toContain("AMZ-222222");
      expect(codes.every((code) => /^AMZ-\d{6}$/.test(code))).toBe(true);
      // Generated codes are not "requested" by anyone, so no notice is raised.
      expect(state.codeRows.every((r) => !r.requestedCode)).toBe(true);
      expect(new Set(codes).size).toBe(2);
    });

    it("skips the Shopify pre-flight for generated codes but keeps it for typed ones", async () => {
      state.offers = [makeOffer({ id: "coded" })];
      state.batchRows = [{ id: "batch-1", shopId: SHOP_ID, prefix: "AMZ-", length: 6, charset: "numbers" }];
      state.codeRows = [
        makeCode({ offerId: "coded", code: "AMZ-111111", batchId: "batch-1" }),
        makeCode({ offerId: "coded", code: "AMZ-222222", batchId: "batch-1" }),
      ];
      state.preflightLookups = 0;
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      expect(state.preflightLookups).toBe(0);

      state.offers = [makeOffer({ id: "typed" })];
      state.codeRows = [makeCode({ offerId: "typed", code: "TYPED1" })];
      state.knownDiscountIds = new Set([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID]);
      state.nodeCodes = {};
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      expect(state.preflightLookups).toBeGreaterThan(0);
    });

    it("looks up a generated code left in flight by a crashed publish instead of trusting it is absent", async () => {
      state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.batchRows = [{ id: "batch-1", shopId: SHOP_ID, prefix: "AMZ-", length: 6, charset: "numbers" }];
      state.nodeCodes[NODE] = ["FIRST", "AMZ-333333"];
      state.codeRows = [
        makeCode({ offerId: "coded", code: "FIRST", shopifySyncedAt: new Date() }),
        // The bulk add landed on Shopify but the process died before the row was marked synced.
        makeCode({ offerId: "coded", code: "AMZ-333333", batchId: "batch-1", shopifySyncPendingAt: new Date() }),
      ];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      const row = state.codeRows.find((r) => r.code === "AMZ-333333")!;
      expect(row.shopifySyncedAt).toBeTruthy();
      expect(row.shopifySyncPendingAt).toBeNull();
      expect(state.addedCodes).toEqual([]);
    });

    it("flags codes as in flight before sending them and clears the flag once Shopify has them", async () => {
      state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.nodeCodes[NODE] = ["FIRST"];
      state.codeRows = [
        makeCode({ offerId: "coded", code: "FIRST", shopifySyncedAt: new Date() }),
        makeCode({ offerId: "coded", code: "NEW1" }),
      ];
      state.onAdd = () => {
        const row = state.codeRows.find((r) => r.code === "NEW1")!;
        state.pendingAtAddTime = row.shopifySyncPendingAt;
      };

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.pendingAtAddTime).toBeTruthy();
      expect(state.codeRows.find((r) => r.code === "NEW1")?.shopifySyncPendingAt).toBeNull();
      state.onAdd = null;
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

  describe("automatic redemption mode", () => {
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
    const mainCondition = (offerId: string) => ({
      id: `cond-${offerId}`,
      shopId: SHOP_ID,
      offerId,
      scope: "main",
      conditionType: "cart_value",
      operator: "gte",
      value: { thresholdCents: 1000, currencyCode: "USD" },
      sortOrder: 0,
      isEnabled: true,
    });

    it("puts an automatic offer with codes in the shared config and creates no code node", async () => {
      state.offers = [makeOffer({ id: "auto", requiresCode: true, codeRedemption: "automatic" }), makeOffer({ id: "regular" })];
      state.codeRows = [makeCode({ offerId: "auto", code: "AAA" })];
      state.rewardRows = [gift("auto", 1), gift("regular", 2)];
      state.conditionRows = [mainCondition("auto")];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      const shared = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
      expect(parsedConfig(shared!.value).offers.map((o) => o.id).sort()).toEqual(["auto", "regular"]);
      expect(state.createdCodeNodes).toEqual([]);
      expect(state.addedCodes).toEqual([]);
    });

    it("neutralizes the offer's existing code node but keeps its codes and node id", async () => {
      state.offers = [makeOffer({ id: "coded", requiresCode: true, codeDiscountId: NODE, codeRedemption: "automatic" })];
      state.knownDiscountIds.add(NODE);
      state.nodeCodes[NODE] = ["AAA"];
      state.codeRows = [makeCode({ offerId: "coded", code: "AAA", shopifySyncedAt: new Date() })];
      state.rewardRows = [gift("coded", 1)];
      state.conditionRows = [mainCondition("coded")];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.expiredNodes).toEqual([NODE]);
      expect(state.removedCodes).toEqual([]);
      expect(state.deletedNodes).toEqual([]);
      expect(state.codeRows).toHaveLength(1);
      expect(state.codeRows[0]!.status).toBe("active");
      expect(state.offers[0]!.codeDiscountId).toBe(NODE);
      const own = state.metafieldPushes.find((p) => p.ownerIds.includes(NODE));
      expect(parsedConfig(own!.value).offers).toEqual([]);
    });

    it("round trip: switching back to checkout_code reopens the same node (endsAt null) and leaves the shared config", async () => {
      state.offers = [makeOffer({ id: "coded", requiresCode: true, codeDiscountId: NODE, codeRedemption: "automatic" })];
      state.knownDiscountIds.add(NODE);
      state.nodeCodes[NODE] = ["AAA"];
      state.codeRows = [makeCode({ offerId: "coded", code: "AAA", shopifySyncedAt: new Date() })];
      state.rewardRows = [gift("coded", 1)];
      state.conditionRows = [mainCondition("coded")];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      expect(state.expiredNodes).toEqual([NODE]);

      state.offers[0]!.codeRedemption = "checkout_code";
      state.metafieldPushes = [];
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.createdCodeNodes).toEqual([]);
      expect(state.updatedCodeNodes.some((u) => u.id === NODE && u.input["endsAt"] === null)).toBe(true);
      expect(state.offers[0]!.codeDiscountId).toBe(NODE);
      const own = state.metafieldPushes.find((p) => p.ownerIds.includes(NODE));
      expect(parsedConfig(own!.value).offers.map((o) => o.id)).toEqual(["coded"]);
      const shared = state.metafieldPushes.find((p) => p.ownerIds.includes(CART_DISCOUNT_ID));
      expect(parsedConfig(shared!.value).offers).toEqual([]);
    });
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

  describe("purchase-type flags (Skio / selling-plan lines)", () => {
    const orderReward = (offerId: string, subscriptionMode?: string) => ({
      id: `order-${offerId}`,
      shopId: SHOP_ID,
      offerId,
      rewardType: "order_discount",
      discountType: "percentage",
      value: { amount: 20, currencyCode: "USD" },
      target: { scope: "cart", ...(subscriptionMode ? { subscriptionMode } : {}) },
      quantity: null,
      sortOrder: 0,
    });
    const BOTH = { appliesOnSubscription: true, appliesOnOneTimePurchase: true };

    it("sends both flags on every create and update of the shared nodes and a code node", async () => {
      state.offers = [makeOffer({ id: "regular" }), makeOffer({ id: "coded" })];
      state.codeRows = [makeCode({ offerId: "coded", code: "AAA" })];
      state.updatedAutomaticNodes = [];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.createdCodeNodes[0]!.input).toMatchObject(BOTH);
      expect(state.updatedCodeNodes.at(-1)!.input).toMatchObject(BOTH);
      const shared = state.updatedAutomaticNodes.filter((update) => [CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID].includes(update.id));
      expect([...new Set(shared.map((update) => update.id))].sort()).toEqual([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID].sort());
      for (const update of shared) expect(update.input).toMatchObject(BOTH);
    });

    it("re-sends the flags on the next publish so an existing node created with the old default is corrected", async () => {
      state.offers = [makeOffer({ id: "regular" })];
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      state.updatedAutomaticNodes = [];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.updatedAutomaticNodes.length).toBeGreaterThan(0);
      for (const update of state.updatedAutomaticNodes) expect(update.input).toMatchObject(BOTH);
    });

    it("turns subscriptions off on a code node whose discount is one-time only, and on again when it is not", async () => {
      state.offers = [makeOffer({ id: "coded", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.codeRows = [makeCode({ offerId: "coded", code: "ONE", shopifySyncedAt: new Date() })];
      state.rewardRows = [orderReward("coded", "one_time_only")];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      expect(state.updatedCodeNodes.at(-1)!.input).toMatchObject({ appliesOnSubscription: false, appliesOnOneTimePurchase: true });

      state.rewardRows = [orderReward("coded", "subscription_only")];
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      expect(state.updatedCodeNodes.at(-1)!.input).toMatchObject({ appliesOnSubscription: true, appliesOnOneTimePurchase: false });

      state.rewardRows = [orderReward("coded")];
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      expect(state.updatedCodeNodes.at(-1)!.input).toMatchObject(BOTH);
    });
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

    expect(poolShipping()).toEqual([
      expect.objectContaining({ id: "ship:ship-ship", codeHashes: ["9e35947c8d25"], acceptCodes: true }),
    ]);
    expect(sharedShippingOffers()).toEqual([]);
    // Nothing for the cart-lines code Function to do, so no code node is created; the only new
    // automatic node is the coded-shipping pool node.
    expect(state.createdAutoNodes).toEqual([{ handle: "promo-engine-delivery-discount", classes: ["SHIPPING"] }]);
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
    state.createdAutoNodes = [];
    state.deletedAutoNodes = [];
    state.shopMetafieldPushes = [];
    state.mutations = [];
    state.failNextLocks = 0;
    state.lockAttempts = 0;
    state.automaticDiscountCount = 0;
    state.failMetafieldsFor = null;
    state.appInstallationError = null;
  };
  const sharedShipping = poolShipping;

  it("keeps the product part on the cart-lines code node and gates shipping by code hashes on a dedicated delivery node, not the shared delivery config", async () => {
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
    // The hashes left the shared config: it carries no code-gated shipping at all.
    expect(sharedShippingOffers()).toEqual([]);
    expect(state.createdAutoNodes).toEqual([{ handle: "promo-engine-delivery-discount", classes: ["SHIPPING"] }]);
    expect(state.settings.find((row) => row.key === "coded_shipping_pool.ids")?.value).toBe(
      JSON.stringify(["gid://shopify/DiscountAutomaticNode/pool-1"]),
    );
  });

  it("publishes a code set far beyond the old shop-wide limit: the hashes spread over several pool nodes and the shared config stays tiny", async () => {
    reset();
    state.codeRows = Array.from({ length: 1500 }, (_, i) =>
      makeCode({ offerId: "mixed", code: `GEN${String(i).padStart(5, "0")}` }),
    );

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const pushes = poolPushes();
    expect(pushes.length).toBeGreaterThan(1);
    for (const push of pushes) expect(new TextEncoder().encode(push.value).byteLength).toBeLessThanOrEqual(9500);
    const hashes = poolShipping().flatMap((offer) => offer.codeHashes ?? []);
    expect(hashes).toHaveLength(1500);
    expect(new Set(hashes).size).toBe(1500);
    expect(sharedShippingOffers()).toEqual([]);
    expect(state.codeRows.every((row) => row.shopifySyncedAt)).toBe(true);
  });

  it("shrinks the pool: nodes that are no longer needed are deleted and forgotten", async () => {
    reset();
    state.codeRows = Array.from({ length: 1500 }, (_, i) =>
      makeCode({ offerId: "mixed", code: `GEN${String(i).padStart(5, "0")}` }),
    );
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    const before = JSON.parse(state.settings.find((row) => row.key === "coded_shipping_pool.ids")!.value) as string[];
    expect(before.length).toBeGreaterThan(1);

    // Everything but one code is deactivated.
    state.codeRows = state.codeRows.map((row, i) => (i === 0 ? row : { ...row, status: "disabled" }));
    state.metafieldPushes = [];
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const after = JSON.parse(state.settings.find((row) => row.key === "coded_shipping_pool.ids")!.value) as string[];
    expect(after).toEqual([before[0]]);
    expect(state.deletedAutoNodes.sort()).toEqual(before.slice(1).sort());
    expect(poolShipping()[0]!.codeHashes).toHaveLength(1);
  });

  it("recreates a pool node the merchant deleted in Shopify", async () => {
    reset();
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10" })];
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    state.knownDiscountIds.delete("gid://shopify/DiscountAutomaticNode/pool-1");
    state.createdAutoNodes = [];
    state.metafieldPushes = [];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.createdAutoNodes).toEqual([{ handle: "promo-engine-delivery-discount", classes: ["SHIPPING"] }]);
    expect(poolShipping()).toHaveLength(1);
  });

  it("writes every function_config (shared, code and pool nodes) to both namespaces, which is what the Functions' input variables read", async () => {
    reset();
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10" })];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const owners = new Set(state.metafieldPushes.flatMap((push) => push.ownerIds));
    expect(owners.size).toBeGreaterThanOrEqual(4);
    for (const push of state.metafieldPushes) {
      expect(push.namespaces.slice().sort()).toEqual(["$app:promo_engine", "promo_engine"]);
    }
  });

  it("refreshes the specific-link params on every publish (drift repair republishes), and a missing scope neither fails the publish nor pages", async () => {
    reset();
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    expect(state.shopMetafieldPushes).toHaveLength(1);
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    expect(state.shopMetafieldPushes).toHaveLength(2);

    state.appInstallationError = "Access denied for currentAppInstallation field. Required access: write_app_data";
    vi.mocked(Sentry.captureException).mockClear();
    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).resolves.toBe("published");
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Specific-link params not written: the app lacks access",
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("keeps publishing when the pool push fails: the offer is flagged with a message, the manifest is still written, nothing is paused", async () => {
    reset();
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10" })];
    state.failMetafieldsFor = "/pool-";

    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).resolves.toBe("published");

    // The code offer's own node and codes still went live.
    expect(state.metafieldPushes.some((p) => p.ownerIds.includes(NODE))).toBe(true);
    expect(state.codeRows.every((row) => row.shopifySyncedAt)).toBe(true);
    expect(state.offers.find((o) => o.id === "mixed")!.status).toBe("active");
    expect(state.settings.find((row) => row.key === "publish_manifest.v1")).toBeTruthy();
    const errors = JSON.parse(state.settings.find((row) => row.key === "offer_publish_errors.v1")!.value) as Record<string, string>;
    expect(errors.mixed).toMatch(/Free shipping with this offer's codes could not be published/);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Coded shipping pool could not be published",
      expect.objectContaining({ level: "error" }),
    );

    // Healthy again: the next publish clears the flag.
    state.failMetafieldsFor = null;
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    expect(JSON.parse(state.settings.find((row) => row.key === "offer_publish_errors.v1")!.value)).toEqual({});
  });

  it("fails only the code offer that needs new pool nodes when the shop is at Shopify's 25 automatic discounts, before creating any", async () => {
    reset();
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10" })];
    state.automaticDiscountCount = 25;

    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).resolves.toBe("published");

    expect(state.createdAutoNodes).toEqual([]);
    const errors = JSON.parse(state.settings.find((row) => row.key === "offer_publish_errors.v1")!.value) as Record<string, string>;
    expect(errors.mixed).toMatch(/already has 25 active and Shopify allows 25/);
    expect(state.metafieldPushes.some((p) => p.ownerIds.includes(NODE))).toBe(true);
  });

  it("allocates slot titles from the nodes that exist: a deleted middle node never makes a new one collide with a live title", async () => {
    reset();
    state.codeRows = Array.from({ length: 1500 }, (_, i) =>
      makeCode({ offerId: "mixed", code: `GEN${String(i).padStart(5, "0")}` }),
    );
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    const before = JSON.parse(state.settings.find((row) => row.key === "coded_shipping_pool.ids")!.value) as string[];
    expect(before.length).toBeGreaterThanOrEqual(3);

    state.knownDiscountIds.delete(before[1]!);
    state.createdAutoNodes = [];
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const after = JSON.parse(state.settings.find((row) => row.key === "coded_shipping_pool.ids")!.value) as string[];
    expect(after).toHaveLength(before.length);
    expect(new Set(after).size).toBe(after.length);
    expect(state.createdAutoNodes).toHaveLength(1);
    expect(after).toContain(before[1]);
  });

  it("refuses to use more automatic delivery nodes than Shopify's limit leaves room for, before creating any", async () => {
    reset();
    await expect(ensureCodedShippingNodes(SHOP_ID, SHOP_DOMAIN, "token", MAX_CODED_SHIPPING_NODES + 1)).rejects.toThrow(
      /more than the 12 this app may use/,
    );
    expect(state.createdAutoNodes).toEqual([]);
  });

  it("creates each pool node once: a retried publish reuses the persisted ids", async () => {
    reset();
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10" })];
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    expect(state.createdAutoNodes).toEqual([{ handle: "promo-engine-delivery-discount", classes: ["SHIPPING"] }]);
  });

  it("removes every pool node once no mixed offer needs code-gated shipping", async () => {
    reset();
    state.codeRows = [makeCode({ offerId: "mixed", code: "SUMMER10" })];
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    state.codeRows = state.codeRows.map((row) => ({ ...row, status: "disabled" }));
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    expect(state.deletedAutoNodes).toEqual(["gid://shopify/DiscountAutomaticNode/pool-1"]);
    expect(state.settings.find((row) => row.key === "coded_shipping_pool.ids")?.value).toBe("[]");
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

  describe("codes queued for a re-add after being deleted in the Shopify admin", () => {
    const setup = () => {
      reset();
      state.offers = [makeOffer({ id: "mixed", codeDiscountId: NODE })];
      state.knownDiscountIds.add(NODE);
      state.nodeCodes[NODE] = ["KEEP1"];
    };
    const queued = (code: string) =>
      makeCode({ offerId: "mixed", code, shopifyReaddAttemptedAt: new Date(), shopifySyncedAt: null });

    it("adds the code back once, and clears the re-add flag", async () => {
      setup();
      state.codeRows = [makeCode({ offerId: "mixed", code: "KEEP1", shopifySyncedAt: new Date() }), queued("GONE1")];

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      expect(state.nodeCodes[NODE]).toContain("GONE1");
      const row = state.codeRows.find((r) => r.code === "GONE1")!;
      expect(row.shopifySyncedAt).toBeTruthy();
      expect(row.shopifyReaddAttemptedAt).toBeNull();
      expect(row.status).toBe("active");
    });

    it("disables a code that another discount took meanwhile, with a note, instead of renaming it", async () => {
      setup();
      state.codeRows = [makeCode({ offerId: "mixed", code: "KEEP1", shopifySyncedAt: new Date() }), queued("GONE1")];
      state.shopifyCodes.GONE1 = { id: "gid://shopify/DiscountCodeNode/theirs", title: "Their sale" };

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

      const row = state.codeRows.find((r) => r.code === "GONE1")!;
      expect(row).toMatchObject({ status: "disabled", shopifySyncedAt: null, shopifyReaddAttemptedAt: null });
      expect(row.syncNote).toMatch(/deleted from the Shopify discount/);
      expect(state.codeRows.map((r) => r.code).sort()).toEqual(["GONE1", "KEEP1"]);
      expect(state.nodeCodes[NODE]).not.toContain("GONE1");
    });

    it("disables a code Shopify rejects on the re-add, and never retries it", async () => {
      setup();
      state.codeRows = [makeCode({ offerId: "mixed", code: "KEEP1", shopifySyncedAt: new Date() }), queued("GONE1")];
      state.rejectCodes.add("GONE1");

      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      const row = state.codeRows.find((r) => r.code === "GONE1")!;
      expect(row).toMatchObject({ status: "disabled", shopifySyncedAt: null });
      expect(row.syncNote).toBeTruthy();

      state.addedCodes = [];
      await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
      expect(state.addedCodes.flatMap((entry) => entry.codes)).not.toContain("GONE1");
    });
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

    expect(poolShipping()[0]).toMatchObject({ codeHashes: ["9e35947c8d25"], acceptCodes: true });
    expect(sharedShippingOffers()).toEqual([]);
    expect(state.createdAutoNodes).toEqual(
      expect.arrayContaining([{ handle: "promo-engine-code-discount", classes: ["PRODUCT", "ORDER"] }]),
    );
  });
});

describe("publishOffersForShop — lock timeouts, retries, manifest and shop metafield", () => {
  const reset = () => {
    state.offers = [makeOffer({ id: "regular-1" })];
    state.shops = [makeShop()];
    state.metafieldPushes = [];
    state.knownDiscountIds = new Set([CART_DISCOUNT_ID, DELIVERY_DISCOUNT_ID]);
    state.codeRows = [];
    state.conditionRows = [];
    state.settings = [];
    state.rewardRows = [];
    state.mutations = [];
    state.shopMetafieldPushes = [];
    state.failNextLocks = 0;
    state.lockAttempts = 0;
    state.failNextShopifyCall = null;
    state.createdAutoNodes = [];
    state.createdCodeNodes = [];
    cartValidationCalls.length = 0;
  };

  it("parks the shop as publish-pending on a lock timeout, resolves instead of throwing, and never touches the offers", async () => {
    reset();
    state.failNextLocks = 1;

    scheduleRetry.mockClear();

    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).resolves.toBe("pending");

    expect(state.shops[0]).toMatchObject({ publishPendingAt: expect.any(Date) as unknown as Date });
    expect(state.offers.map((o) => o.status)).toEqual(["active"]);
    expect(state.metafieldPushes).toEqual([]);
    // A background retry is scheduled; the cron is only the backstop.
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
  });

  it("does not stack retries: a background attempt that times out again leaves the schedule to the cron", async () => {
    reset();
    scheduleRetry.mockClear();
    state.failNextLocks = 1;

    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN, { background: true })).resolves.toBe("pending");

    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it("clears the pending flag when a later publish gets the lock", async () => {
    reset();
    state.failNextLocks = 1;
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    expect(state.shops[0]).toMatchObject({ publishPendingAt: expect.any(Date) as unknown as Date });

    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN, { background: true })).resolves.toBe("published");

    expect(state.shops[0]!.publishPendingAt).toBeNull();
  });

  it("parks the shop (instead of failing the offer) when a Shopify call times out with an unknown outcome", async () => {
    reset();
    state.failNextShopifyCall = new ShopifyOutcomeUnknownError("The operation was aborted due to timeout");

    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).resolves.toBe("pending");

    expect(state.shops[0]).toMatchObject({ publishPendingAt: expect.any(Date) as unknown as Date });
    expect(state.offers.map((o) => o.status)).toEqual(["active"]);
  });

  it("rethrows an error that is not a lock timeout", async () => {
    reset();
    state.shops = [];
    await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).rejects.toThrow(/active shop identity/);
  });

  it("pushes metafields with retryable (idempotent) and sends creates without blind retries", async () => {
    reset();
    state.offers = [makeOffer({ id: "coded" })];
    state.codeRows = [makeCode({ offerId: "coded", code: "AAA" })];
    state.nextCodeDiscountId = NODE;
    state.rewardRows = [
      {
        id: "g",
        shopId: SHOP_ID,
        offerId: "coded",
        rewardType: "product_gift",
        discountType: "free",
        value: {},
        target: { variantIds: ["gid://shopify/ProductVariant/9"] },
        quantity: 1,
        sortOrder: 0,
      },
    ];

    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const byName = (name: string) => state.mutations.filter((m) => m.name === name);
    expect(byName("MetafieldsSet").length).toBeGreaterThan(0);
    expect(byName("MetafieldsSet").every((m) => m.retryable)).toBe(true);
    expect(byName("UpdatePromoEngineCodeDiscountCombination").every((m) => m.retryable)).toBe(true);
    expect(byName("CreatePromoEngineCodeDiscount")).toEqual([{ name: "CreatePromoEngineCodeDiscount", retryable: false }]);
  });

  it("records what it pushed, per node, so drift can be detected later", async () => {
    reset();
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);

    const manifest = JSON.parse(state.settings.find((row) => row.key === "publish_manifest.v1")!.value) as {
      nodes: Record<string, { kind: string; hash: string; active: boolean }>;
      validationHash?: string;
    };
    expect(manifest.nodes[CART_DISCOUNT_ID]).toMatchObject({ kind: "cart", active: true });
    expect(manifest.nodes[DELIVERY_DISCOUNT_ID]).toMatchObject({ kind: "delivery", active: true });
    expect(manifest.nodes[CART_DISCOUNT_ID]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.validationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes the Function config to the legacy and the app-reserved namespace (rollout works in either deploy order)", async () => {
    reset();
    state.offers = [makeOffer({ id: "regular-1" })];
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    expect(FUNCTION_CONFIG_NAMESPACES).toEqual(["promo_engine", "$app:promo_engine"]);
    const pushes = state.metafieldPushes.filter((p) => p.ownerIds.length > 0);
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes) expect(push.namespaces).toEqual(["promo_engine", "$app:promo_engine"]);
  });

  it("publishes the specific-link param names as an app-installation metafield the theme can read (default freegifts_code)", async () => {
    reset();
    await publishOffersForShop(SHOP_ID, SHOP_DOMAIN);
    expect(state.shopMetafieldPushes).toEqual([
      {
        ownerId: "gid://shopify/AppInstallation/1",
        namespace: "promo_engine",
        key: "specific_link_params",
        type: "json",
        value: JSON.stringify(["freegifts_code"]),
      },
    ]);
  });

  it("a failure to write the shop metafield never fails the publish", async () => {
    reset();
    const original = state.shopMetafieldPushes;
    Object.defineProperty(state, "shopMetafieldPushes", {
      configurable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    try {
      await expect(publishOffersForShop(SHOP_ID, SHOP_DOMAIN)).resolves.toBe("published");
    } finally {
      Object.defineProperty(state, "shopMetafieldPushes", { configurable: true, writable: true, value: original });
    }
  });
});

describe("specificLinkParamNames", () => {
  const row = (value: unknown, overrides: Record<string, unknown> = {}) =>
    ({
      id: "c",
      offerId: "o",
      shopId: SHOP_ID,
      conditionType: "specific_link",
      isEnabled: true,
      scope: "main",
      operator: "eq",
      value,
      ...overrides,
    }) as never;

  it("defaults to freegifts_code when no condition names a param", () => {
    expect(specificLinkParamNames([])).toEqual(["freegifts_code"]);
  });

  it("lists the distinct param names of enabled specific_link conditions, sorted", () => {
    expect(
      specificLinkParamNames([
        row({ paramName: "vip" }),
        row({ paramName: "alpha" }),
        row({ paramName: "vip" }),
        row({ paramName: "ignored" }, { isEnabled: false }),
        row({ paramName: "other-type" }, { conditionType: "cart_value" }),
        row({ paramName: "quantity-scope" }, { scope: "quantity_limit" }),
      ]),
    ).toEqual(["alpha", "vip"]);
  });

  it("adds the default when a condition has no param name of its own", () => {
    expect(specificLinkParamNames([row({ paramName: "vip" }), row({ requiredUrl: "/x" })])).toEqual([
      "freegifts_code",
      "vip",
    ]);
  });
});

describe("packCodedShippingOffers", () => {
  const entry = (id: string, count: number) =>
    ({
      id,
      priority: 1,
      tiers: [],
      targetGroupTypes: ["ONE_TIME_PURCHASE"],
      scopeMode: "sitewide",
      requiredAnchorVariantIds: [],
      requiredAnchorMinQuantity: 1,
      requiresAnchorSubscription: false,
      codeHashes: Array.from({ length: count }, (_, i) => `${id[0]}${i.toString(16).padStart(11, "0")}`),
    }) as never as Parameters<typeof packCodedShippingOffers>[0][number];

  it("keeps several small offers together in one node", () => {
    expect(packCodedShippingOffers([entry("b", 3), entry("a", 3)])).toHaveLength(1);
  });

  it("is deterministic regardless of input order", () => {
    const one = packCodedShippingOffers([entry("b", 400), entry("a", 400)], 6000);
    const two = packCodedShippingOffers([entry("a", 400), entry("b", 400)], 6000);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it("splits one oversized offer by hash and loses none", () => {
    const groups = packCodedShippingOffers([entry("big", 2000)], 9500);
    expect(groups.length).toBeGreaterThan(1);
    const hashes = groups.flat().flatMap((offer) => offer.codeHashes ?? []);
    expect(hashes).toHaveLength(2000);
    expect(new Set(hashes).size).toBe(2000);
  });

  it("returns nothing for nothing", () => {
    expect(packCodedShippingOffers([])).toEqual([]);
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DrizzleOrm from "drizzle-orm";
import type * as PromoDb from "@promo/db";
import type * as CartValidation from "../cart-validation.server.js";
import { CART_FUNCTION_TITLE } from "../discount-node.server.js";
import { publishOffersForShop } from "./offer-publisher.server.js";

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
  function isRewardsTable(table: unknown): boolean {
    return Boolean(table) && typeof table === "object" && "rewardType" in (table as object);
  }

  function rowsFor(table: unknown): Array<Record<string, unknown>> {
    if (isOffersTable(table)) return state.offers as unknown as Array<Record<string, unknown>>;
    if (isShopsTable(table)) return state.shops as unknown as Array<Record<string, unknown>>;
    if (isRewardsTable(table)) return state.rewardRows as unknown as Array<Record<string, unknown>>;
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
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            if (isOffersTable(table)) {
              state.offers = state.offers.map((row) =>
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
          ],
        },
      };
    }
    if (query.includes("CreatePromoEngineCodeDiscount")) {
      const discountId = state.nextCodeDiscountId;
      return {
        discountCodeAppCreate: {
          codeAppDiscount: discountId ? { discountId } : null,
          userErrors: discountId ? [] : [{ field: null, message: "No discount id configured for test" }],
        },
      };
    }
    if (query.includes("UpdatePromoEngineCodeDiscountCombination")) {
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

// Referenced only for documentation/clarity above — confirms the real title
// constant this suite's fake FindDiscountFunction response mirrors.
void CART_FUNCTION_TITLE;

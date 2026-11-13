import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { productCache, variantCache, type Db, type OfferCondition, type OfferCombinationPolicy, type OfferReward } from "@promo/db";
import {
  evaluate,
  giftTierState,
  referenceDiscounts,
  type OfferDefinition,
  type ReferenceConfigOffer,
  type ReferenceLine,
  type ReferenceTier,
} from "@promo/rule-engine";
import type { EligibilityReason, EvaluationInput, EvaluationResult, NormalizedCartLine } from "@promo/shared-types";
import { PROMO_LANDING_URL_KEY, PROMO_PAGE_URL_KEY, PROMO_TEMPLATE_KEY } from "@promo/shared-types";
import { loadOfferDefinitions } from "../../offer-definitions.server.js";
import { computeOfferVersion } from "../../offer-version.server.js";
import { normalizeConditionValue } from "../../offer-config-normalization.server.js";
import { isLimitsEnforced } from "../../limits-enforced.server.js";
import { compileCartOffers } from "../../sync/cart-offers.server.js";
import type { CompiledOffer, CompiledShippingOffer } from "../../sync/compile-config.js";
import { ToolError, buildResult, moneyFromMinor, parsePromoRef, shopHandle, type Money, type ToolResult, type Warning } from "../result.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import { loadOffers, ref, type LoadedOffer } from "./catalog-shared.server.js";

const MAX_OFFERS = 25;
const MAX_LINES = 50;
const PREVIEW_PAGES: Record<string, string> = {
  home: "/",
  collection: "/collections/preview",
  product: "/products/preview",
  search: "/search",
  page: "/pages/preview",
  blog: "/blogs/news/preview",
  cart: "/cart",
};
const PREVIEW_SELLING_PLAN = "gid://shopify/SellingPlan/preview";

export const promoPreviewCartInput = {
  shop: z.string().describe("Shop domain, handle or id (hpn-test-store, hpn.myshopify.com)."),
  offers: z
    .array(z.string())
    .max(MAX_OFFERS)
    .optional()
    .describe(
      "Offers to preview: promo:<shopHandle>:<offerId> refs or bare offer ids. Drafts, paused and scheduled offers are allowed when named (built from the database like the admin Preview page). Omitted = every active offer of the shop.",
    ),
  lines: z
    .array(
      z.object({
        product: z.string().optional().describe("Product numeric id, GID or handle. The first purchasable variant is used; pass `variant` to pick one."),
        variant: z.string().optional().describe("Variant numeric id or GID. Wins over `product`."),
        quantity: z.number().int().min(1).max(2000).default(1).describe("Units of this line."),
        unitPrice: z.number().min(0).optional().describe("Unit price in major units of `currency` (19.99). Default: the variant's catalog price."),
        sellingPlan: z.union([z.boolean(), z.string()]).optional().describe("true (or a selling plan GID) makes this a subscription line."),
        properties: z.record(z.string(), z.string()).optional().describe("Line item properties, e.g. { \"__landing_source\": \"nektar-13-offer\" }."),
      }),
    )
    .min(1)
    .max(MAX_LINES)
    .describe("Hypothetical cart lines, each by `product` or `variant`."),
  customer: z
    .object({
      identified: z.boolean().optional().describe("Logged-in customer. Default: true when any other customer field is given, else a guest."),
      tags: z.array(z.string()).optional().describe("Customer tags."),
      ordersCount: z.number().int().min(0).optional().describe("Previous orders (0 = first-time customer)."),
      totalSpent: z.number().min(0).optional().describe("Lifetime spend in major units."),
    })
    .optional()
    .describe("Customer context; omitted = guest."),
  country: z.string().length(2).optional().describe("ISO country code of the shopper (markets / customer_location conditions)."),
  market: z.string().optional().describe("Market handle or GID (markets conditions)."),
  currency: z.string().length(3).optional().describe("Presentment currency (default: the shop currency)."),
  exchangeRate: z.number().positive().optional().describe("Shop currency to `currency` rate; only needed when `currency` differs from the shop currency."),
  page: z
    .object({
      url: z.string().optional().describe("Page the lines were added from: absolute URL or path (/products/x?utm_source=a)."),
      type: z.enum(["home", "collection", "product", "search", "page", "blog", "cart"]).optional().describe("Page type; a representative URL is used when `url` is omitted."),
      template: z.string().optional().describe("Theme template stamp, e.g. product or product.alternate (template conditions)."),
      landingUrl: z.string().optional().describe("First URL of the visit (visit-scoped UTM conditions). Default: the page URL."),
    })
    .optional()
    .describe("Where the lines were added from. Page conditions (page_types, page_url, template, utm_parameters) need it; without a page they fail with a reason."),
  salesChannel: z.enum(["online_store", "pos", "mobile_app", "headless"]).optional().describe("Default online_store."),
  cartAttributes: z.record(z.string(), z.string()).optional().describe("Cart attributes (cart_attribute conditions)."),
  discountCodes: z.array(z.string()).max(20).optional().describe("Codes entered in the cart."),
  at: z.string().optional().describe("Evaluate as of this ISO date-time (schedule windows). Default: now."),
};

export const PROMO_PREVIEW_CART_DESCRIPTION = [
  "Simulates a hypothetical cart against the shop's offers and says what the storefront and checkout would do. Read only: nothing is written or published.",
  "It runs the storefront evaluation (the rule engine `evaluate`, same conditions and gift logic as the live widget) and, for each qualified offer, the offer's compiled Function config through a reference model of the discount Function to get line-level discounts (percentage / fixed amount / fixed price / free, quantity-tier hit, discounted units). That model mirrors the Function and is pinned to it by the golden parity fixtures; Shopify's own best-of / combination resolution across apps and discount nodes is NOT simulated beyond our combination policies (stop lower priority, per-offer combines flags, gift stacking).",
  "Returns per qualified offer: passed checks, per-line discounts with the tier hit, gifts that would be added (and picker options), order and shipping tier hits, cart messages and progress bars; per non-qualified offer: why not. Page conditions need `page`, customer conditions need `customer`, market conditions need `country`/`market`.",
  "Example: { shop: \"onesolsupps\", lines: [{ product: \"9208279269615\", quantity: 2 }], page: { type: \"product\" } } -> 2 units, tier 2+ -> 30% off per unit.",
  "Order and shipping tier amounts are approximate (cart subtotal, no cross-currency conversion). Subscription-only and code-gated offers apply their own rules: pass sellingPlan / discountCodes to exercise them.",
].join(" ");

type Args = {
  shop: string;
  offers?: string[];
  lines: Array<{ product?: string; variant?: string; quantity?: number; unitPrice?: number; sellingPlan?: boolean | string; properties?: Record<string, string> }>;
  customer?: { identified?: boolean; tags?: string[]; ordersCount?: number; totalSpent?: number };
  country?: string;
  market?: string;
  currency?: string;
  exchangeRate?: number;
  page?: { url?: string; type?: string; template?: string; landingUrl?: string };
  salesChannel?: "online_store" | "pos" | "mobile_app" | "headless";
  cartAttributes?: Record<string, string>;
  discountCodes?: string[];
  at?: string;
};

type ResolvedLine = {
  key: string;
  productGid: string;
  variantGid: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
  unitPriceCents: number;
  line: NormalizedCartLine;
};

const toGid = (kind: "Product" | "ProductVariant", value: string): string | null => {
  const v = value.trim();
  if (v.startsWith("gid://")) return v;
  return /^\d+$/.test(v) ? `gid://shopify/${kind}/${v}` : null;
};

const cents = (major: number) => Math.round(major * 100);

async function resolveLines(db: Db, shop: VisibleShop, args: Args, currency: string, pageStamps: Record<string, string>, warnings: Warning[]): Promise<ResolvedLine[]> {
  const rate = currency !== shop.currencyCode ? args.exchangeRate : undefined;
  if (currency !== shop.currencyCode && !args.exchangeRate && args.lines.some((l) => l.unitPrice === undefined)) {
    warnings.push({
      code: "PRICE_CURRENCY",
      severity: "warn",
      message: `Catalog prices are in ${shop.currencyCode} and no exchangeRate was given: they are used as ${currency} amounts. Pass exchangeRate or unitPrice.`,
    });
  }
  const resolved: ResolvedLine[] = [];
  for (const [index, input] of args.lines.entries()) {
    const label = input.variant ?? input.product ?? `#${index + 1}`;
    if (!input.variant && !input.product) throw new ToolError("VALIDATION", `lines[${index}] needs product or variant.`);
    const notFound = () =>
      new ToolError("NOT_FOUND", `lines[${index}]: "${label}" is not in this shop's catalog cache. Use a product/variant id or handle that exists; run a catalog sync if the product is new.`, {
        suggestedAction: { mcp: "promo-engine", tool: "catalog_search", args: { shop: shop.myshopifyDomain, query: label }, why: "Find the product or variant." },
      });

    let variant: typeof variantCache.$inferSelect | undefined;
    let product: typeof productCache.$inferSelect | undefined;
    if (input.variant) {
      const gid = toGid("ProductVariant", input.variant);
      if (!gid) throw new ToolError("VALIDATION", `lines[${index}].variant must be a numeric id or GID.`);
      [variant] = await db.select().from(variantCache).where(and(eq(variantCache.shopId, shop.id), eq(variantCache.variantGid, gid))).limit(1);
      if (!variant) throw notFound();
      [product] = await db.select().from(productCache).where(and(eq(productCache.shopId, shop.id), eq(productCache.productGid, variant.productGid))).limit(1);
    } else {
      const raw = input.product!.trim();
      const gid = toGid("Product", raw);
      [product] = await db
        .select()
        .from(productCache)
        .where(and(eq(productCache.shopId, shop.id), gid ? eq(productCache.productGid, gid) : eq(productCache.handle, raw)))
        .limit(1);
      if (!product) throw notFound();
      [variant] = await db
        .select()
        .from(variantCache)
        .where(and(eq(variantCache.shopId, shop.id), eq(variantCache.productGid, product.productGid)))
        .orderBy(desc(variantCache.availableForSale), asc(variantCache.requiresSellingPlan), asc(variantCache.legacyVariantId), asc(variantCache.variantGid))
        .limit(1);
      if (!variant) throw notFound();
    }
    if (!product) throw notFound();

    const quantity = input.quantity ?? 1;
    const catalogPrice = Number(variant.price) * (rate ?? 1);
    const priceCents = cents(input.unitPrice ?? catalogPrice);
    const compareAt = variant.compareAtPrice === null ? null : cents(Number(variant.compareAtPrice) * (rate ?? 1));
    const subscription = input.sellingPlan === true || (typeof input.sellingPlan === "string" && input.sellingPlan !== "");
    const key = `preview-line-${index + 1}`;
    resolved.push({
      key,
      productGid: product.productGid,
      variantGid: variant.variantGid,
      title: product.title,
      variantTitle: variant.title,
      quantity,
      unitPriceCents: priceCents,
      line: {
        key,
        variantId: variant.variantGid,
        productId: product.productGid,
        quantity,
        priceCents,
        lineSubtotalCents: priceCents * quantity,
        originalLineSubtotalCents: priceCents * quantity,
        compareAtPriceCents: compareAt,
        properties: { ...pageStamps, ...(input.properties ?? {}) },
        requiresSellingPlan: variant.requiresSellingPlan,
        sellingPlanId: subscription ? (typeof input.sellingPlan === "string" ? input.sellingPlan : PREVIEW_SELLING_PLAN) : null,
        productHandle: product.handle,
        productTitle: product.title,
        variantTitle: variant.title,
        vendor: product.vendor ?? "",
        productType: product.productType ?? "",
        tags: product.tags,
        collections: product.collections,
        availableForSale: variant.availableForSale,
        inventoryPolicy: variant.inventoryPolicy === "CONTINUE" ? "CONTINUE" : "DENY",
        inventoryQuantity: variant.inventoryQuantity,
      },
    });
  }
  return resolved;
}

function absoluteUrl(shopDomain: string, value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${shopDomain}${value.startsWith("/") ? "" : "/"}${value}`;
}

function pageContext(shop: VisibleShop, page: Args["page"]): { requestedUrl: string | null; stamps: Record<string, string> } {
  if (!page) return { requestedUrl: null, stamps: {} };
  const path = page.url ?? (page.type ? PREVIEW_PAGES[page.type] : undefined);
  const stamps: Record<string, string> = {};
  let requestedUrl: string | null = null;
  if (path) {
    requestedUrl = absoluteUrl(shop.myshopifyDomain, path);
    stamps[PROMO_PAGE_URL_KEY] = requestedUrl;
    stamps[PROMO_LANDING_URL_KEY] = page.landingUrl ? absoluteUrl(shop.myshopifyDomain, page.landingUrl) : requestedUrl;
  }
  if (page.template) stamps[PROMO_TEMPLATE_KEY] = `@${page.template}`;
  return { requestedUrl, stamps };
}

/** Same definition as `loadOfferDefinitions`, for an offer in any status (that loader only reads active ones). */
function definitionFromRows(loaded: LoadedOffer, limitsEnforced: boolean): OfferDefinition {
  const { offer, conditions, rewards, policy } = loaded;
  return {
    id: offer.id,
    version: computeOfferVersion(offer, conditions, rewards, policy),
    type: offer.type,
    priority: offer.priority,
    ...(offer.tierMode ? { tierMode: offer.tierMode } : {}),
    stopLowerPriority: policy?.stopLowerPriority ?? false,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    conditions: [...conditions]
      .filter((c) => limitsEnforced || c.conditionType !== "one_use_per_customer")
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        id: c.id,
        scope: c.scope,
        conditionType: c.conditionType,
        operator: c.operator,
        value: normalizeConditionValue(c.conditionType, c.value),
        isEnabled: c.isEnabled,
        sortOrder: c.sortOrder,
      })),
    rewards: [...rewards]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((r) => ({
        id: r.id,
        rewardType: r.rewardType,
        discountType: r.discountType,
        value: r.value,
        target: r.target,
        quantity: r.quantity,
        isAutoAdd: r.isAutoAdd,
        isCustomerSelectable: r.isCustomerSelectable,
        trackMode: r.trackMode as "product" | "variant",
        sortOrder: r.sortOrder,
        label: r.label,
        ...(r.minCartSubtotalCents != null ? { minCartSubtotalCents: r.minCartSubtotalCents } : {}),
      })),
    combinationPolicy: {
      combinesWithOrderDiscounts: policy?.combinesWithOrderDiscounts ?? true,
      combinesWithProductDiscounts: policy?.combinesWithProductDiscounts ?? true,
      combinesWithShippingDiscounts: policy?.combinesWithShippingDiscounts ?? true,
      stopLowerPriority: policy?.stopLowerPriority ?? false,
      canStackWithGiftOffers: policy?.canStackWithGiftOffers ?? true,
      maxApplicationsPerCart: limitsEnforced ? (policy?.maxApplicationsPerCart ?? null) : null,
      maxApplicationsPerCustomer: limitsEnforced ? (policy?.maxApplicationsPerCustomer ?? null) : null,
      requireIdentifiedCustomer: limitsEnforced && policy?.requireIdentifiedCustomer === true,
    },
    giftValueCountsForOtherOffers: policy?.giftValueCountsForOtherOffers ?? false,
  };
}

function parseOfferIds(shop: VisibleShop, refs: string[]): string[] {
  const UUID = /^[0-9a-f-]{36}$/i;
  return [
    ...new Set(
      refs.map((value) => {
        const parsed = parsePromoRef(value);
        if (parsed) {
          if (parsed.shopHandle.toLowerCase() !== shopHandle(shop.myshopifyDomain).toLowerCase()) {
            throw new ToolError("VALIDATION", `Offer ref "${value}" belongs to another shop than ${shop.myshopifyDomain}.`);
          }
          return parsed.offerId;
        }
        if (UUID.test(value)) return value;
        throw new ToolError("VALIDATION", `Offer "${value}" must be promo:<shopHandle>:<offerId> or an offer id.`);
      }),
    ),
  ];
}

/** Money per unit in major units for one discount instruction; null when the type is not one the Function applies per unit. */
function perUnitDiscount(type: string | undefined, value: number | undefined, unitPrice: number, targetPrice?: number): number | null {
  if (targetPrice !== undefined) return Math.max(0, unitPrice - targetPrice);
  const v = value ?? 0;
  switch (type) {
    case "percentage":
    case "most_expensive_item_discount":
      return (unitPrice * Math.min(v, 100)) / 100;
    case "fixed_amount":
      return Math.min(v, unitPrice);
    case "fixed_price":
      return Math.max(0, unitPrice - v);
    case "free":
    case "cheapest_item_free":
      return unitPrice;
    default:
      return null;
  }
}

const tierLabel = (tier: ReferenceTier | { quantity: number } | undefined) => {
  if (!tier) return null;
  if ("quantity" in tier) return { minimumQuantity: tier.quantity };
  return {
    minimumQuantity: tier.minimumQuantity,
    ...(tier.maximumQuantity !== undefined ? { maximumQuantity: tier.maximumQuantity } : {}),
    ...(tier.discountedQuantity !== undefined ? { discountedQuantity: tier.discountedQuantity } : {}),
    ...(tier.discountType ? { discountType: tier.discountType } : {}),
    ...(tier.discountValue !== undefined ? { discountValue: tier.discountValue } : {}),
  };
};

type LineDiscount = {
  lineKey: string;
  title: string;
  variantTitle: string | null;
  variantId: string;
  quantity: number;
  discountedUnits: number;
  unitPrice: Money;
  source: "product_discount" | "gift_line";
  rewardId: string;
  discountType: string;
  discountValue: number;
  tier: Record<string, unknown> | null;
  discountPerUnit: Money | null;
  totalDiscount: Money | null;
  priceAfterDiscount: Money | null;
};

function pickOrderTier(
  reward: CompiledOffer["orderRewards"][number],
  subtotalCents: number,
  quantity: number,
): { type: string; value: number; tier: Record<string, unknown> | null } | null {
  if (reward.subtotalTiers.length === 0) return { type: reward.discountType, value: reward.discountValue, tier: null };
  const tier = reward.subtotalTiers
    .filter(
      (t) =>
        subtotalCents >= (t.minimumSubtotalCents ?? 0) &&
        (t.maximumSubtotalCents === undefined || subtotalCents <= t.maximumSubtotalCents) &&
        quantity >= (t.minimumQuantity ?? 0) &&
        (t.maximumQuantity === undefined || quantity <= t.maximumQuantity),
    )
    .sort((a, b) => (b.minimumSubtotalCents ?? 0) - (a.minimumSubtotalCents ?? 0) || (b.minimumQuantity ?? 0) - (a.minimumQuantity ?? 0))[0];
  return tier ? { type: tier.discountType, value: tier.discountValue, tier: { ...tier } } : null;
}

function describeOrderDiscount(type: string, value: number, subtotalCents: number, currency: string): { discount: Money | null; label: string } {
  if (type === "free") return { discount: moneyFromMinor(subtotalCents, currency), label: "100% off the order" };
  if (type === "percentage") return { discount: moneyFromMinor(Math.round((subtotalCents * Math.min(value, 100)) / 100), currency), label: `${value}% off the order` };
  if (type === "fixed_amount") return { discount: moneyFromMinor(Math.min(cents(value), subtotalCents), currency), label: `${value} ${currency} off the order` };
  return { discount: null, label: `${type} ${value}` };
}

function shippingMatch(offer: CompiledShippingOffer, subtotalCents: number, hasSubscription: boolean): { tier: CompiledShippingOffer["tiers"][number] } | null {
  const tier = offer.tiers
    .filter(
      (t) =>
        subtotalCents >= t.minimumSubtotalCents &&
        (t.maximumSubtotalCents === undefined || subtotalCents <= t.maximumSubtotalCents) &&
        (t.appliesWhen === undefined || (t.appliesWhen === "has_subscription" ? hasSubscription : !hasSubscription)),
    )
    .sort((a, b) => b.minimumSubtotalCents - a.minimumSubtotalCents)[0];
  return tier ? { tier } : null;
}

const failed = (reasons: EligibilityReason[]) => reasons.filter((r) => !r.passed);
const brief = (r: EligibilityReason) => ({ conditionType: r.conditionType, message: r.message, ...(r.actual !== undefined ? { actual: r.actual } : {}), ...(r.required !== undefined ? { required: r.required } : {}) });

export async function promoPreviewCart(
  db: Db,
  visible: VisibleShop[],
  args: Args,
  now: () => Date = () => new Date(),
): Promise<ToolResult<Record<string, unknown>>> {
  const [shop] = selectShops(visible, [args.shop]);
  if (!shop) throw new ToolError("SHOP_NOT_FOUND", `Shop "${args.shop}" is not visible to you.`);
  const warnings: Warning[] = [];
  const currency = (args.currency ?? shop.currencyCode).toUpperCase();
  const evaluatedAt = args.at ? new Date(args.at) : now();
  if (Number.isNaN(evaluatedAt.getTime())) throw new ToolError("VALIDATION", "at must be an ISO date-time.");

  const page = pageContext(shop, args.page);
  const lines = await resolveLines(db, shop, args, currency, page.stamps, warnings);

  const limitsEnforced = await isLimitsEnforced(db, shop.id);
  const named = args.offers && args.offers.length > 0 ? parseOfferIds(shop, args.offers) : null;
  const selected = named
    ? (await Promise.all(named.map((offerId) => loadOffers(db, shop, { offerId })))).flat()
    : await loadOffers(db, shop, { statuses: ["active"] });
  const missing = named ? named.filter((id) => !selected.some((l) => l.offer.id === id)) : [];
  if (missing.length > 0) {
    throw new ToolError("NOT_FOUND", `Offer(s) not found in ${shop.myshopifyDomain}: ${missing.join(", ")}.`, {
      suggestedAction: { mcp: "promo-engine", tool: "promos_active", args: { shops: [shop.myshopifyDomain], status: ["active", "scheduled", "paused", "draft"] }, why: "List the offers of that shop." },
    });
  }
  if (selected.length === 0) warnings.push({ code: "NO_OFFERS", severity: "info", message: "The shop has no active offers to evaluate; name offers (even drafts) with `offers`." });

  const liveDefinitions = new Map((await loadOfferDefinitions(shop.id, db)).map((d) => [d.id, d]));
  const definitions = selected.map((l) => liveDefinitions.get(l.offer.id) ?? definitionFromRows(l, limitsEnforced));

  const customerInput = args.customer;
  const identified = customerInput ? (customerInput.identified ?? true) : false;
  const cartLines = lines.map((l) => l.line);
  const subtotalCents = cartLines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
  const totalQuantity = cartLines.reduce((sum, l) => sum + l.quantity, 0);
  const exchangeRate = currency !== shop.currencyCode ? args.exchangeRate : undefined;
  const input: EvaluationInput = {
    shopDomain: shop.myshopifyDomain,
    cart: {
      token: "preview-session",
      id: null,
      lines: cartLines,
      attributes: args.cartAttributes ?? {},
      subtotalCents,
      discountCodes: args.discountCodes ?? [],
      currencyCode: currency,
      totalQuantity,
    },
    customer: identified
      ? {
          id: "gid://shopify/Customer/preview",
          email: "preview@example.com",
          tags: customerInput?.tags ?? [],
          totalSpentCents: cents(customerInput?.totalSpent ?? 0),
          totalOrders: customerInput?.ordersCount ?? 0,
          lastOrderSpentCents: null,
          countryCode: args.country?.toUpperCase() ?? null,
          isFirstTimeCustomer: (customerInput?.ordersCount ?? 0) === 0,
        }
      : null,
    market:
      args.country || args.market || currency !== shop.currencyCode
        ? {
            id: args.market?.startsWith("gid://") ? args.market : "gid://shopify/Market/preview",
            handle: args.market && !args.market.startsWith("gid://") ? args.market : "preview",
            currencyCode: currency,
            countryCode: args.country?.toUpperCase() ?? null,
            primaryLocale: "en",
            ...(exchangeRate ? { exchangeRate } : {}),
          }
        : null,
    locale: "en",
    salesChannel: args.salesChannel ?? "online_store",
    requestedUrl: page.requestedUrl,
    sessionId: "preview-session",
  };
  const result: EvaluationResult = await evaluate(input, {
    offers: definitions,
    usageStates: [],
    identifiedCustomer: identified,
    now: evaluatedAt,
    shopCurrencyCode: shop.currencyCode,
  });

  const referenceLines: ReferenceLine[] = lines.map((l) => ({
    id: l.key,
    variantId: l.variantGid,
    productId: l.productGid,
    quantity: l.quantity,
    unitPrice: (l.unitPriceCents / 100).toFixed(2),
    lineType: null,
    metadata: { ...l.line.properties },
  }));
  const lineByKey = new Map(lines.map((l) => [l.key, l]));
  const unit = (stored: number): Money => moneyFromMinor(stored, currency);

  const variantIds = new Set<string>();
  for (const action of result.cartActions) if (action.action === "add_line") variantIds.add(action.variantId);
  for (const slider of [result.giftSlider, ...(result.additionalGiftSliders ?? [])]) for (const g of slider?.selectableGifts ?? []) variantIds.add(g.variantId);
  const titles = new Map<string, string>();
  if (variantIds.size > 0) {
    const rows = await db
      .select({ variantGid: variantCache.variantGid, title: variantCache.title, productTitle: productCache.title })
      .from(variantCache)
      .leftJoin(productCache, and(eq(productCache.shopId, variantCache.shopId), eq(productCache.productGid, variantCache.productGid)))
      .where(and(eq(variantCache.shopId, shop.id), inArray(variantCache.variantGid, [...variantIds])));
    for (const r of rows) titles.set(r.variantGid, [r.productTitle, r.title !== "Default Title" ? r.title : null].filter(Boolean).join(" - "));
  }

  const qualifiedData: Record<string, unknown>[] = [];
  const notQualified: Record<string, unknown>[] = [];
  const handled = new Set<string>();
  let totalLineDiscountCents = 0;

  for (const evaluated of result.qualifiedOffers) {
    handled.add(evaluated.offerId);
    const source = selected.find((l) => l.offer.id === evaluated.offerId)!;
    const definition = definitions.find((d) => d.id === evaluated.offerId)!;
    const offerWarnings: string[] = [];
    let compiled: Awaited<ReturnType<typeof compileCartOffers>>[number] | null = null;
    let compileError: string | null = null;
    try {
      [compiled] = await compileCartOffers(db, shop.id, [source.offer], {
        conditions: source.conditions as OfferCondition[],
        rewards: source.rewards as OfferReward[],
        policies: (source.policy ? [source.policy] : []) as OfferCombinationPolicy[],
        shopCurrencyCode: shop.currencyCode,
        limitsEnforced,
        caller: "capacity-preflight",
      });
    } catch (error) {
      compileError = error instanceof Error ? error.message : String(error);
    }

    const lineDiscounts: LineDiscount[] = [];
    let order: Record<string, unknown> | null = null;
    const shipping: Record<string, unknown>[] = [];
    if (compiled) {
      const config = compiled.offer as unknown as ReferenceConfigOffer;
      const compiledOffer = compiled.offer;
      const tiers = giftTierState(
        definition,
        { ...input.cart },
        { activeCurrencyCode: currency, shopCurrencyCode: shop.currencyCode, exchangeRate },
        new Set(compiledOffer.excludedProductIds ?? []),
      );
      const productInfo = new Map<string, { quantityTier?: ReferenceTier; priceTier?: { quantity: number; targetPricePerUnit?: number } }>();
      const grants: Array<{ rewardId: string; lineId: string; units: number }> = [];
      referenceDiscounts(referenceLines, { id: definition.id, conditions: definition.conditions }, config, tiers?.unmetRewardIds, {
        gift: (g) => grants.push(g),
        productReward: (info) => {
          productInfo.set(info.rewardId, { ...(info.quantityTier ? { quantityTier: info.quantityTier } : {}), ...(info.priceTier ? { priceTier: info.priceTier } : {}) });
          for (const [lineId, units] of Object.entries(info.unitsByLine)) {
            const l = lineByKey.get(lineId)!;
            const reward = compiledOffer.productRewards.find((r) => r.id === info.rewardId)!;
            const t = info.quantityTier;
            const type = info.priceTier ? "fixed_price" : (t?.discountType ?? reward.discountType);
            const value = info.priceTier ? (info.priceTier.targetPricePerUnit ?? 0) : (t?.discountValue ?? reward.discountValue);
            const per = perUnitDiscount(type, value, l.unitPriceCents / 100, info.priceTier?.targetPricePerUnit);
            const perCents = per === null ? null : cents(per);
            lineDiscounts.push({
              lineKey: l.key,
              title: l.title,
              variantTitle: l.variantTitle,
              variantId: l.variantGid,
              quantity: l.quantity,
              discountedUnits: units,
              unitPrice: unit(l.unitPriceCents),
              source: "product_discount",
              rewardId: reward.id,
              discountType: type,
              discountValue: value,
              tier: tierLabel(info.priceTier ?? t),
              discountPerUnit: perCents === null ? null : unit(perCents),
              totalDiscount: perCents === null ? null : unit(perCents * units),
              priceAfterDiscount: perCents === null ? null : unit(Math.max(0, l.unitPriceCents - perCents)),
            });
            if (perCents !== null) totalLineDiscountCents += perCents * units;
          }
        },
      });
      for (const grant of grants) {
        const l = lineByKey.get(grant.lineId)!;
        const reward = compiledOffer.giftRewards.find((r) => r.id === grant.rewardId);
        const per = perUnitDiscount(reward?.discountType ?? "free", reward?.discountValue, l.unitPriceCents / 100);
        const perCents = per === null ? null : cents(per);
        lineDiscounts.push({
          lineKey: l.key,
          title: l.title,
          variantTitle: l.variantTitle,
          variantId: l.variantGid,
          quantity: l.quantity,
          discountedUnits: grant.units,
          unitPrice: unit(l.unitPriceCents),
          source: "gift_line",
          rewardId: grant.rewardId,
          discountType: reward?.discountType ?? "free",
          discountValue: reward?.discountValue ?? 100,
          tier: null,
          discountPerUnit: perCents === null ? null : unit(perCents),
          totalDiscount: perCents === null ? null : unit(perCents * grant.units),
          priceAfterDiscount: perCents === null ? null : unit(Math.max(0, l.unitPriceCents - perCents)),
        });
        if (perCents !== null) totalLineDiscountCents += perCents * grant.units;
      }

      for (const reward of compiledOffer.orderRewards) {
        const pick = pickOrderTier(reward, subtotalCents, totalQuantity);
        if (!pick) {
          offerWarnings.push(`Order discount tiers not reached at subtotal ${unit(subtotalCents).amount} ${currency}.`);
          continue;
        }
        const d = describeOrderDiscount(pick.type, pick.value, subtotalCents, currency);
        order = { rewardId: reward.id, discountType: pick.type, discountValue: pick.value, tier: pick.tier, discount: d.discount, summary: d.label, approximate: true };
      }
      const hasSubscription = cartLines.some((l) => l.sellingPlanId !== null);
      for (const ship of compiled.shipping) {
        const match = shippingMatch(ship, subtotalCents, hasSubscription);
        shipping.push(
          match
            ? { id: ship.id, discountType: match.tier.discountType, discountValue: match.tier.discountValue, tier: { ...match.tier }, approximate: true }
            : { id: ship.id, applies: false, reason: "No shipping tier matches this subtotal / purchase type." },
        );
      }
      if (compiledOffer.productRewards.length > 0 && lineDiscounts.filter((d) => d.source === "product_discount").length === 0) {
        offerWarnings.push("The offer qualifies but no cart line matches its product rewards (targets, page stamps or tier minimum), so no line is discounted.");
      }
    } else if (compileError) {
      offerWarnings.push(`The Function config does not compile for this offer, so no line-level result: ${compileError}`);
    }
    if (source.offer.requiresCode) offerWarnings.push("Code offer: at checkout it applies only while its code is entered; evaluated here as if it were.");
    if (source.conditions.some((c) => c.isEnabled && c.conditionType === "markets")) offerWarnings.push("Market conditions are checked by the evaluator; the Function's own country restriction needs a live market sync and is not resolved here.");

    const offerTotal = lineDiscounts.reduce((sum, d) => sum + (d.totalDiscount ? cents(Number(d.totalDiscount.amount)) : 0), 0);
    qualifiedData.push({
      offer: { ref: ref(shop, source.offer.id), name: source.offer.internalName, type: source.offer.type, status: source.offer.status, priority: source.offer.priority },
      passedChecks: evaluated.reasons.filter((r) => r.passed).map((r) => ({ conditionType: r.conditionType, message: r.message })),
      lineDiscounts: lineDiscounts.map(({ ...d }) => d),
      lineDiscountTotal: lineDiscounts.length > 0 ? unit(offerTotal) : null,
      orderDiscount: order,
      shippingDiscounts: shipping,
      gifts: evaluated.cartActions
        .filter((a) => a.action === "add_line")
        .map((a) => ({ variantId: (a as { variantId: string }).variantId, title: titles.get((a as { variantId: string }).variantId) ?? null, quantity: (a as { quantity: number }).quantity })),
      otherCartActions: evaluated.cartActions
        .filter((a) => a.action !== "add_line")
        .map((a) => ({ action: a.action, ...("lineKey" in a ? { lineKey: a.lineKey } : {}), ...("reason" in a && a.reason ? { reason: a.reason } : {}) })),
      giftPickers: [result.giftSlider, ...(result.additionalGiftSliders ?? [])]
        .filter((s) => s && s.offerId === evaluated.offerId)
        .map((s) => ({
          maxSelectableCount: s!.maxSelectableCount,
          options: s!.selectableGifts.map((g) => ({
            variantId: g.variantId,
            title: titles.get(g.variantId) ?? g.title,
            available: g.isAvailable,
            originalPrice: unit(g.originalPriceCents),
            discountedPrice: unit(g.discountedPriceCents),
          })),
        })),
      upsells: result.upsells.filter((u) => u.offerId === evaluated.offerId).map((u) => ({ message: u.message, discountPercent: u.discountPercent, product: u.product?.title ?? null })),
      cartMessages: result.cartMessages.filter((m) => m.offerId === evaluated.offerId).map((m) => ({ type: m.type, message: m.message })),
      progressBars: result.progressBars.filter((b) => b.offerId === evaluated.offerId).map((b) => ({
        current: unit(b.currentCents),
        target: unit(b.targetCents),
        percent: b.progressPercent,
        goalReached: b.isGoalReached,
        message: b.isGoalReached ? b.messageAfterGoal : b.messageBeforeGoal,
      })),
      notes: offerWarnings,
    });
  }

  for (const evaluated of result.disqualifiedOffers) {
    handled.add(evaluated.offerId);
    const source = selected.find((l) => l.offer.id === evaluated.offerId);
    notQualified.push({
      offer: { ref: ref(shop, evaluated.offerId), name: source?.offer.internalName ?? null, type: evaluated.type, status: source?.offer.status ?? null },
      why: failed(evaluated.reasons).map((r) => r.message),
      failedChecks: failed(evaluated.reasons).map(brief),
      passedChecks: evaluated.reasons.filter((r) => r.passed).map((r) => r.conditionType),
    });
  }
  for (const l of selected) {
    if (handled.has(l.offer.id)) continue;
    notQualified.push({
      offer: { ref: ref(shop, l.offer.id), name: l.offer.internalName, type: l.offer.type, status: l.offer.status },
      why: ["The evaluator did not return a result for this offer (it was filtered out before evaluation)."],
      failedChecks: [],
      passedChecks: [],
    });
  }

  if (!page.requestedUrl && definitions.some((d) => d.conditions.some((c) => c.isEnabled && ["page_types", "page_url", "specific_link", "utm_parameters"].includes(c.conditionType)))) {
    warnings.push({ code: "NO_PAGE", severity: "info", message: "Some offers have page conditions and no `page` was given, so they cannot match. Pass page.type or page.url." });
  }
  if (currency !== shop.currencyCode) {
    warnings.push({ code: "CURRENCY", severity: "info", message: `Currency ${currency} differs from the shop currency ${shop.currencyCode}: fixed amounts and subtotal tiers are not converted in the order / shipping estimates.` });
  }
  warnings.push({
    code: "MODEL",
    severity: "info",
    message: "Line-level discounts come from a TypeScript reference model of the discount Function (parity-tested). Shopify's best-of / cross-app combination resolution is not simulated beyond our own combination policies.",
  });

  const nothing = qualifiedData.length === 0;
  const summary = nothing
    ? `0 of ${selected.length} offer(s) qualify for this cart in ${shop.myshopifyDomain}.`
    : `${qualifiedData.length} of ${selected.length} offer(s) qualify in ${shop.myshopifyDomain}; line discounts total ${unit(totalLineDiscountCents).amount} ${currency}.`;
  return buildResult(
    {
      summary,
      data: {
        shop: shop.myshopifyDomain,
        evaluatedAt: evaluatedAt.toISOString(),
        cart: {
          currency,
          subtotal: unit(subtotalCents),
          totalQuantity,
          lines: lines.map((l) => ({ key: l.key, title: l.title, variantTitle: l.variantTitle, productId: l.productGid, variantId: l.variantGid, quantity: l.quantity, unitPrice: unit(l.unitPriceCents) })),
        },
        offersEvaluated: selected.length,
        qualified: qualifiedData,
        notQualified,
        cartMessages: result.cartMessages.map((m) => ({ offer: ref(shop, m.offerId), type: m.type, message: m.message })),
        lineDiscountTotal: unit(totalLineDiscountCents),
        evaluationWarnings: result.warnings,
      },
      warnings,
    },
    now,
  );
}

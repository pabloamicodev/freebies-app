import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { productCache, variantCache, type Db } from "@promo/db";
import { isGiftVariantAvailable, type GiftCatalogRow } from "../../gift-enrichment.server.js";
import { readPageTypes } from "../../page-types.js";
import { buildResult, moneyFromMinor, shopHandle, type Money, type ToolResult } from "../result.server.js";
import { fanOut, type ShopRef } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import {
  OFFER_STATUSES,
  adminLink,
  loadOffers,
  paginate,
  pagingInput,
  ref,
  resolvePromoRef,
  shopsInput,
  type LoadedOffer,
  type Paging,
} from "./catalog-shared.server.js";

export const giftsRulesInput = {
  shops: shopsInput,
  status: z.array(z.enum(OFFER_STATUSES)).optional().describe("Default: every non-archived status."),
  ref: z.string().optional().describe("promo:<shopHandle>:<offerId> to look at one gift offer."),
  ...pagingInput,
};

const LOW_STOCK_AT = 5;

export type GiftRuleRow = {
  promoRef: string;
  offerId: string;
  shopDomain: string;
  name: string;
  status: string;
  threshold: Money | null;
  minQuantity: number | null;
  giftVariants: number;
  giftProducts: number;
  fallbackVariants: number;
  isPicker: boolean;
  autoAdd: boolean;
  giftQuantity: number | null;
  limit: {
    setGrantsPerCart: number | null;
    setGrantsPerCustomer: number | null;
    maxUnitsTotal: number | null;
    maxUnitsPerProduct: number | null;
    oncePerCustomer: boolean;
    semantics: string;
  };
  stock: { known: number; soldOut: number; lowStock: number; unknown: number };
  landingSources: string[];
};

const LIMIT_SEMANTICS = "Limit = times the gift SET is granted, per gift product; never duplicated on re-qualification.";

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function stockFor(db: Db, shop: ShopRef, variantIds: string[]): Promise<Map<string, GiftCatalogRow>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select({
      variantGid: variantCache.variantGid,
      productGid: variantCache.productGid,
      variantTitle: variantCache.title,
      price: variantCache.price,
      availableForSale: variantCache.availableForSale,
      inventoryQuantity: variantCache.inventoryQuantity,
      inventoryPolicy: variantCache.inventoryPolicy,
      requiresSellingPlan: variantCache.requiresSellingPlan,
      inventoryTracked: variantCache.inventoryTracked,
      productTitle: productCache.title,
      imageUrl: productCache.imageUrl,
      productStatus: productCache.status,
    })
    .from(variantCache)
    .leftJoin(productCache, and(eq(productCache.shopId, variantCache.shopId), eq(productCache.productGid, variantCache.productGid)))
    .where(and(eq(variantCache.shopId, shop.id), inArray(variantCache.variantGid, variantIds)));
  return new Map(rows.map((r) => [r.variantGid, r]));
}

export function giftRow(shop: ShopRef, l: LoadedOffer, catalog: Map<string, GiftCatalogRow>): GiftRuleRow {
  const enabled = l.conditions.filter((c) => c.isEnabled);
  const gifts = l.rewards.filter((r) => r.rewardType === "product_gift");
  const targets = gifts.map((r) => (r.target ?? {}) as Record<string, unknown>);
  const variantIds = [...new Set(targets.flatMap((t) => ids(t["variantIds"]).concat(typeof t["variantId"] === "string" ? [t["variantId"]] : [])))];
  const productIds = [...new Set(targets.flatMap((t) => ids(t["productIds"])))];
  const fallbackIds = [...new Set(targets.flatMap((t) => ids(t["fallbackVariantIds"])))];

  const cartValue = enabled.find((c) => c.conditionType === "cart_value");
  const cv = (cartValue?.value ?? {}) as Record<string, unknown>;
  const thresholdCents = num(cv["thresholdCents"]);
  const cartQty = enabled.find((c) => c.conditionType === "cart_quantity");

  const stock = { known: 0, soldOut: 0, lowStock: 0, unknown: 0 };
  for (const id of variantIds) {
    const row = catalog.get(id);
    if (!row) {
      stock.unknown += 1;
      continue;
    }
    stock.known += 1;
    if (!isGiftVariantAvailable(row)) stock.soldOut += 1;
    else if (row.inventoryTracked === true && row.inventoryQuantity !== null && row.inventoryQuantity <= LOW_STOCK_AT) stock.lowStock += 1;
  }

  const pageTypes = enabled
    .filter((c) => c.conditionType === "page_types")
    .flatMap((c) => readPageTypes((c.value as Record<string, unknown> | null)?.["pageTypes"]));

  return {
    promoRef: ref(shop, l.offer.id),
    offerId: l.offer.id,
    shopDomain: shop.myshopifyDomain,
    name: l.offer.internalName,
    status: l.offer.status,
    threshold: thresholdCents === null ? null : moneyFromMinor(thresholdCents, typeof cv["currencyCode"] === "string" ? cv["currencyCode"] : shop.currencyCode),
    minQuantity: num((cartQty?.value as Record<string, unknown> | undefined)?.["minQuantity"]),
    giftVariants: variantIds.length,
    giftProducts: productIds.length,
    fallbackVariants: fallbackIds.length,
    isPicker: gifts.some((r) => r.isCustomerSelectable),
    autoAdd: gifts.some((r) => r.isAutoAdd),
    giftQuantity: gifts[0]?.quantity ?? null,
    limit: {
      setGrantsPerCart: l.policy?.maxApplicationsPerCart ?? null,
      setGrantsPerCustomer: l.policy?.maxApplicationsPerCustomer ?? null,
      maxUnitsTotal: targets.map((t) => num(t["maxUnitsTotal"])).find((v) => v !== null) ?? null,
      maxUnitsPerProduct: targets.map((t) => num(t["maxUnitsPerProduct"])).find((v) => v !== null) ?? null,
      oncePerCustomer: enabled.some((c) => c.conditionType === "one_use_per_customer"),
      semantics: LIMIT_SEMANTICS,
    },
    stock,
    landingSources: [...new Set(pageTypes)],
  };
}

export async function giftsRules(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; status?: string[]; ref?: string } & Paging,
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ gifts: GiftRuleRow[] }>> {
  const target = args.ref ? resolvePromoRef(visible, { ref: args.ref }) : null;
  const selected = target ? [target.shop] : selectShops(visible, args.shops);
  const statuses = args.status?.length ? args.status : [...OFFER_STATUSES];
  const { perShop, results } = await fanOut(selected, async (shop) => {
    const loaded = await loadOffers(db, shop, { types: ["gift"], statuses, offerId: target?.offerId });
    const variantIds = [...new Set(loaded.flatMap((l) => l.rewards.flatMap((r) => {
      const t = (r.target ?? {}) as Record<string, unknown>;
      return ids(t["variantIds"]).concat(typeof t["variantId"] === "string" ? [t["variantId"]] : []);
    })))];
    const catalog = await stockFor(db, shop, variantIds);
    return loaded.map((l) => giftRow(shop, l, catalog));
  });

  const all = results.flatMap((r) => r.value);
  const { page, hasMore, cursor } = paginate(all, args);
  const risky = page.filter((g) => g.stock.soldOut > 0 && g.status === "active");

  const summary = [
    `${all.length} gift offer${all.length === 1 ? "" : "s"}.`,
    ...page.slice(0, 10).map((g) => `- ${g.name} (${g.status}) on ${g.shopDomain}: ${g.threshold ? `from ${g.threshold.currency} ${g.threshold.amount}` : "no cart-value trigger"}, ${g.giftVariants} gift variant(s), ${g.isPicker ? "picker" : g.autoAdd ? "auto-add" : "manual"}, ${g.stock.soldOut} sold out`),
    LIMIT_SEMANTICS,
  ].join("\n");

  return buildResult(
    {
      summary,
      data: { gifts: page },
      perShop,
      links: selected.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
      warnings: risky.map((g) => ({ code: "GIFT_SOLD_OUT", severity: "warn" as const, message: `${g.name} (${g.shopDomain}) is active with ${g.stock.soldOut} sold-out gift variant(s).` })),
      nextActions: page.slice(0, 3).map((g) => ({ mcp: "promo-engine" as const, tool: "promo_detail", args: { ref: g.promoRef }, why: "Full definition of this gift offer.", risk: "read" as const })),
      meta: { page: { ...(cursor ? { cursor } : {}), hasMore } },
    },
    now,
  );
}

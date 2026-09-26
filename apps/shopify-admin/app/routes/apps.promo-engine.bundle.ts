import type { LoaderFunctionArgs } from "react-router";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
  bundleDefinitions,
  bundleSteps,
  bundleTiers,
  offerConditions,
  offers,
  productCache,
  variantCache,
} from "@promo/db";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { proxyRateLimitResponse } from "../lib/proxy-rate-limit.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";
import { isEligibleBundlePage } from "../lib/bundle-page-eligibility.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BUNDLE_VARIANTS = 250;

function cents(raw: string | null): number {
  const parsed = Number.parseFloat(raw ?? "0");
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function sourceIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ids = (value as { productGids?: unknown }).productGids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { id: shopId, currencyCode, db } = await getSignedShop(request);
    const limited = await proxyRateLimitResponse(request, "bundle", shopId, 120);
    if (limited) return limited;
    const requestUrl = new URL(request.url);
    const requestedOfferId = requestUrl.searchParams.get("offer_id")?.trim() || null;
    const requestedPageUrl = requestUrl.searchParams.get("page_url")?.trim() || null;
    if (requestedOfferId && !UUID.test(requestedOfferId)) {
      return apiError(request, {
        status: 400,
        code: "INVALID_OFFER_ID",
        message: "offer_id must be a valid UUID.",
      });
    }

    const [bundle] = await db
      .select({
        offerId: offers.id,
        bundleId: bundleDefinitions.id,
        title: bundleDefinitions.title,
        description: bundleDefinitions.description,
        layoutMode: bundleDefinitions.layoutMode,
      })
      .from(offers)
      .innerJoin(
        bundleDefinitions,
        and(eq(bundleDefinitions.offerId, offers.id), eq(bundleDefinitions.shopId, shopId)),
      )
      .where(
        and(
          eq(offers.shopId, shopId),
          eq(offers.type, "bundle"),
          eq(offers.status, "active"),
          ...(requestedOfferId ? [eq(offers.id, requestedOfferId)] : []),
        ),
      )
      .orderBy(asc(offers.priority), asc(offers.createdAt))
      .limit(1);

    if (!bundle) return apiJson(request, {});

    const [steps, tiers, pageConditions] = await Promise.all([
      db
        .select()
        .from(bundleSteps)
        .where(and(eq(bundleSteps.shopId, shopId), eq(bundleSteps.bundleId, bundle.bundleId)))
        .orderBy(asc(bundleSteps.sortOrder)),
      db
        .select()
        .from(bundleTiers)
        .where(and(eq(bundleTiers.shopId, shopId), eq(bundleTiers.bundleId, bundle.bundleId)))
        .orderBy(asc(bundleTiers.sortOrder)),
      db
        .select({ conditionType: offerConditions.conditionType, value: offerConditions.value })
        .from(offerConditions)
        .where(
          and(
            eq(offerConditions.shopId, shopId),
            eq(offerConditions.offerId, bundle.offerId),
            eq(offerConditions.isEnabled, true),
            inArray(offerConditions.conditionType, ["specific_link", "page_url"]),
          ),
        ),
    ]);
    if (!isEligibleBundlePage(requestedPageUrl, pageConditions)) return apiJson(request, {});
    const selectedIds = [...new Set(steps.flatMap((step) => sourceIds(step.sourceConfig)))];
    const productIds = selectedIds.filter((id) => id.includes("/Product/"));
    const variantIds = selectedIds.filter((id) => id.includes("/ProductVariant/"));
    const targetClauses = [
      ...(productIds.length > 0 ? [inArray(variantCache.productGid, productIds)] : []),
      ...(variantIds.length > 0 ? [inArray(variantCache.variantGid, variantIds)] : []),
    ];
    const variants =
      targetClauses.length === 0
        ? []
        : await db
            .select({
              variantId: variantCache.variantGid,
              productId: variantCache.productGid,
              variantTitle: variantCache.title,
              price: variantCache.price,
              compareAtPrice: variantCache.compareAtPrice,
              availableForSale: variantCache.availableForSale,
              inventoryQuantity: variantCache.inventoryQuantity,
              inventoryPolicy: variantCache.inventoryPolicy,
              title: productCache.title,
              handle: productCache.handle,
              imageUrl: productCache.imageUrl,
              vendor: productCache.vendor,
              productType: productCache.productType,
              tags: productCache.tags,
            })
            .from(variantCache)
            .innerJoin(
              productCache,
              and(
                eq(productCache.shopId, variantCache.shopId),
                eq(productCache.productGid, variantCache.productGid),
              ),
            )
            .where(and(eq(variantCache.shopId, shopId), or(...targetClauses)))
            .orderBy(asc(productCache.title), asc(variantCache.title))
            .limit(MAX_BUNDLE_VARIANTS + 1);
    if (variants.length > MAX_BUNDLE_VARIANTS) {
      return apiError(request, {
        status: 422,
        code: "BUNDLE_TOO_LARGE",
        message: `This bundle resolves to more than ${MAX_BUNDLE_VARIANTS} variants. Narrow its product selection before rendering it.`,
      });
    }

    return apiJson(request, {
      bundleBuilder: {
        offerId: bundle.offerId,
        bundleId: bundle.bundleId,
        title: bundle.title,
        description: bundle.description,
        layoutMode:
          bundle.layoutMode === "one_step_per_page" ? "one_step_per_page" : "all_steps_one_page",
        steps: steps.map((step) => {
          const ids = new Set(sourceIds(step.sourceConfig));
          return {
            id: step.id,
            title: step.title,
            subtitle: step.subtitle,
            minQuantity: step.minQuantity ?? 0,
            maxQuantity: step.maxQuantity,
            searchEnabled: step.searchEnabled,
            products: variants
              .filter((variant) => ids.has(variant.productId) || ids.has(variant.variantId))
              .map((variant) => ({
                variantId: variant.variantId,
                productId: variant.productId,
                title: variant.title,
                variantTitle: variant.variantTitle,
                handle: variant.handle,
                imageUrl: variant.imageUrl,
                priceCents: cents(variant.price),
                compareAtPriceCents: variant.compareAtPrice ? cents(variant.compareAtPrice) : null,
                // availableForSale already covers untracked inventory and oversell policy.
                isAvailable: variant.availableForSale,
                vendor: variant.vendor ?? "",
                productType: variant.productType ?? "",
                tags: variant.tags,
              })),
          };
        }),
        tiers: tiers.map((tier) => {
          const value = tier.value as { amount?: unknown };
          return {
            minQuantity: tier.minQuantity,
            maxQuantity: tier.maxQuantity,
            label: tier.label,
            discountType: tier.discountType,
            discountValue: Number(value.amount ?? 0),
          };
        }),
        currency: currencyCode ?? "USD",
      },
    });
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.bundle");
  }
}

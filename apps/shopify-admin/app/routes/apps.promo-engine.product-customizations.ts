import type { LoaderFunctionArgs } from "react-router";
import { and, eq } from "drizzle-orm";
import { offerRewards, offers, variantCache } from "@promo/db";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { proxyRateLimitResponse } from "../lib/proxy-rate-limit.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

// Storefront endpoints get their own Vercel function (a distinct route config
// splits the server bundle) so a cold start doesn't load the whole admin app.
export const config = { maxDuration: 15 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

interface DiscountTier {
  qty?: number;
  requiredQty?: number;
  label?: string;
  discountType?: string;
  discountValue?: number;
}

function centsFromPrice(raw: string | number | null): number {
  const amount = typeof raw === "number" ? raw : Number.parseFloat(raw ?? "0");
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function discountedCents(originalCents: number, discountType: string, discountValue: number): number {
  if (discountType === "percentage") return Math.max(0, Math.round(originalCents * (1 - discountValue / 100)));
  if (discountType === "fixed_amount") return Math.max(0, originalCents - Math.round(discountValue * 100));
  if (discountType === "fixed_price") return Math.max(0, Math.round(discountValue * 100));
  return originalCents;
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { id: shopId, currencyCode, db } = await getSignedShop(request);
    const limited = await proxyRateLimitResponse(request, "product-customizations", shopId, 240);
    if (limited) return limited;
    const url = new URL(request.url);
    const offerId = url.searchParams.get("offer_id");
    const variantId = url.searchParams.get("variant_id");
    if (!offerId || !variantId) {
      return apiError(request, {
        status: 400,
        code: "MISSING_IDENTIFIERS",
        message: "offer_id and variant_id are required.",
      });
    }
    if (!UUID.test(offerId) || !VARIANT_GID.test(variantId)) {
      return apiError(request, {
        status: 400,
        code: "INVALID_IDENTIFIERS",
        message: "offer_id or variant_id is invalid.",
      });
    }

  const [offer] = await db
    .select({ id: offers.id, type: offers.type })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId), eq(offers.status, "active")))
    .limit(1);
    if (!offer || offer.type !== "discount") {
      return apiJson(request, {});
    }

  const [reward] = await db
    .select()
    .from(offerRewards)
    .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)))
    .limit(1);
  const [variant] = await db
    .select({ price: variantCache.price })
    .from(variantCache)
    .where(and(eq(variantCache.shopId, shopId), eq(variantCache.variantGid, variantId)))
    .limit(1);

  const value = (reward?.value ?? {}) as { tiers?: DiscountTier[] };
  const originalPriceCents = centsFromPrice(variant?.price ?? 0);
  const tiers = (Array.isArray(value.tiers) ? value.tiers : [])
    .map((tier) => {
      const minQuantity = tier.qty ?? tier.requiredQty ?? 1;
      const discountType = tier.discountType ?? "percentage";
      const discountValue = Number.isFinite(tier.discountValue) ? tier.discountValue! : 0;
      return {
        minQuantity,
        label: tier.label ?? "",
        discountType,
        discountValue,
        originalPriceCents,
        discountedPriceCents: discountedCents(originalPriceCents, discountType, discountValue),
      };
    })
    .filter((tier) => tier.minQuantity > 0);

    if (tiers.length === 0) return apiJson(request, {});

    return apiJson(request, {
      volumeDiscount: {
        offerId,
        variantId,
        tiers,
        currency: currencyCode ?? "USD",
      },
    });
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.product-customizations");
  }
}

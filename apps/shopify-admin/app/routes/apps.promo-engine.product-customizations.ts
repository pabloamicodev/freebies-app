import type { LoaderFunctionArgs } from "react-router";
import { and, eq } from "drizzle-orm";
import { offerRewards, offers, variantCache } from "@promo/db";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";

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
  const { id: shopId, currencyCode, db } = await getSignedShop(request);
  const url = new URL(request.url);
  const offerId = url.searchParams.get("offer_id");
  const variantId = url.searchParams.get("variant_id");
  if (!offerId || !variantId) return Response.json({});

  const [offer] = await db
    .select({ id: offers.id, type: offers.type })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId), eq(offers.status, "active")))
    .limit(1);
  if (!offer || offer.type !== "discount") return Response.json({});

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

  if (tiers.length === 0) return Response.json({});

  return Response.json({
    volumeDiscount: {
      offerId,
      variantId,
      tiers,
      currency: currencyCode ?? "USD",
    },
  });
}

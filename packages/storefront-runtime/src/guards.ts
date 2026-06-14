/**
 * Runtime guards — concrete implementations for the pitfalls documented in Section 30.
 *
 * These guards are called by the cart adapter and runtime to handle edge cases
 * that Shopify's APIs exhibit in production.
 */

import type { CartData } from "./cart-adapter.js";

type ShopifyThemeWindow = Window & {
  Shopify?: {
    theme?: {
      sections?: unknown;
    };
  };
};

// ── Pitfall 30.1: Cart line keys change after mutations ───────────────────────

/**
 * Never cache cart line keys across mutations.
 * After every add/update/delete, re-fetch the cart and resolve new keys.
 */
export function resolveLineKey(
  freshCart: CartData,
  variantId: number,
  properties: Record<string, string>,
): string | null {
  // Match by variant ID + all matching properties
  for (const item of freshCart.items) {
    if (item.variant_id !== variantId) continue;
    const propsMatch = Object.entries(properties).every(
      ([k, v]) => item.properties[k] === v,
    );
    if (propsMatch) return item.key;
  }
  return null;
}

/**
 * Find a gift line in the cart by offer ID (not by variant ID or line key).
 * Safe when the same variant appears in multiple lines with different properties.
 */
export function findGiftLineByOfferId(
  cart: CartData,
  offerId: string,
): CartData["items"][number] | null {
  return (
    cart.items.find(
      (item) =>
        item.properties["_promo_engine_line_type"] === "gift" &&
        item.properties["_promo_engine_offer_id"] === offerId,
    ) ?? null
  );
}

// ── Pitfall 30.2: Storefront API cart expiry ──────────────────────────────────

const CART_EXPIRY_DAYS = 10;

export function isCartLikelyExpired(cartCreatedAt: Date): boolean {
  const ageMs = Date.now() - cartCreatedAt.getTime();
  return ageMs > CART_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

// ── Pitfall 30.3: Ajax stale data after rapid mutations ───────────────────────

/**
 * Always re-fetch cart after each batch of mutations.
 * Do NOT use the response from add/change as the source of truth for keys.
 */
export async function fetchFreshCart(): Promise<CartData> {
  const response = await fetch(`${window.Shopify?.routes?.root ?? "/"}cart.js`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Cart fetch failed: ${response.status}`);
  return response.json() as Promise<CartData>;
}

// ── Pitfall 30.4: Cart quantity 0 removes line ────────────────────────────────

/**
 * When setting quantity to 0, the line is removed.
 * Do NOT expect the removed line to appear in the response.
 * After the call, re-fetch cart to get current state.
 */
export const CART_QUANTITY_ZERO_REMOVES_LINE = true;

// ── Pitfall 30.5: Discount class combinations require explicit config ──────────

/**
 * Automatic discounts created without `combinesWith` config default to NO combination.
 * Always explicitly set all three combination flags when creating Shopify discounts.
 */
export interface CombinesWithConfig {
  orderDiscounts: boolean;
  shippingDiscounts: boolean;
  productDiscounts: boolean;
}

export function getDefaultCombinationPolicy(): CombinesWithConfig {
  return {
    orderDiscounts: true,
    shippingDiscounts: true,
    productDiscounts: true,
  };
}

// ── Pitfall 30.6: Multiple product discounts per line (post Apr 30, 2026) ──────

/**
 * As of April 30, 2026, a single Discount Function call can apply
 * multiple product discounts to a single cart line.
 * Pre-2026-04: only one product discount per line was applied.
 * This guard documents the behavior — no code change needed, just awareness.
 */
export const MULTIPLE_PRODUCT_DISCOUNTS_PER_LINE_SUPPORTED = true;

// ── Pitfall 30.7: Cart Transform + Selling Plans ──────────────────────────────

/**
 * Lines with selling plans (subscriptions) are REJECTED by all Cart Transform operations.
 * Check before attempting lineExpand/linesMerge/lineUpdate.
 */
export function canTransformLine(line: { sellingPlanId?: string | null }): boolean {
  return !line.sellingPlanId;
}

// ── Pitfall 30.8: App blocks depend on theme editor placement ─────────────────

/**
 * App block position is controlled by the merchant in the theme editor.
 * We cannot guarantee exact position programmatically.
 * Always provide CSS selector injection as fallback.
 */
export const APP_BLOCK_POSITION_IS_MERCHANT_CONTROLLED = true;

// ── Pitfall 30.9: Section rendering not available in all themes ───────────────

/**
 * Section rendering for cart drawer updates may not be available in all themes.
 * Always provide the manual integration API as fallback:
 *   window.PromoEngine.refreshCart()
 */
export function hasSectionRendering(): boolean {
  try {
    // Check if the theme supports Shopify's section rendering
    return typeof (window as ShopifyThemeWindow).Shopify?.theme?.sections !== "undefined";
  } catch {
    return false;
  }
}

// ── Pitfall 30.10: Gift cards excluded from discountable lines ────────────────

/**
 * Gift card line items must be excluded from:
 * - Cart value threshold calculations
 * - Cheapest/most expensive item selection
 * - Gift qualification eligibility
 */
export function isGiftCardLine(line: { productType?: string; handle?: string }): boolean {
  return (
    line.productType?.toLowerCase() === "gift_card" ||
    line.handle?.includes("gift-card") ||
    line.handle?.includes("gift_card") ||
    false
  );
}

// ── Pitfall 30.11: Draft Order API limitations ────────────────────────────────

/**
 * Draft Order API does NOT support all storefront discount behaviors.
 * Do not use Draft Orders for promotion logic — use Discount Functions instead.
 */
export const DO_NOT_USE_DRAFT_ORDERS_FOR_PROMOTIONS = true;

// ── Pitfall 30.12: POS does not render web widgets ───────────────────────────

/**
 * POS channel does not load storefront JS widgets.
 * Promotions in POS are applied via Discount Function at POS checkout only.
 * Auto-add gifts must be added manually by the POS operator.
 */
export const POS_DOES_NOT_RENDER_WEB_WIDGETS = true;

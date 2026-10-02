/**
 * Store-specific fixtures shared by scripts/seed-ambrosia-e2e.ts (which creates
 * them on hpn-test-store) and the storefront specs (which exercise them).
 * Fixed UUIDs let specs mount widgets for an exact offer without database access.
 */
export const E2E_GIFT_OFFER_NAME = "E2E Gift Offer";
export const E2E_GIFT_ANCHOR_HANDLE = "test-bundle-product";
export const E2E_GIFT_REWARD_HANDLE = "test-gift-product";

export const E2E_VOLUME_OFFER_ID = "e2e00000-0000-4000-8000-000000000001";
export const E2E_VOLUME_OFFER_NAME = "E2E Volume Discount";
export const E2E_VOLUME_PRODUCT_HANDLE = "test-volume-product";
export const E2E_VOLUME_TIERS = [
  { minimumQuantity: 2, discountType: "percentage", discountValue: 10, label: "Buy 2 save 10%" },
  { minimumQuantity: 5, discountType: "percentage", discountValue: 20, label: "Buy 5 save 20%" },
] as const;

export const E2E_BUNDLE_OFFER_ID = "e2e00000-0000-4000-8000-000000000002";
export const E2E_BUNDLE_OFFER_NAME = "E2E Classic Bundle";
export const E2E_BUNDLE_PRODUCT_HANDLES = [
  "6-foundations-to-mens-health-ebook",
  "muscle-growth-system-ebook",
] as const;
export const E2E_BUNDLE_TIER = {
  minimumQuantity: 2,
  discountType: "percentage",
  discountValue: 10,
  label: "Buy 2 save 10%",
} as const;

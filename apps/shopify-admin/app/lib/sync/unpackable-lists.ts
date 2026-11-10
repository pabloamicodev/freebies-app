// Client-safe on purpose: capacity-copy.ts reaches the browser and must not pull in compile-config.
/** Lists that cannot be packed (arrays of objects). `listKind` in capacity numbers indexes this table. */
export const UNPACKABLE_LISTS = [
  ["requirements", "requirements"],
  ["priceTiers", "price tiers"],
  ["quantityTiers", "quantity tiers"],
  ["subtotalTiers", "subtotal tiers"],
  ["pageUrlConditions", "page URL conditions"],
  ["patterns", "page URL patterns"],
  ["giftRewards", "gift rewards"],
  ["productRewards", "product rewards"],
  ["orderRewards", "order rewards"],
  ["lineAttributeConditions", "line attribute conditions"],
  ["cartAttributeConditions", "cart attribute conditions"],
  ["offers", "offers"],
  ["customerTags", "customer tags"],
] as const;

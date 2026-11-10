import { PACKED_OFFER_KEYS, PACKED_REWARD_KEYS, compactId, unpackList } from "./compile-config.js";

const ID_LIST_KEYS = new Set([
  "requiredProductIds",
  "requiredVariantIds",
  "anyRequiredProductIds",
  "anyRequiredVariantIds",
  "excludedProductIds",
  "giftVariantIds",
  "giftProductIds",
  "targetProductIds",
  "targetVariantIds",
  "requiredAnchorVariantIds",
]);
const ID_SCALAR_KEYS = new Set(["productId", "variantId"]);
const LIST_KEYS = new Set([...PACKED_OFFER_KEYS, ...PACKED_REWARD_KEYS]);

/**
 * Canonical form of a compiled offer for semantic comparison: lists published as one comma-joined string
 * (over 100 entries) become arrays again, and numeric (compact) ids become the same form as GIDs, so a shop
 * with function_compact_ids on compares equal to the database copy.
 */
export function normalizeCompiledOffer<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeCompiledOffer) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (LIST_KEYS.has(key) && (Array.isArray(entry) || typeof entry === "string")) {
      const list = unpackList(entry);
      out[key] = ID_LIST_KEYS.has(key) ? list.map(compactId) : list;
    } else if (ID_SCALAR_KEYS.has(key) && typeof entry === "string") {
      out[key] = compactId(entry);
    } else {
      out[key] = normalizeCompiledOffer(entry);
    }
  }
  return out as T;
}

/** Shared by the Conditions page, the gift inline editor and the offer summaries:
 * how a Specific Product / Pack condition matches the cart ("Match by"), the
 * saved shape for each mode, and the in-form explanation. */

export type MatchBy = "variant" | "product";
export type ProductConditionType = "specific_product" | "pack_of_products";

export const MATCH_BY_LABELS: Record<MatchBy, string> = {
  variant: "Exact variants (SKUs)",
  product: "Any variant of the product",
};

/** Existing offers have no marker, so anything that isn't explicitly product-level stays "variant". */
export function readMatchBy(value: unknown): MatchBy {
  const v = (value ?? {}) as Record<string, unknown>;
  const reqs = Array.isArray(v["requirements"]) ? (v["requirements"] as Array<Record<string, unknown>>) : null;
  if (reqs) return reqs.length > 0 && reqs.every((r) => r["trackMode"] === "product") ? "product" : "variant";
  return v["trackMode"] === "product" ? "product" : "variant";
}

/** `gids` are variant GIDs for "variant" mode and product GIDs for "product" mode (deduplicated). */
export function buildProductConditionValue(
  type: ProductConditionType,
  matchBy: MatchBy,
  gids: string[],
  minQty: number,
): Record<string, unknown> {
  const ids = [...new Set(gids)];
  const qty = Math.max(1, minQty);
  const idField = matchBy === "product" ? "productId" : "variantId";
  const qtyField = type === "pack_of_products" ? "quantityPerPack" : "minQuantity";
  return {
    requirements: ids.map((id) => ({ [idField]: id, trackMode: matchBy, [qtyField]: qty })),
    [type === "pack_of_products" ? "multiplyByPacks" : "multiplyByGroups"]: false,
  };
}

/** Selected product GIDs out of a saved product-mode condition (variant mode returns variant GIDs). */
export function requirementGids(value: unknown): string[] {
  const reqs = (value as { requirements?: unknown } | null)?.requirements;
  if (!Array.isArray(reqs)) return [];
  const mode = readMatchBy(value);
  return reqs
    .map((r) => String((r as Record<string, unknown>)[mode === "product" ? "productId" : "variantId"] ?? ""))
    .filter(Boolean);
}

export interface PickedItem {
  variantId?: string;
  productId?: string;
  productTitle: string;
  /** Null/"Default Title" when the product has a single variant. */
  variantTitle?: string | null;
}

function itemName(item: PickedItem, matchBy: MatchBy): string {
  const variant = item.variantTitle && item.variantTitle !== "Default Title" ? item.variantTitle : null;
  return matchBy === "variant" && variant ? `${item.productTitle} (${variant})` : item.productTitle;
}

/** Variants selected per product, for products with more than one selected (variant mode only). */
export function multiVariantProducts(items: PickedItem[]): Array<{ productTitle: string; count: number }> {
  const counts = new Map<string, { productTitle: string; count: number }>();
  for (const item of items) {
    const key = item.productId ?? item.productTitle;
    const entry = counts.get(key) ?? { productTitle: item.productTitle, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].filter((entry) => entry.count > 1);
}

export function packVariantHint(items: PickedItem[]): string | null {
  const [first] = multiVariantProducts(items);
  if (!first) return null;
  return `You selected ${first.count} variants of ${first.productTitle}; all ${first.count} are required. Switch to 'Any variant of the product' if any variant should count.`;
}

export function productConditionHelp(args: {
  type: ProductConditionType;
  matchBy: MatchBy;
  minQty: number;
  items: PickedItem[];
}): { lines: string[]; example: string | null } {
  const { type, matchBy, items } = args;
  const qty = Math.max(1, args.minQty || 1);
  const lines = [
    matchBy === "variant"
      ? "Exact variants: each pick is one specific variant (SKU). Other variants of the same product don't count toward it."
      : "Any variant of the product: any variant counts, and quantities add up across all of that product's variants.",
    type === "pack_of_products"
      ? `Every product in the pack must be in the cart, at the min quantity each (all-of). A full set is one pack.`
      : `Every selected ${matchBy === "variant" ? "variant" : "product"} must be in the cart, at the min quantity each (all-of), not just one of them.`,
    "Other products can also be in the cart; this doesn't require the cart to contain only these.",
    "Which items get the discount is set in Rewards.",
  ];
  const names = items.map((item) => itemName(item, matchBy));
  if (names.length === 0) return { lines, example: null };
  const shown = names.slice(0, 3);
  const more = names.length > shown.length ? ` and ${names.length - shown.length} more` : "";
  const suffix = matchBy === "product" ? " (any variant)" : "";
  const needs = shown.map((n) => `${qty} ${n}${suffix}`).join(" AND ") + more;
  const example = names.length === 1
    ? `Example: with ${shown[0]} at min ${qty}, the cart needs at least ${qty} ${shown[0]}${suffix}.`
    : `Example: with ${shown.join(" and ")}${more} at min ${qty}, the cart needs at least ${needs}.`;
  return { lines, example };
}

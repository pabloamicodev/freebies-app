import type { NormalizedCart, NormalizedCartLine } from "@promo/shared-types";

/**
 * `__landing_source` tags whose lines only offers scoped to that same tag (a `landing` reward requiring it) see:
 * every other offer ignores them for thresholds, quantities, anchors and rewards. Mirrors EXCLUSIVE_LANDING_SOURCES
 * (discount Functions, page_match.rs).
 */
export const EXCLUSIVE_LANDING_SOURCES: readonly string[] = ["protein-edu-lp"];

const LANDING_KEY = "__landing_source";
const METADATA_KEY = "_promo_engine_metadata";

/** The line's `__landing_source`: the direct property, else the packed metadata (the Function reads it the same way). */
export function landingSourceOf(properties: Readonly<Record<string, string>>): string | undefined {
  const direct = properties[LANDING_KEY];
  if (typeof direct === "string") return direct;
  const packed = properties[METADATA_KEY];
  if (typeof packed !== "string" || !packed.includes(LANDING_KEY)) return undefined;
  try {
    const value: unknown = (JSON.parse(packed) as Record<string, unknown> | null)?.[LANDING_KEY];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The landing tags an offer is scoped to: the `requiredLineAttributeValue` of its landing rewards. */
export function landingScopesOf(rewards: ReadonlyArray<{ target?: unknown }>): Set<string> {
  const scopes = new Set<string>();
  for (const reward of rewards) {
    const target = (reward.target ?? {}) as { scopeMode?: unknown; requiredLineAttributeValue?: unknown };
    if (target.scopeMode === "landing" && typeof target.requiredLineAttributeValue === "string") scopes.add(target.requiredLineAttributeValue);
  }
  return scopes;
}

/** The line carries an exclusive landing tag outside `scopes`: the offer never sees it. */
export function hiddenFromScopes(scopes: ReadonlySet<string>, source: string | undefined): boolean {
  return source !== undefined && EXCLUSIVE_LANDING_SOURCES.includes(source) && !scopes.has(source);
}

const lineValueCents = (line: NormalizedCartLine) => line.originalLineSubtotalCents ?? line.priceCents * line.quantity;

/** The cart as an offer scoped to `scopes` sees it; the same object when no line is hidden. */
export function visibleCart(cart: NormalizedCart, scopes: ReadonlySet<string>): NormalizedCart {
  const hidden = cart.lines.filter((line) => hiddenFromScopes(scopes, landingSourceOf(line.properties)));
  if (hidden.length === 0) return cart;
  return {
    ...cart,
    lines: cart.lines.filter((line) => !hidden.includes(line)),
    subtotalCents: Math.max(0, cart.subtotalCents - hidden.reduce((sum, line) => sum + lineValueCents(line), 0)),
    totalQuantity: Math.max(0, cart.totalQuantity - hidden.reduce((sum, line) => sum + line.quantity, 0)),
  };
}

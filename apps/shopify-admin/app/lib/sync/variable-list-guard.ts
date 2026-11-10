import {
  findOversizeList,
  listKindOf,
  serializeFunctionConfig,
  SHOPIFY_VARIABLE_LIST_LIMIT,
  type CompiledFunctionConfig,
  type CompiledOffer,
} from "./compile-config.js";
import { buildAttributeQueryVariables } from "./attribute-query-variables.js";
import { ShardPlanBlockedError } from "./cart-shards.server.js";

/**
 * Last line of defence before a function_config metafield is written: Shopify fails input resolution for the
 * whole node when any array in it is over the limit, so such a config must never replace the live one.
 * Delivery nodes have no input variables, which is why their `shippingOffers` are not walked.
 */
export function assertVariableListsWithinLimit(value: string): void {
  const config = JSON.parse(value) as { offers?: Array<{ id?: unknown }> };
  const walk = (node: unknown, key: string, offerIndex: number | null): void => {
    if (Array.isArray(node)) {
      if (node.length > SHOPIFY_VARIABLE_LIST_LIMIT) {
        const offerId = offerIndex === null ? undefined : config.offers?.[offerIndex]?.id;
        throw new ShardPlanBlockedError({
          code: "OFFER_TOO_LARGE",
          unitKeys: typeof offerId === "string" ? [offerId] : [],
          reason: "lists",
          numbers: { listKind: listKindOf(key), listCount: node.length, listLimit: SHOPIFY_VARIABLE_LIST_LIMIT },
        });
      }
      node.forEach((item, index) => walk(item, key, key === "offers" ? index : offerIndex));
    } else if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node)) if (childKey !== "shippingOffers") walk(child, childKey, offerIndex);
    }
  };
  walk(config, "", null);
}

/** Union of the offer's required and excluded customer tags: the `customerTags` query variable of its node. */
export const offerCustomerTags = (offer: CompiledOffer): string[] =>
  [...new Set([...(offer.requiredCustomerTags ?? []), ...(offer.excludedCustomerTags ?? [])])].sort();

/** The single-offer config a code node carries (a delivery node only carries shippingOffers). */
export function buildCodeOfferConfig(
  compiledOffer: CompiledOffer,
  conditionRows: Parameters<typeof buildAttributeQueryVariables>[0],
  shippingOffers: CompiledFunctionConfig["shippingOffers"],
  kind: "cart" | "delivery",
  compiledAt: string,
): CompiledFunctionConfig {
  const customerTags = offerCustomerTags(compiledOffer);
  return {
    offers: kind === "delivery" ? [] : [compiledOffer],
    shippingOffers,
    version: "1",
    compiledAt,
    ...(customerTags.length > 0 ? { customerTags } : {}),
    ...buildAttributeQueryVariables(conditionRows),
  };
}

/**
 * Refuses a code offer whose config would carry a list over the limit, before any node is created or written.
 * Delivery nodes have no input variables, so there is nothing to check for them.
 */
export function assertCodeOfferListsWithinLimit(
  compiledOffer: CompiledOffer,
  conditionRows: Parameters<typeof buildAttributeQueryVariables>[0],
  kind: "cart" | "delivery",
): void {
  if (kind === "delivery") return;
  const oversize = findOversizeList(compiledOffer);
  if (oversize) {
    throw new ShardPlanBlockedError({
      code: "OFFER_TOO_LARGE",
      unitKeys: [compiledOffer.id],
      reason: "lists",
      numbers: { ...oversize, listLimit: SHOPIFY_VARIABLE_LIST_LIMIT },
    });
  }
  try {
    assertVariableListsWithinLimit(
      serializeFunctionConfig(buildCodeOfferConfig(compiledOffer, conditionRows, [], kind, "1970-01-01T00:00:00.000Z")),
    );
  } catch (error) {
    // A top-level list (customerTags) has no offer index, so the guard cannot name the offer; this node holds just one.
    if (error instanceof ShardPlanBlockedError && error.blocked.unitKeys.length === 0) {
      throw new ShardPlanBlockedError({ ...error.blocked, unitKeys: [compiledOffer.id] });
    }
    throw error;
  }
}

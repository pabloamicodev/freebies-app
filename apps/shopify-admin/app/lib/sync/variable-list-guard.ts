import { listKindOf, SHOPIFY_VARIABLE_LIST_LIMIT } from "./compile-config.js";
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

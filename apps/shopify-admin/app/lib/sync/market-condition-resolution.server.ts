import type { OfferCondition } from "@promo/db";
import { MarketConditionValueSchema } from "@promo/shared-types";
import type { ShopifyMarket } from "./market-sync.server.js";

function uniqueCountryCodes(markets: ShopifyMarket[]): string[] {
  return [
    ...new Set(markets.flatMap((market) => market.countryCodes.map((code) => code.toUpperCase()))),
  ].sort();
}

/**
 * Shopify Functions exposes the buyer's country, not the Admin Market GID.
 * Regional Markets have an authoritative country mapping in Admin GraphQL, so
 * resolve that mapping immediately before publishing and fail closed if it is
 * incomplete or stale.
 */
export function resolveMarketConditionsToCountries(
  conditions: OfferCondition[],
  markets: ShopifyMarket[],
): OfferCondition[] {
  const marketById = new Map(markets.map((market) => [market.id, market]));

  return conditions.map((condition) => {
    if (
      !condition.isEnabled ||
      (condition.scope !== "main" && condition.scope !== "sub") ||
      condition.conditionType !== "markets"
    )
      return condition;

    const parsed = MarketConditionValueSchema.safeParse(condition.value);
    if (!parsed.success) {
      throw new Error(
        `Market condition ${condition.id} is invalid: ${parsed.error.issues[0]?.message ?? "invalid value"}.`,
      );
    }

    const resolve = (ids: string[], mode: "included" | "excluded") =>
      ids.map((id) => {
        const market = marketById.get(id);
        if (!market)
          throw new Error(
            `Market condition ${condition.id} references unknown ${mode} Market ${id}. Refresh Markets and update the offer.`,
          );
        if (!market.enabled)
          throw new Error(
            `Market condition ${condition.id} references inactive ${mode} Market ${market.name} (${id}).`,
          );
        if (market.countryCodes.length === 0)
          throw new Error(
            `Market ${market.name} (${id}) has no country regions and cannot be enforced safely at checkout.`,
          );
        return market;
      });

    const includeMarkets = resolve(parsed.data.includeMarketIds, "included");
    const excludeMarkets = resolve(parsed.data.excludeMarketIds, "excluded");
    return {
      ...condition,
      conditionType: "customer_location",
      value: {
        includeCountryCodes: uniqueCountryCodes(includeMarkets),
        excludeCountryCodes: uniqueCountryCodes(excludeMarkets),
      },
    };
  });
}

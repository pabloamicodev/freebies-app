/**
 * Storefront-side gate for offers that own discount codes: such an offer only
 * qualifies while one of its (currently redeemable) codes is applied to the
 * cart. Codes never leave the server, so the gate is resolved here and handed
 * to the rule engine as an ordinary `discount_code` condition: one that passes
 * with the matched code, or can never pass. A failed gate disqualifies the
 * offer, which is also what removes its gifts when the code is removed.
 */
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { discountCodes, offers, type Db } from "@promo/db";
import type { OfferDefinition } from "@promo/rule-engine";
import { isCodeRedeemable } from "./discount-code-generation.js";

type DefinitionCondition = OfferDefinition["conditions"][number];

export function codeGateCondition(matchedCode: string | null): DefinitionCondition {
  return {
    id: "code-gate",
    scope: "main",
    conditionType: "discount_code",
    operator: "eq",
    // An empty code can never equal an entered one (entered codes are non-empty).
    value: { code: matchedCode ?? "" },
    isEnabled: true,
    sortOrder: -1,
  } as DefinitionCondition;
}

export async function applyCodeGates(
  shopId: string,
  db: Db,
  definitions: OfferDefinition[],
  appliedCodes: string[],
  now: Date = new Date(),
): Promise<OfferDefinition[]> {
  if (definitions.length === 0) return definitions;
  const offerIds = definitions.map((definition) => definition.id);
  const entered = [
    ...new Set(appliedCodes.map((code) => code.trim().toUpperCase()).filter((code) => code.length > 0)),
  ];

  const [owners, legacy, matches] = await Promise.all([
    db
      .selectDistinct({ offerId: discountCodes.offerId })
      .from(discountCodes)
      .where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.offerId, offerIds))),
    db
      .select({ id: offers.id, code: offers.requiredDiscountCode })
      .from(offers)
      .where(
        and(
          eq(offers.shopId, shopId),
          inArray(offers.id, offerIds),
          // requiresCode keeps a duplicate (or an offer whose codes are all gone) gated.
          or(isNotNull(offers.requiredDiscountCode), eq(offers.requiresCode, true)),
        ),
      ),
    entered.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(discountCodes)
          .where(
            and(
              eq(discountCodes.shopId, shopId),
              inArray(discountCodes.offerId, offerIds),
              inArray(discountCodes.code, entered),
            ),
          ),
  ]);

  const gated = new Set([...owners.map((row) => row.offerId), ...legacy.map((row) => row.id)]);
  if (gated.size === 0) return definitions;
  const matchedByOffer = new Map<string, string>();
  for (const row of matches) {
    if (isCodeRedeemable(row, now)) matchedByOffer.set(row.offerId, row.code);
  }
  for (const row of legacy) {
    const code = row.code?.trim().toUpperCase();
    if (code && entered.includes(code) && !matchedByOffer.has(row.id)) matchedByOffer.set(row.id, code);
  }

  return definitions.map((definition) =>
    gated.has(definition.id)
      ? {
          ...definition,
          conditions: [codeGateCondition(matchedByOffer.get(definition.id) ?? null), ...definition.conditions],
        }
      : definition,
  );
}

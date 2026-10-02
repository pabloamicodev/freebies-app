/**
 * Storefront-side gate for offers that own discount codes: such an offer only
 * qualifies while one of its (currently redeemable) codes is applied to the
 * cart. Codes never leave the server, so the gate is resolved here and handed
 * to the rule engine as an ordinary `discount_code` condition: one that passes
 * with the matched code, or can never pass. A failed gate disqualifies the
 * offer, which is also what removes its gifts when the code is removed.
 *
 * The gate answers "is this code valid?", so it is also a guessing oracle. Guards:
 *  - at most MAX_ENTERED_CODES distinct codes are looked at per evaluation;
 *  - codes that exist nowhere in the shop count as misses against a per-visitor limit, and
 *    once that limit is spent a call that includes misses matches nothing at all.
 */
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { discountCodes, offers, type Db } from "@promo/db";
import type { OfferDefinition } from "@promo/rule-engine";
import { isCodeRedeemable } from "./discount-code-generation.js";
import { checkRateLimit } from "./rate-limit.server.js";

type DefinitionCondition = OfferDefinition["conditions"][number];

/** More codes than a shopper could legitimately stack (Shopify itself allows 5 per cart). */
export const MAX_ENTERED_CODES = 5;
export const MISSED_CODE_LIMIT = 10;
export const MISSED_CODE_WINDOW_MS = 10 * 60_000;

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

/** Trimmed, uppercased, de-duplicated, empty ones dropped, and cut to the first MAX_ENTERED_CODES. */
export function normalizeEnteredCodes(appliedCodes: string[]): { codes: string[]; truncated: boolean } {
  const all = [
    ...new Set(appliedCodes.map((code) => code.trim().toUpperCase()).filter((code) => code.length > 0)),
  ];
  return { codes: all.slice(0, MAX_ENTERED_CODES), truncated: all.length > MAX_ENTERED_CODES };
}

export interface CodeGateOptions {
  /**
   * Identifies the visitor for the missed-code limit (cart token, or the signed customer id).
   * Without it no limit is applied, because a shared key would let one visitor lock everyone out.
   */
  rateLimitKey?: string | undefined;
  /** Test seam; defaults to the shared Redis/DB-backed limiter. */
  rateLimiter?: typeof checkRateLimit;
}

export interface CodeGateResult {
  definitions: OfferDefinition[];
  /** The visitor spent their missed-code budget: nothing was matched this time. */
  blocked: boolean;
  /** More than MAX_ENTERED_CODES codes were sent; the extra ones were ignored. */
  truncated: boolean;
}

export async function applyCodeGatesDetailed(
  shopId: string,
  db: Db,
  definitions: OfferDefinition[],
  appliedCodes: string[],
  now: Date = new Date(),
  options: CodeGateOptions = {},
): Promise<CodeGateResult> {
  if (definitions.length === 0) return { definitions, blocked: false, truncated: false };
  const offerIds = definitions.map((definition) => definition.id);
  const { codes: entered, truncated } = normalizeEnteredCodes(appliedCodes);

  const [gatedOffers, known] = await Promise.all([
    // `requiresCode` is set whenever an offer gets a code (and by the 0018 backfill for older
    // ones), so no scan of the codes table is needed to know which offers are gated.
    db
      .select({ id: offers.id, code: offers.requiredDiscountCode })
      .from(offers)
      .where(
        and(
          eq(offers.shopId, shopId),
          inArray(offers.id, offerIds),
          or(isNotNull(offers.requiredDiscountCode), eq(offers.requiresCode, true)),
        ),
      ),
    // Any offer's code, not just this evaluation's: a code of the shop is not a "miss".
    entered.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(discountCodes)
          .where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.code, entered))),
  ]);

  let blocked = false;
  if (entered.length > 0 && options.rateLimitKey) {
    const knownCodes = new Set(known.map((row) => row.code));
    for (const row of gatedOffers) if (row.code) knownCodes.add(row.code.trim().toUpperCase());
    let missed = entered.filter((code) => !knownCodes.has(code));
    if (missed.length > 0) {
      // A legacy checkout code on an offer outside this evaluation is still a real code.
      const otherLegacy = await db
        .select({ code: offers.requiredDiscountCode })
        .from(offers)
        .where(and(eq(offers.shopId, shopId), inArray(offers.requiredDiscountCode, missed)));
      const otherCodes = new Set(otherLegacy.map((row) => row.code));
      missed = missed.filter((code) => !otherCodes.has(code));
    }
    const limiter = options.rateLimiter ?? checkRateLimit;
    for (let i = 0; i < missed.length; i += 1) {
      const verdict = await limiter(`code-miss:${shopId}:${options.rateLimitKey}`, {
        limit: MISSED_CODE_LIMIT,
        windowMs: MISSED_CODE_WINDOW_MS,
      });
      if (!verdict.ok) {
        blocked = true;
        break;
      }
    }
  }

  const gated = new Set(gatedOffers.map((row) => row.id));
  if (gated.size === 0) return { definitions, blocked, truncated };
  const matchedByOffer = new Map<string, string>();
  if (!blocked) {
    const inThisEvaluation = new Set(offerIds);
    for (const row of known) {
      if (inThisEvaluation.has(row.offerId) && isCodeRedeemable(row, now)) matchedByOffer.set(row.offerId, row.code);
    }
    for (const row of gatedOffers) {
      const code = row.code?.trim().toUpperCase();
      if (code && entered.includes(code) && !matchedByOffer.has(row.id)) matchedByOffer.set(row.id, code);
    }
  }

  return {
    definitions: definitions.map((definition) =>
      gated.has(definition.id)
        ? {
            ...definition,
            conditions: [codeGateCondition(matchedByOffer.get(definition.id) ?? null), ...definition.conditions],
          }
        : definition,
    ),
    blocked,
    truncated,
  };
}

export async function applyCodeGates(
  shopId: string,
  db: Db,
  definitions: OfferDefinition[],
  appliedCodes: string[],
  now: Date = new Date(),
  options: CodeGateOptions = {},
): Promise<OfferDefinition[]> {
  return (await applyCodeGatesDetailed(shopId, db, definitions, appliedCodes, now, options)).definitions;
}

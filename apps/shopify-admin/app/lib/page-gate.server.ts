import { isPageConditionType, lineMatchesPageConditions } from "@promo/rule-engine";
import { PROMO_PAGE_URL_KEY, sanitizeProspective } from "@promo/shared-types";

type Condition = { conditionType: string; value: unknown };

/**
 * The one verdict every endpoint gives on "would a line added now match this offer's page conditions":
 * the same lineMatchesPageConditions the evaluator and the Functions parity fixtures use. Offers without an
 * enabled page condition are not gated (null). A malformed condition value fails closed.
 */
export function pageGateVerdict(conditions: Array<Condition & { isEnabled?: boolean }>, prospective: Record<string, string>): boolean | null {
  const page = conditions.filter((c) => c.isEnabled !== false && isPageConditionType(c.conditionType));
  if (page.length === 0) return null;
  try {
    return lineMatchesPageConditions(prospective, page);
  } catch {
    return false;
  }
}

/** `{ [offerId]: boolean }` for the offers that have at least one enabled page condition. */
export function buildPageGate(
  offers: Array<{ id: string; conditions: Array<Condition & { isEnabled: boolean }> }>,
  prospective: Record<string, string> | undefined,
): Record<string, boolean> {
  const gate: Record<string, boolean> = {};
  for (const offer of offers) {
    const verdict = pageGateVerdict(offer.conditions, prospective ?? {});
    if (verdict !== null) gate[offer.id] = verdict;
  }
  return gate;
}

/**
 * Context of a proxy GET: `ctx` (base64url JSON of the stamp map) wins; an older block that only sends
 * `page_url` becomes `{ _promo_page_url }`, so the newer conditions (template, section, experiment) fail closed.
 */
export function prospectiveFromQuery(ctx: string | null | undefined, pageUrl: string | null | undefined): Record<string, string> {
  if (ctx) {
    try {
      return sanitizeProspective(JSON.parse(Buffer.from(ctx, "base64url").toString("utf8")));
    } catch {
      return {};
    }
  }
  return pageUrl ? { [PROMO_PAGE_URL_KEY]: pageUrl } : {};
}

import type { EligibilityReason, NormalizedCartLine } from "@promo/shared-types";
import { resolveRejectUnmatchedLines, type Result } from "@promo/shared-types";
import { evaluateUrlParam, type UrlParamConditionValue } from "./conditions/url-param.js";
import { evaluatePageUrl, type PageUrlConditionValue } from "./conditions/page-url.js";
import {
  evaluatePageTypes,
  evaluateUtmParameters,
  type PageTypesConditionValue,
  type UtmParametersConditionValue,
} from "./conditions/page-context.js";

export const PAGE_CONDITION_TYPES = ["page_url", "specific_link", "utm_parameters", "page_types"] as const;
export type PageConditionType = (typeof PAGE_CONDITION_TYPES)[number];

export function isPageConditionType(conditionType: string): conditionType is PageConditionType {
  return (PAGE_CONDITION_TYPES as readonly string[]).includes(conditionType);
}

const PAGE_KEY = "_promo_page_url";
const LANDING_KEY = "_promo_landing_url";

type Check = Result<EligibilityReason, EligibilityReason>;

interface PageCondition {
  conditionType: PageConditionType;
  urlKey: typeof PAGE_KEY | typeof LANDING_KEY;
  check: (url: string | null) => Check;
}

function toPageCondition(conditionType: PageConditionType, value: unknown): PageCondition {
  switch (conditionType) {
    case "specific_link":
      return { conditionType, urlKey: PAGE_KEY, check: (url) => evaluateUrlParam(url, value as UrlParamConditionValue) };
    case "page_url":
      return { conditionType, urlKey: PAGE_KEY, check: (url) => evaluatePageUrl(url, value as PageUrlConditionValue) };
    case "page_types":
      return { conditionType, urlKey: PAGE_KEY, check: (url) => evaluatePageTypes(url, value as PageTypesConditionValue) };
    case "utm_parameters": {
      const utm = value as UtmParametersConditionValue;
      return {
        conditionType,
        urlKey: utm.scope === "visit" ? LANDING_KEY : PAGE_KEY,
        check: (url) => evaluateUtmParameters(url, utm),
      };
    }
  }
}

/** Decision D1: a line matches when it carries `_promo_page_url` and satisfies ALL
 * of the offer's page conditions (visit-scoped UTM reads `_promo_landing_url`). */
function lineChecks(properties: Record<string, string>, conditions: PageCondition[]): Check[] | null {
  if (typeof properties[PAGE_KEY] !== "string") return null;
  const results = conditions.map((condition) => {
    const url = properties[condition.urlKey];
    return condition.check(typeof url === "string" ? url : null);
  });
  return results;
}

export function lineMatchesPageConditions(
  properties: Record<string, string>,
  conditions: Array<{ conditionType: string; value: unknown }>,
): boolean {
  const page = conditions.flatMap((c) => (isPageConditionType(c.conditionType) ? [toPageCondition(c.conditionType, c.value)] : []));
  const results = lineChecks(properties, page);
  return results !== null && results.every((result) => result.ok);
}

function isAppAddedUpsell(line: NormalizedCartLine): boolean {
  return line.properties["_promo_engine_line_type"] === "upsell";
}

/**
 * Offer-level page gate (D1). `nonGiftLines` are the cart lines that are not gifts. Lines whose
 * product is excluded by the offer are ignored in both modes. Exclude mode needs
 * at least one matched line; reject mode (any page condition sets
 * `rejectUnmatchedLines`) also needs every line to match, app-added upsell lines
 * being exempt from that second check.
 */
export function evaluatePageConditionGroup(
  conditions: Array<{ conditionType: string; value: unknown }>,
  nonGiftLines: NormalizedCartLine[],
  excludedProductIds?: ReadonlySet<string>,
): { passed: boolean; reasons: EligibilityReason[] } {
  const page = conditions.flatMap((c) => (isPageConditionType(c.conditionType) ? [toPageCondition(c.conditionType, c.value)] : []));
  if (page.length === 0) return { passed: true, reasons: [] };

  const reject = conditions.some(
    (c) =>
      isPageConditionType(c.conditionType) &&
      resolveRejectUnmatchedLines((c.value as { rejectUnmatchedLines?: unknown } | null)?.rejectUnmatchedLines),
  );
  const lines = nonGiftLines.filter((line) => line.quantity > 0 && !excludedProductIds?.has(line.productId));

  let firstMatch: Check[] | null = null;
  let firstFailure: EligibilityReason | null = null;
  const noPage = (): EligibilityReason => ({
    conditionType: page[0]!.conditionType,
    passed: false,
    message: "No page URL available in evaluation context",
  });
  let unmatchedLine: NormalizedCartLine | null = null;
  for (const line of lines) {
    const results = lineChecks(line.properties, page);
    const failed = results?.find((result) => !result.ok);
    if (results && !failed) {
      firstMatch ??= results;
    } else {
      firstFailure ??= failed && !failed.ok ? failed.error : noPage();
      if (!isAppAddedUpsell(line)) unmatchedLine ??= line;
    }
  }

  if (!firstMatch) {
    return { passed: false, reasons: [firstFailure ?? noPage()] };
  }
  if (reject && unmatchedLine) {
    const failure = lineChecks(unmatchedLine.properties, page)?.find((result) => !result.ok);
    return {
      passed: false,
      reasons: [
        failure && !failure.ok
          ? { ...failure.error, message: `Line ${unmatchedLine.key}: ${failure.error.message}` }
          : {
              conditionType: page[0]!.conditionType,
              passed: false,
              message: `Line ${unmatchedLine.key} was not added from a matching page`,
            },
      ],
    };
  }
  return { passed: true, reasons: firstMatch.map((result) => (result.ok ? result.value : result.error)) };
}


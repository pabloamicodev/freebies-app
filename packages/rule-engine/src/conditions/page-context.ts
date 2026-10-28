import type { EligibilityReason, PageType } from "@promo/shared-types";
import {
  ok,
  err,
  asciiLower,
  normalizeExcludedPageUrls,
  normalizeStorePageUrls,
  percentDecode,
  queryValueMatches,
  readQueryParam,
  splitPageUrl,
  type Result,
} from "@promo/shared-types";

const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/;

function pathOf(url: string): string {
  return asciiLower(splitPageUrl(url).path);
}

/**
 * Shopify storefront page kind of a URL or path, ignoring a leading locale
 * segment (`/en`, `/fr-ca`). Mirrors `page_type` in the discount Function's
 * discount_logic.rs; null for anything else (account, policies, apps, ...).
 */
export function classifyPageType(url: string): PageType | null {
  const segments = pathOf(url).split("/").filter(Boolean);
  if (segments[0] && LOCALE_SEGMENT.test(segments[0])) segments.shift();
  switch (segments[0]) {
    case undefined:
      return "home";
    case "products":
      return "product";
    case "collections":
      return segments[2] === "products" ? "product" : "collection";
    case "search":
      return "search";
    case "pages":
      return "page";
    case "blogs":
      return "blog";
    case "cart":
      return "cart";
    default:
      return null;
  }
}

export interface PageTypesConditionValue {
  pageTypes: PageType[];
  pageUrls?: string[];
  excludeUrls?: string[];
}

/** Whether a "page"-type condition with a URL list lets this path through (no list: any page). */
function pageUrlListed(url: string, pageUrls: readonly string[]): boolean {
  const current = pathOf(url).replace(/\/+$/, "");
  return pageUrls.includes(current);
}

/** Whether the path, or the path without its locale segment, is on the exclude list. Mirrors `page_excluded` in page_match.rs. */
function pageExcluded(url: string, excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false;
  const path = asciiLower(percentDecode(splitPageUrl(url).path, false)).replace(/\/+$/, "");
  const segments = path.split("/");
  const unprefixed = segments[1] && LOCALE_SEGMENT.test(segments[1]) ? `/${segments.slice(2).join("/")}` : path;
  return excluded.includes(path) || excluded.includes(unprefixed);
}

export function evaluatePageTypes(
  requestedUrl: string | null,
  condition: PageTypesConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  if (!requestedUrl) {
    return err({
      conditionType: "page_types",
      passed: false,
      message: "No page URL available in evaluation context",
    });
  }
  const pageType = classifyPageType(requestedUrl);
  const required = (condition.pageTypes ?? []).join(" | ");
  const urls = condition.pageTypes?.includes("page") ? normalizeStorePageUrls(condition.pageUrls) : [];
  const excluded = pageExcluded(requestedUrl, normalizeExcludedPageUrls(condition.excludeUrls));
  const allowed =
    !excluded &&
    (urls.length === 0
      ? !!pageType && !!condition.pageTypes?.includes(pageType)
      : (!!pageType && pageType !== "page" && condition.pageTypes.includes(pageType)) || pageUrlListed(requestedUrl, urls));
  if (!allowed) {
    return err({
      conditionType: "page_types",
      passed: false,
      message: `Page "${requestedUrl}" is ${pageType ?? "not a classified page type"}`,
      actual: pageType,
      required,
    });
  }
  return ok({
    conditionType: "page_types",
    passed: true,
    message: `Page "${requestedUrl}" is a ${pageType} page`,
    actual: pageType,
  });
}

export type StampConditionType = "template" | "section_shown" | "experiment";

/**
 * Template / section / experiment stamp check. `raw` is the line's comma-separated
 * `[@]<ref>` list; matches when ANY entry equals ANY ref (ASCII case-insensitive).
 * With `pageOnly`, only `@` entries (seen on the page the line was added on) count.
 * Mirrors `stamp_matches` in the discount Function's page_match.rs.
 */
export function evaluateStampList(
  conditionType: StampConditionType,
  raw: string | null,
  refs: readonly string[],
  pageOnly: boolean,
): Result<EligibilityReason, EligibilityReason> {
  const required = refs.join(" | ");
  if (!raw) {
    return err({ conditionType, passed: false, message: "No page stamp recorded for this line", required });
  }
  const wanted = new Set(refs.map(asciiLower));
  for (const entry of raw.split(",")) {
    const current = entry.startsWith("@");
    const name = current ? entry.slice(1) : entry;
    if (name !== "" && (current || !pageOnly) && wanted.has(asciiLower(name))) {
      return ok({ conditionType, passed: true, message: `Matched "${name}"`, actual: name });
    }
  }
  return err({
    conditionType,
    passed: false,
    message: pageOnly ? "No match on the page the line was added from" : "No match in this visit",
    actual: raw,
    required,
  });
}

export interface UtmParametersConditionValue {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  scope?: "page" | "visit";
}

export function evaluateUtmParameters(
  url: string | null,
  condition: UtmParametersConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  if (!url) {
    return err({
      conditionType: "utm_parameters",
      passed: false,
      message:
        condition.scope === "visit"
          ? "No UTM landing URL recorded for this visit"
          : "No page URL available in evaluation context",
    });
  }
  const fields: Array<[string, string | undefined]> = [
    ["utm_source", condition.utmSource],
    ["utm_medium", condition.utmMedium],
    ["utm_campaign", condition.utmCampaign],
    ["utm_term", condition.utmTerm],
    ["utm_content", condition.utmContent],
  ];
  for (const [name, expected] of fields) {
    if (!expected) continue;
    const actual = readQueryParam(splitPageUrl(url).query, name);
    if (actual === null || !queryValueMatches(name, actual, expected)) {
      return err({
        conditionType: "utm_parameters",
        passed: false,
        message: `${name}=${actual ?? "(missing)"}, expected ${expected}`,
        actual,
        required: expected,
      });
    }
  }
  return ok({
    conditionType: "utm_parameters",
    passed: true,
    message: "UTM parameters match",
    actual: url,
  });
}

import type { EligibilityReason, PageType } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";

const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/;

function pathOf(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Already a path (+ query), as stamped by the storefront.
  }
  return (path.split(/[?#]/)[0] ?? "").toLowerCase();
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
  if (!pageType || !condition.pageTypes?.includes(pageType)) {
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

export interface UtmParametersConditionValue {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  scope?: "page" | "visit";
}

/** Raw (still percent-encoded) query value, compared like the Function does. */
function rawQueryParam(url: string, name: string): string | null {
  const query = url.split("?")[1]?.split("#")[0] ?? "";
  for (const pair of query.split("&")) {
    const index = pair.indexOf("=");
    const key = index === -1 ? pair : pair.slice(0, index);
    if (key === name) return index === -1 ? "" : pair.slice(index + 1);
  }
  return null;
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
    const actual = rawQueryParam(url, name);
    if (actual !== encodeURIComponent(expected)) {
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

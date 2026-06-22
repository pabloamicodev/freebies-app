import type { EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";

export interface PageUrlConditionValue {
  /** URL path patterns to match against (OR logic — any match passes). */
  patterns: string[];
  matchMode: "exact" | "contains" | "starts_with" | "ends_with";
  caseSensitive: boolean;
}

/**
 * Page URL condition.
 * The offer only activates when the buyer is on a storefront page whose
 * pathname matches at least one of the configured patterns.
 * `requestedUrl` comes from `window.location.href` via the storefront runtime.
 */
export function evaluatePageUrl(
  requestedUrl: string | null,
  condition: PageUrlConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  if (!requestedUrl) {
    return err({
      conditionType: "page_url",
      passed: false,
      message: "No page URL available in evaluation context",
    });
  }

  const { patterns, matchMode, caseSensitive } = condition;

  if (!patterns || patterns.length === 0) {
    return err({
      conditionType: "page_url",
      passed: false,
      message: "No URL patterns configured",
    });
  }

  let pathname: string;
  try {
    pathname = new URL(requestedUrl).pathname;
  } catch {
    // If the URL is already a plain path (e.g. "/collections/sale"), use as-is
    pathname = requestedUrl;
  }

  const normalize = (s: string) => (caseSensitive ? s : s.toLowerCase());
  const normalizedPathname = normalize(pathname);

  const matched = patterns.some((pattern) => {
    const normalizedPattern = normalize(pattern);
    switch (matchMode) {
      case "exact":
        return normalizedPathname === normalizedPattern;
      case "contains":
        return normalizedPathname.includes(normalizedPattern);
      case "starts_with":
        return normalizedPathname.startsWith(normalizedPattern);
      case "ends_with":
        return normalizedPathname.endsWith(normalizedPattern);
      default:
        return false;
    }
  });

  if (!matched) {
    return err({
      conditionType: "page_url",
      passed: false,
      message: `Page pathname "${pathname}" did not match any pattern (mode: ${matchMode})`,
      actual: pathname,
      required: patterns.join(" | "),
    });
  }

  return ok({
    conditionType: "page_url",
    passed: true,
    message: `Page pathname "${pathname}" matched a configured pattern (mode: ${matchMode})`,
    actual: pathname,
  });
}

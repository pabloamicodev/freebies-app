import { evaluatePageUrl, evaluateUrlParam } from "@promo/rule-engine";
import { PageUrlConditionValueSchema, UrlParamConditionValueSchema } from "@promo/shared-types";

export function isEligibleBundlePage(
  requestedPageUrl: string | null,
  conditions: Array<{ conditionType: string; value: unknown }>,
): boolean {
  return conditions.every((condition) => {
    if (condition.conditionType === "page_url") {
      const parsed = PageUrlConditionValueSchema.safeParse(condition.value);
      return parsed.success && evaluatePageUrl(requestedPageUrl, parsed.data).ok;
    }
    if (condition.conditionType === "specific_link") {
      const parsed = UrlParamConditionValueSchema.safeParse(condition.value);
      return parsed.success && evaluateUrlParam(requestedPageUrl, parsed.data).ok;
    }
    return true;
  });
}

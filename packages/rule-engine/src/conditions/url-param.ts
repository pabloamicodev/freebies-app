import type { EligibilityReason } from "@promo/shared-types";
import {
  ok,
  err,
  asciiLower,
  queryValueMatches,
  readQueryParam,
  specificLinkRequiredPath,
  splitPageUrl,
  type Result,
} from "@promo/shared-types";

export interface UrlParamConditionValue {
  /** The full URL the buyer must have visited (magic link). */
  requiredUrl?: string;
  /** Query parameter name that must be present. */
  paramName?: string;
  /** Expected value of the parameter. If omitted, just presence is checked. */
  paramValue?: string;
  /** Legacy aliases kept read-compatible for offers created before normalization. */
  param?: string;
  key?: string;
  value?: string;
}

/**
 * Specific link / URL parameter sub-condition.
 * Evaluated on the page URL stamped on a cart line (a path + query, or an
 * absolute URL), exactly like the compiled `pageUrlConditions` entry the
 * Function runs: required path is a case-insensitive "contains", then the
 * parameter must be present (and equal, when a value is configured).
 */
export function evaluateUrlParam(
  requestedUrl: string | null,
  condition: UrlParamConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  if (!requestedUrl) {
    return err({
      conditionType: "specific_link",
      passed: false,
      message: "No URL available in evaluation context",
    });
  }

  const requiredPath = specificLinkRequiredPath(condition.requiredUrl ?? "");
  const paramName = condition.paramName ?? condition.param ?? condition.key;
  const paramValue = condition.paramValue ?? condition.value;
  const { path, query } = splitPageUrl(requestedUrl);
  if (requiredPath && !asciiLower(path).includes(asciiLower(requiredPath))) {
    return err({
      conditionType: "specific_link",
      passed: false,
      message: `URL path ${path} does not match required path ${requiredPath}`,
      actual: path,
      required: requiredPath,
    });
  }

  if (paramName) {
    const actual = readQueryParam(query, paramName);
    if (actual === null) {
      return err({
        conditionType: "specific_link",
        passed: false,
        message: `URL missing required param: ${paramName}`,
        actual: null,
        required: paramName,
      });
    }
    if (paramValue !== undefined && !queryValueMatches(paramName, actual, paramValue)) {
      return err({
        conditionType: "specific_link",
        passed: false,
        message: `Param ${paramName}=${actual}, expected ${paramValue}`,
        actual,
        required: paramValue,
      });
    }
  }

  return ok({
    conditionType: "specific_link",
    passed: true,
    message: `URL matches required link`,
    actual: requestedUrl,
  });
}

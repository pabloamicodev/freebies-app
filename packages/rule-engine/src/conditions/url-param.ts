import type { EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";

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
 * The buyer must have accessed the store via a specific URL or query param.
 * The requestedUrl is passed in from the storefront evaluation input.
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

  let url: URL;
  try {
    url = new URL(requestedUrl);
  } catch {
    return err({
      conditionType: "specific_link",
      passed: false,
      message: `Invalid URL: ${requestedUrl}`,
    });
  }

  // Check if the path matches the required URL (partial match or full)
  const requiredUrl = condition.requiredUrl ?? "";
  const paramName = condition.paramName ?? condition.param ?? condition.key;
  const paramValue = condition.paramValue ?? condition.value;
  const requiredBase = requiredUrl.split("?")[0] ?? requiredUrl;
  const currentBase = url.origin + url.pathname;
  if (requiredBase && !currentBase.includes(requiredBase)) {
    return err({
      conditionType: "specific_link",
      passed: false,
      message: `URL ${currentBase} does not match required path ${requiredBase}`,
      actual: currentBase,
      required: requiredBase,
    });
  }

  // Check query param
  if (paramName) {
    const paramVal = url.searchParams.get(paramName);
    if (paramVal === null) {
      return err({
        conditionType: "specific_link",
        passed: false,
        message: `URL missing required param: ${paramName}`,
        actual: null,
        required: paramName,
      });
    }
    if (paramValue !== undefined && paramVal !== paramValue) {
      return err({
        conditionType: "specific_link",
        passed: false,
        message: `Param ${paramName}=${paramVal}, expected ${paramValue}`,
        actual: paramVal,
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

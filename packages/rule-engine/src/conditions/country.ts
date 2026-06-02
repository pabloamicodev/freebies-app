import type { EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";

export interface CountryConditionValue {
  includeCountryCodes?: string[];
  excludeCountryCodes?: string[];
}

/**
 * Country/IP targeting condition.
 * countryCode comes from buyer identity (Storefront API buyerIdentity.countryCode)
 * or from the market context (market.countryCode).
 */
export function evaluateCountry(
  countryCode: string | null,
  condition: CountryConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  if (condition.includeCountryCodes && condition.includeCountryCodes.length > 0) {
    if (!countryCode || !condition.includeCountryCodes.includes(countryCode.toUpperCase())) {
      return err({
        conditionType: "customer_location",
        passed: false,
        message: `Country ${countryCode ?? "unknown"} not in allowed list: ${condition.includeCountryCodes.join(", ")}`,
        actual: countryCode,
        required: condition.includeCountryCodes,
      });
    }
  }

  if (condition.excludeCountryCodes && condition.excludeCountryCodes.length > 0) {
    if (countryCode && condition.excludeCountryCodes.includes(countryCode.toUpperCase())) {
      return err({
        conditionType: "customer_location",
        passed: false,
        message: `Country ${countryCode} is excluded`,
        actual: countryCode,
        required: condition.excludeCountryCodes,
      });
    }
  }

  return ok({
    conditionType: "customer_location",
    passed: true,
    message: `Country ${countryCode ?? "any"} passes`,
    actual: countryCode,
  });
}

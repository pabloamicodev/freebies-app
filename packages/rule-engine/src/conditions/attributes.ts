import type { NormalizedCart } from "@promo/shared-types";
import { err, ok, type Result, type EligibilityReason } from "@promo/shared-types";
import { extractQualifyingLines } from "../cart-parser.js";

export interface LineAttributeConditionValue {
  key: string;
  value: string;
  matchMode: "equals" | "not_equals";
  minMatchingQuantity: number;
}

export interface CartAttributeConditionValue {
  key: string;
  value: string;
  matchMode: "equals" | "not_equals";
}

export function evaluateLineAttribute(cart: NormalizedCart, condition: LineAttributeConditionValue): Result<EligibilityReason, EligibilityReason> {
  const matchingQuantity = extractQualifyingLines(cart, { includeGiftValues: false })
    .filter((line) => line.properties[condition.key] === condition.value)
    .reduce((sum, line) => sum + line.quantity, 0);
  const passed = condition.matchMode === "not_equals"
    ? matchingQuantity === 0
    : matchingQuantity >= condition.minMatchingQuantity;
  const reason = {
    conditionType: "line_attribute",
    passed,
    message: passed ? "Cart line attribute matched." : "Cart line attribute did not match.",
    actual: matchingQuantity,
    required: condition.matchMode === "not_equals" ? 0 : condition.minMatchingQuantity,
  };
  return passed ? ok(reason) : err(reason);
}

export function evaluateCartAttribute(cart: NormalizedCart, condition: CartAttributeConditionValue): Result<EligibilityReason, EligibilityReason> {
  const actual = cart.attributes?.[condition.key] ?? null;
  const equals = actual === condition.value;
  const passed = condition.matchMode === "not_equals" ? !equals : equals;
  const reason = {
    conditionType: "cart_attribute",
    passed,
    message: passed ? "Cart attribute matched." : "Cart attribute did not match.",
    actual,
    required: condition.value,
  };
  return passed ? ok(reason) : err(reason);
}

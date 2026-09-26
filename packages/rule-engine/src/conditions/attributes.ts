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
  value?: string;
  matchMode: "equals" | "not_equals" | "exists";
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
  const passed =
    condition.matchMode === "exists"
      ? actual !== null
      : condition.matchMode === "not_equals"
        ? actual !== condition.value
        : actual === condition.value;
  const reason = {
    conditionType: "cart_attribute",
    passed,
    message: passed ? "Cart attribute matched." : "Cart attribute did not match.",
    actual,
    required: condition.matchMode === "exists" ? "(any value)" : condition.value,
  };
  return passed ? ok(reason) : err(reason);
}

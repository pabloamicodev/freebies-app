import type { NormalizedCustomer, EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";

// ─── Customer Tags ────────────────────────────────────────────────────────────

export interface CustomerTagsConditionValue {
  includeTags?: string[];
  excludeTags?: string[];
  treatGuestAsNoTags: boolean;
}

export function evaluateCustomerTags(
  customer: NormalizedCustomer | null,
  condition: CustomerTagsConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  const tags = customer?.tags ?? [];

  if (!customer && !condition.treatGuestAsNoTags) {
    const reason: EligibilityReason = {
      conditionType: "customer_tags",
      passed: false,
      message: "Customer not logged in and guest treatment not configured",
    };
    return err(reason);
  }

  if (condition.includeTags && condition.includeTags.length > 0) {
    const hasAll = condition.includeTags.every((t) => tags.includes(t));
    if (!hasAll) {
      return err({
        conditionType: "customer_tags",
        passed: false,
        message: `Customer missing required tags: ${condition.includeTags.join(", ")}`,
        actual: tags,
        required: condition.includeTags,
      });
    }
  }

  if (condition.excludeTags && condition.excludeTags.length > 0) {
    const hasExcluded = condition.excludeTags.some((t) => tags.includes(t));
    if (hasExcluded) {
      return err({
        conditionType: "customer_tags",
        passed: false,
        message: `Customer has excluded tag`,
        actual: tags,
      });
    }
  }

  return ok({
    conditionType: "customer_tags",
    passed: true,
    message: "Customer tags condition passed",
    actual: tags,
  });
}

// ─── Order History ────────────────────────────────────────────────────────────

export interface OrderHistoryConditionValue {
  type: "total_spent" | "last_order_spent" | "total_orders";
  operator: "gte" | "lte" | "gt" | "lt" | "eq";
  valueCents?: number;
  valueOrders?: number;
}

export function evaluateOrderHistory(
  customer: NormalizedCustomer | null,
  condition: OrderHistoryConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  if (!customer) {
    return err({
      conditionType: "order_history",
      passed: false,
      message: "No customer — order history condition requires login",
    });
  }

  let actual: number;
  let required: number;
  let label: string;

  switch (condition.type) {
    case "total_spent":
      actual = customer.totalSpentCents;
      required = condition.valueCents ?? 0;
      label = "total spent";
      break;
    case "last_order_spent":
      actual = customer.lastOrderSpentCents ?? 0;
      required = condition.valueCents ?? 0;
      label = "last order spent";
      break;
    case "total_orders":
      actual = customer.totalOrders;
      required = condition.valueOrders ?? 0;
      label = "total orders";
      break;
  }

  const compare = (a: number, r: number, op: string): boolean => {
    switch (op) {
      case "gte": return a >= r;
      case "lte": return a <= r;
      case "gt": return a > r;
      case "lt": return a < r;
      case "eq": return a === r;
      default: return false;
    }
  };

  const passed = compare(actual, required, condition.operator);

  const reason: EligibilityReason = {
    conditionType: "order_history",
    passed,
    message: passed
      ? `${label}: ${actual} ${condition.operator} ${required} ✓`
      : `${label}: ${actual} does not satisfy ${condition.operator} ${required}`,
    actual,
    required,
  };

  return passed ? ok(reason) : err(reason);
}

// ─── One Use Per Customer ─────────────────────────────────────────────────────

export interface OneUsePerCustomerState {
  /** How many times has this customer already used this offer (completed orders). */
  usedCount: number;
}

export function evaluateOneUsePerCustomer(
  customer: NormalizedCustomer | null,
  state: OneUsePerCustomerState,
): Result<EligibilityReason, EligibilityReason> {
  if (!customer) {
    return err({
      conditionType: "one_use_per_customer",
      passed: false,
      message: "One-use-per-customer requires a logged-in customer",
    });
  }

  const passed = state.usedCount === 0;
  return passed
    ? ok({ conditionType: "one_use_per_customer", passed: true, message: "First use for this customer" })
    : err({
        conditionType: "one_use_per_customer",
        passed: false,
        message: `Customer has already used this offer ${state.usedCount} time(s)`,
        actual: state.usedCount,
        required: 0,
      });
}

// ─── Sales Channel ────────────────────────────────────────────────────────────

export function evaluateSalesChannel(
  actualChannel: string,
  allowedChannels: string[],
): Result<EligibilityReason, EligibilityReason> {
  const passed = allowedChannels.includes(actualChannel);
  const reason: EligibilityReason = {
    conditionType: "sales_channels",
    passed,
    message: passed
      ? `Channel ${actualChannel} is allowed`
      : `Channel ${actualChannel} not in allowed list: ${allowedChannels.join(", ")}`,
    actual: actualChannel,
    required: allowedChannels,
  };
  return passed ? ok(reason) : err(reason);
}

// ─── Markets ─────────────────────────────────────────────────────────────────

export function evaluateMarket(
  marketId: string | null,
  condition: { includeMarketIds?: string[]; excludeMarketIds?: string[] },
): Result<EligibilityReason, EligibilityReason> {
  if (condition.includeMarketIds && condition.includeMarketIds.length > 0) {
    if (!marketId || !condition.includeMarketIds.includes(marketId)) {
      return err({
        conditionType: "markets",
        passed: false,
        message: `Market ${marketId ?? "unknown"} not in include list`,
        actual: marketId,
        required: condition.includeMarketIds,
      });
    }
  }

  if (condition.excludeMarketIds && marketId && condition.excludeMarketIds.includes(marketId)) {
    return err({
      conditionType: "markets",
      passed: false,
      message: `Market ${marketId} is excluded`,
      actual: marketId,
    });
  }

  return ok({
    conditionType: "markets",
    passed: true,
    message: "Market condition passed",
    actual: marketId,
  });
}

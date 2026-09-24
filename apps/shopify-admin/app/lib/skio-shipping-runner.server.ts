import {
  getSkioSubscriptionById,
  intervalToDurationMonths,
  listActiveSkioSubscriptions,
  setSkioDeliveryPriceOverride,
  subscriptionProductVariantIds,
  subscriptionSubtotal,
  type RawSkioSubscription,
  type SkioGraphQLProxy,
} from "./skio-api.server.js";
import { resolveShippingOverride } from "./skio-shipping-sync.js";
import type { SkioShippingTiersConfig } from "./skio-shipping-tiers.js";

export interface SyncedSubscriptionResult {
  subscriptionId: string;
  matchedTierId: string | null;
  targetCycle: number;
  overrideAmount: number | null;
  applied: boolean;
}

const EPSILON = 0.001;

function toSnapshot(subscription: RawSkioSubscription) {
  const subscriptionDurationMonths = intervalToDurationMonths(subscription.BillingPolicy);
  if (subscriptionDurationMonths === null) return null;
  return {
    id: subscription.id,
    subscriptionDurationMonths,
    subtotal: subscriptionSubtotal(subscription),
    cyclesCompleted: subscription.cyclesCompleted ?? 0,
    productVariantIds: subscriptionProductVariantIds(subscription),
  };
}

function amountsMatch(expected: number, actual: number): boolean {
  return Math.abs(expected - actual) < EPSILON;
}

export class DeliveryPriceOverrideVerificationError extends Error {
  constructor(subscriptionId: string, expected: number, actual: number | null) {
    super(`Skio delivery-price verification failed for ${subscriptionId}: expected ${expected}, read ${actual}.`);
    this.name = "DeliveryPriceOverrideVerificationError";
  }
}

export async function runSkioShippingSync(
  proxy: SkioGraphQLProxy,
  config: SkioShippingTiersConfig,
): Promise<SyncedSubscriptionResult[]> {
  const subscriptions = await listActiveSkioSubscriptions(proxy);
  const results: SyncedSubscriptionResult[] = [];

  for (const subscription of subscriptions) {
    const snapshot = toSnapshot(subscription);
    if (!snapshot) continue;
    const decision = resolveShippingOverride(config, snapshot);

    if (decision.overrideAmount === null || amountsMatch(decision.overrideAmount, subscription.deliveryPrice)) {
      results.push({ ...decision, applied: false });
      continue;
    }

    try {
      await setSkioDeliveryPriceOverride(proxy, subscription.id, decision.overrideAmount);
      const verified = await getSkioSubscriptionById(proxy, subscription.id);
      const actual = verified?.deliveryPrice ?? null;
      if (actual === null || !amountsMatch(decision.overrideAmount, actual)) {
        throw new DeliveryPriceOverrideVerificationError(subscription.id, decision.overrideAmount, actual);
      }
      results.push({ ...decision, applied: true });
    } catch (error) {
      if (error instanceof DeliveryPriceOverrideVerificationError) throw error;
      console.error("[skio-shipping] override failed", { subscriptionId: subscription.id, error });
      results.push({ ...decision, applied: false });
    }
  }
  return results;
}

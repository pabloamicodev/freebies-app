import type { Db } from "@promo/db";
import type { ConditionOperator, ConditionScope, ConditionType, DiscountType, RewardType, TrackMode } from "@promo/shared-types";
import type { ShopPublishFn } from "../offer-publish-flow.server.js";

/**
 * Shared contract of the typed offer-authoring layer (MCP full access, 2026-11-13).
 * Admin routes (FormData adapters) and MCP tools (zod adapters) both feed these typed inputs into the
 * same services, so neither transport holds business logic. Money in authoring inputs is in MAJOR
 * units of the shop currency (19.99); the services convert with toStoredAmount.
 */

export type AuthoringDeps = {
  db: Db;
  shopId: string;
  shopDomain: string;
  shopCurrency: string;
  timezone: string;
};

export type AuthoringResult<T> = { ok: true; value: T } | { ok: false; error: string; path?: string };

/** Row shape written to offer_conditions (minus ids/timestamps). */
export type StoredCondition = {
  scope: ConditionScope;
  conditionType: ConditionType;
  operator: ConditionOperator;
  value: Record<string, unknown>;
  sortOrder?: number;
  isEnabled?: boolean;
};

/** Row shape written to offer_rewards (minus ids/timestamps). */
export type StoredReward = {
  rewardType: RewardType;
  discountType: DiscountType;
  value: Record<string, unknown>;
  target: Record<string, unknown>;
  quantity?: number | null;
  isAutoAdd?: boolean;
  isCustomerSelectable?: boolean;
  trackMode?: TrackMode;
  sortOrder?: number;
  label?: string | null;
  minCartSubtotalCents?: number | null;
};

/** Row shape written to offer_combination_policies (minus ids/timestamps). Omitted fields take the wizard defaults. */
export type StoredCombinationPolicy = {
  combinesWithOrderDiscounts?: boolean;
  combinesWithProductDiscounts?: boolean;
  combinesWithShippingDiscounts?: boolean;
  combinesWithOtherAppOffers?: boolean;
  stopLowerPriority?: boolean;
  canStackWithGiftOffers?: boolean;
  giftValueCountsForOtherOffers?: boolean;
  maxApplicationsPerCart?: number | null;
  maxApplicationsPerCustomer?: number | null;
  requireIdentifiedCustomer?: boolean;
};

/** Options every write service takes; mirrors OfferLifecycleOptions. */
export type WriteServiceOptions = {
  performedBy: string;
  auditExtra?: Record<string, unknown>;
  /** Compute and validate everything, write nothing, publish nothing. */
  dryRun?: boolean;
  /** Replaces only the Shopify publish (tests). Defaults to the real shop publish. */
  publish?: ShopPublishFn;
  /** Optimistic concurrency on offers.updated_at. */
  expectedUpdatedAt?: Date;
};

/** Every module under lib/offer-authoring/ that turns one authoring family into stored rows exports a function of this shape. */
export type ToStored<I, O> = (input: I, deps: AuthoringDeps) => Promise<AuthoringResult<O>>;

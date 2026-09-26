/** Local type aliases — mirror of @promo/shared-types but usable in browser code without Node deps. */

export interface CartAction {
  action: "add_line" | "update_line" | "remove_line";
  variantId?: string;
  quantity?: number;
  properties?: Record<string, string>;
  lineKey?: string;
  offerId?: string;
  reason?: string;
}

export interface EvaluationResult {
  requestId: string;
  cartHash: string;
  qualifiedOffers: EvaluatedOffer[];
  disqualifiedOffers: EvaluatedOffer[];
  cartActions: CartAction[];
  discountCodes: { add: string[]; remove: string[] };
  giftSlider: GiftSliderPayload | null;
  cartMessages: CartMessagePayload[];
  progressBars: ProgressBarPayload[];
  upsells: UpsellPayload[];
  warnings: Array<{ code: string; message: string }>;
  evaluatedAt: string;
}

export interface EvaluatedOffer {
  offerId: string;
  offerVersion: number;
  type: string;
  qualified: boolean;
  reasons: unknown[];
  cartActions: CartAction[];
  discountCodesToAdd: string[];
  discountCodesToRemove: string[];
}

export interface GiftSliderLabels {
  free: string;
  outOfStock: string;
  /** Omitted unless the merchant configured gift_slider.confirm_button. */
  confirm?: string;
  selectPrompt: string;
  remove: string;
  replaces: string;
}

export interface GiftSliderPayload {
  offerId: string;
  title: string;
  subtitle: string | null;
  currencyCode: string;
  selectableGifts: SelectableGift[];
  maxSelectableCount: number;
  alreadySelectedCount: number;
  /** Merchant-translated widget strings, resolved server-side with English defaults. */
  labels?: GiftSliderLabels;
}

export interface UpsellProduct {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  originalPriceCents: number;
  discountedPriceCents: number;
  isAvailable: boolean;
}

export interface UpsellPayload {
  offerId: string;
  product: UpsellProduct | null;
  message: string;
  buttonText: string;
  discountPercent: number;
}

export interface SelectableGift {
  rewardId: string;
  offerVersion: number;
  rewardMaxQuantity: number;
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  originalPriceCents: number;
  discountedPriceCents: number;
  isAvailable: boolean;
  isSelected: boolean;
  /** Title of the sold-out gift this merchant-configured fallback replaces. */
  replacesTitle?: string;
}

export interface CartMessagePayload {
  offerId: string;
  widgetId: string;
  message: string;
  type: "progress" | "success" | "info";
  priority: number;
}

export interface ProgressBarPayload {
  offerId: string;
  widgetId: string;
  currentCents: number;
  targetCents: number;
  currentQuantity: number;
  targetQuantity: number | null;
  progressPercent: number;
  messageBeforeGoal: string;
  messageAfterGoal: string;
  isGoalReached: boolean;
}

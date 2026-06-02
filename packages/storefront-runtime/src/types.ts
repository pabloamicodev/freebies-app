/** Local type aliases — mirror of @promo/shared-types but usable in browser code without Node deps. */

export interface CartAction {
  action: "add_line" | "update_line" | "remove_line";
  variantId?: string;
  quantity?: number;
  properties?: Record<string, string>;
  lineKey?: string;
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

export interface GiftSliderPayload {
  offerId: string;
  title: string;
  subtitle: string | null;
  selectableGifts: SelectableGift[];
  maxSelectableCount: number;
  alreadySelectedCount: number;
}

export interface SelectableGift {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  originalPriceCents: number;
  discountedPriceCents: number;
  isAvailable: boolean;
  isSelected: boolean;
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

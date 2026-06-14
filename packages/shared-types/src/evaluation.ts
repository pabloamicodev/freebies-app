import { z } from "zod";

/** Action to add a line to the cart. */
export const CartLineAddActionSchema = z.object({
  action: z.literal("add_line"),
  variantId: z.string(),
  quantity: z.number().int().positive(),
  properties: z.record(z.string(), z.string()),
});
export type CartLineAddAction = z.infer<typeof CartLineAddActionSchema>;

/** Action to update quantity of an existing line (by key). */
export const CartLineUpdateActionSchema = z.object({
  action: z.literal("update_line"),
  lineKey: z.string(),
  quantity: z.number().int().nonnegative(),
  properties: z.record(z.string(), z.string()).optional(),
  offerId: z.string().uuid().optional(),
  variantId: z.string().optional(),
});
export type CartLineUpdateAction = z.infer<typeof CartLineUpdateActionSchema>;

/** Action to remove a line from the cart. */
export const CartLineRemoveActionSchema = z.object({
  action: z.literal("remove_line"),
  lineKey: z.string(),
  reason: z.string().optional(),
  offerId: z.string().uuid().optional(),
  variantId: z.string().optional(),
  properties: z.record(z.string(), z.string()).optional(),
});
export type CartLineRemoveAction = z.infer<typeof CartLineRemoveActionSchema>;

export const CartActionSchema = z.discriminatedUnion("action", [
  CartLineAddActionSchema,
  CartLineUpdateActionSchema,
  CartLineRemoveActionSchema,
]);
export type CartAction = z.infer<typeof CartActionSchema>;

export const GiftSliderPayloadSchema = z.object({
  offerId: z.string().uuid(),
  title: z.string(),
  subtitle: z.string().nullable(),
  selectableGifts: z.array(z.object({
    variantId: z.string(),
    productId: z.string(),
    title: z.string(),
    variantTitle: z.string().nullable(),
    imageUrl: z.string().nullable(),
    originalPriceCents: z.number().int(),
    discountedPriceCents: z.number().int(),
    isAvailable: z.boolean(),
    isSelected: z.boolean(),
  })),
  maxSelectableCount: z.number().int().positive(),
  alreadySelectedCount: z.number().int().nonnegative(),
});
export type GiftSliderPayload = z.infer<typeof GiftSliderPayloadSchema>;

export const CartMessagePayloadSchema = z.object({
  offerId: z.string().uuid(),
  widgetId: z.string().uuid(),
  message: z.string(),
  type: z.enum(["progress", "success", "info"]),
  priority: z.number().int(),
});
export type CartMessagePayload = z.infer<typeof CartMessagePayloadSchema>;

export const ProgressBarPayloadSchema = z.object({
  offerId: z.string().uuid(),
  widgetId: z.string().uuid(),
  currentCents: z.number().int().nonnegative(),
  targetCents: z.number().int().nonnegative(),
  currentQuantity: z.number().int().nonnegative(),
  targetQuantity: z.number().int().nonnegative().nullable(),
  progressPercent: z.number().min(0).max(100),
  messageBeforeGoal: z.string(),
  messageAfterGoal: z.string(),
  isGoalReached: z.boolean(),
});
export type ProgressBarPayload = z.infer<typeof ProgressBarPayloadSchema>;

/** Reason why an offer did/did not qualify. Used for admin preview/debug. */
export const EligibilityReasonSchema = z.object({
  conditionType: z.string(),
  passed: z.boolean(),
  message: z.string(),
  actual: z.unknown().optional(),
  required: z.unknown().optional(),
});
export type EligibilityReason = z.infer<typeof EligibilityReasonSchema>;

export const EvaluatedOfferSchema = z.object({
  offerId: z.string().uuid(),
  offerVersion: z.number().int(),
  type: z.string(),
  qualified: z.boolean(),
  reasons: z.array(EligibilityReasonSchema),
  cartActions: z.array(CartActionSchema),
  discountCodesToAdd: z.array(z.string()),
  discountCodesToRemove: z.array(z.string()),
});
export type EvaluatedOffer = z.infer<typeof EvaluatedOfferSchema>;

/** Full evaluation result — returned by rule engine and storefront API. */
export const EvaluationResultSchema = z.object({
  requestId: z.string(),
  cartHash: z.string(),
  qualifiedOffers: z.array(EvaluatedOfferSchema),
  disqualifiedOffers: z.array(EvaluatedOfferSchema),
  cartActions: z.array(CartActionSchema),
  discountCodes: z.object({
    add: z.array(z.string()),
    remove: z.array(z.string()),
  }),
  giftSlider: GiftSliderPayloadSchema.nullable(),
  cartMessages: z.array(CartMessagePayloadSchema),
  progressBars: z.array(ProgressBarPayloadSchema),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  evaluatedAt: z.string().datetime(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

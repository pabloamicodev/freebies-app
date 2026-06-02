/**
 * Storefront event bus — all promo engine events flow through here.
 * Uses native CustomEvent under the hood for theme compatibility.
 */

export const PromoEvents = {
  CartChanged: "promo-engine:cart-changed",
  EvaluationRequested: "promo-engine:evaluation-requested",
  EvaluationCompleted: "promo-engine:evaluation-completed",
  GiftAutoAdded: "promo-engine:gift-auto-added",
  GiftAdded: "promo-engine:gift-added",
  GiftUpdated: "promo-engine:gift-updated",
  GiftRemoved: "promo-engine:gift-removed",
  GiftSliderRequested: "promo-engine:gift-slider-requested",
  GiftSliderClosed: "promo-engine:gift-slider-closed",
  ProductChanged: "promo-engine:product-changed",
  CartMessageRender: "promo-engine:cart-message-render",
  ProgressRerender: "promo-engine:progress-rerender",
  TodayOfferRender: "promo-engine:today-offer-render",
  BundleInit: "promo-engine:bundle-init",
  UpsellInit: "promo-engine:upsell-init",
  CheckoutPrepare: "promo-engine:checkout-prepare",
  CartMutationError: "promo-engine:cart-mutation-error",
  InventoryFailure: "promo-engine:inventory-failure",
} as const;

export type PromoEventName = (typeof PromoEvents)[keyof typeof PromoEvents];

export function emit<T = unknown>(event: string, detail?: T): void {
  window.dispatchEvent(new CustomEvent(event, { detail, bubbles: true }));
}

export function on<T = unknown>(
  event: string,
  handler: (detail: T) => void,
  options?: AddEventListenerOptions,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<T>).detail);
  window.addEventListener(event, listener, options);
  return () => window.removeEventListener(event, listener);
}

/** Emit a custom analytics event — picked up by Web Pixel extension. */
export function publishAnalytics(eventName: string, payload: Record<string, unknown>): void {
  if (typeof window.analytics?.publish === "function") {
    window.analytics.publish(eventName, payload);
  }
}

declare global {
  interface Window {
    analytics?: {
      publish: (name: string, payload: Record<string, unknown>) => void;
    };
  }
}

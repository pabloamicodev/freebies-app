// Runtime initialization (side-effect: registers DOMContentLoaded listener)
import "./runtime.js";

// Core runtime
export { initCartDrawerIntegration } from "./cart-drawer-integration.js";
export { AjaxCartAdapter } from "./cart-adapter.js";
export { StorefrontApiAdapter } from "./storefront-api-adapter.js";
export { emit, on, PromoEvents, publishAnalytics } from "./event-bus.js";
export { debounce, AbortableRequest } from "./debounce.js";

// Widgets — Preact
export { initGiftSlider } from "./widgets/gift-slider.js";
export { initFbtWidget } from "./widgets/fbt.js";
export { initTodayOfferWidget } from "./widgets/today-offer.js";
export { initBundleBuilder } from "./widgets/bundle-builder.js";

// Web Components (auto-register on import)
import "./widgets/progress-bar.js";
import "./widgets/cart-message.js";
import "./widgets/gift-icon.js";
import "./widgets/volume-discount.js";
import "./widgets/today-offer-block.js";

// Types
export type { EvaluationResult, CartAction, GiftSliderPayload, ProgressBarPayload, CartMessagePayload } from "./types.js";

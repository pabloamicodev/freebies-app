// Theme App Extension entrypoint. Keep headless adapters and opt-in widgets out
// of the always-loaded storefront bundle; they remain exported from index.ts.
import "./metadata-bridge.js";
import "./runtime.js";
import "./widgets/progress-bar.js";
import "./widgets/cart-message.js";
import "./widgets/gift-icon.js";
import "./widgets/volume-discount.js";
import "./widgets/today-offer-block.js";

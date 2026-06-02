/**
 * Cart Drawer Integration
 * Detects popular cart drawer implementations and hooks into their
 * events so the promo engine can re-evaluate when the drawer opens.
 *
 * Supported themes/apps:
 * - Dawn (standard Shopify theme) — cart:updated, cart:refresh events
 * - Turbo / Porto / other popular themes — custom events
 * - Rebuy Smart Cart — custom events
 * - Slide Cart Drawer — custom events
 * - Custom cart drawers via section rendering
 *
 * Fallback: MutationObserver on cart quantity indicators.
 */

import { emit, on, PromoEvents } from "./event-bus.js";

export interface CartDrawerIntegrationOptions {
  /** Additional CSS selectors to watch for quantity changes. */
  quantitySelectors?: string[];
  /** Custom event names emitted by the theme when cart updates. */
  customCartUpdateEvents?: string[];
  /** Enable section rendering rerender after mutations. */
  sectionRenderingEnabled?: boolean;
}

export function initCartDrawerIntegration(options: CartDrawerIntegrationOptions = {}) {
  const {
    quantitySelectors = [".cart-count", ".cart-item-count", "[data-cart-count]"],
    customCartUpdateEvents = [],
    sectionRenderingEnabled = false,
  } = options;

  // ── Standard Shopify theme events ─────────────────────────────────────────
  const STANDARD_EVENTS = [
    "cart:updated",
    "cart:refresh",
    "cart:change",
    "cart-drawer:open",
    "cartDrawer:open",
    "drawer:open",
    "theme:cart:open",
    // Turbo theme
    "turbo:cart-update",
    // Rebuy
    "rebuy:cart-change",
    // Slide Cart
    "slide-cart:open",
    ...customCartUpdateEvents,
  ];

  for (const eventName of STANDARD_EVENTS) {
    document.addEventListener(eventName, () => {
      emit(PromoEvents.CartChanged);
    });
  }

  // ── MutationObserver fallback ──────────────────────────────────────────────
  // Watch cart count indicators for changes
  let observedElements: Element[] = [];

  function attachObservers() {
    for (const selector of quantitySelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (!observedElements.includes(el)) {
          observer.observe(el, { childList: true, subtree: true, characterData: true });
          observedElements.push(el);
        }
      }
    }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => emit(PromoEvents.CartChanged), 300);
  });

  attachObservers();

  // Re-attach on DOM changes (lazy-loaded cart drawers)
  new MutationObserver(() => attachObservers()).observe(document.body, {
    childList: true,
    subtree: false,
  });

  // ── Section rendering rerender ─────────────────────────────────────────────
  if (sectionRenderingEnabled) {
    // After promo engine mutations, trigger section rendering
    on(PromoEvents.GiftAutoAdded, async () => {
      const sectionIds = getSectionIds();
      if (sectionIds.length > 0) {
        await rerenderSections(sectionIds);
      }
    });
  }

  // ── Cart drawer open rerender ──────────────────────────────────────────────
  // When cart drawer opens, re-render widgets that may have missed events
  STANDARD_EVENTS.filter((e) => e.includes("open")).forEach((eventName) => {
    document.addEventListener(eventName, () => {
      setTimeout(() => {
        emit(PromoEvents.ProgressRerender);
        emit(PromoEvents.CartMessageRender);
      }, 100); // Small delay for drawer animation to complete
    });
  });
}

function getSectionIds(): string[] {
  // Find sections that should be re-rendered after cart mutation
  const sections = document.querySelectorAll("[data-section-id]");
  const cartSectionIds: string[] = [];
  for (const section of sections) {
    const id = section.getAttribute("data-section-id");
    if (id && (id.includes("cart") || id.includes("gift"))) {
      cartSectionIds.push(id);
    }
  }
  return cartSectionIds;
}

async function rerenderSections(sectionIds: string[]): Promise<void> {
  const sectionParam = sectionIds.map((id) => `sections[]=${encodeURIComponent(id)}`).join("&");
  try {
    const response = await fetch(`/cart?${sectionParam}`, {
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) return;

    const data = await response.json() as { sections?: Record<string, string> };
    for (const [sectionId, html] of Object.entries(data.sections ?? {})) {
      const element = document.querySelector(`[data-section-id="${sectionId}"]`);
      if (element && html) {
        element.outerHTML = html;
      }
    }
  } catch {
    // Section rendering not available or failed — ignore
  }
}

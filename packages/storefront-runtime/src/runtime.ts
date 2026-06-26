/**
 * Promo Engine storefront runtime — main entry point.
 * Loaded by the Theme App Extension app embed on every page.
 *
 * Responsibilities:
 * 1. Initialize on page load.
 * 2. Listen for cart changes from any source (theme, app, custom).
 * 3. Debounce → evaluate offers via backend.
 * 4. Apply cart actions (add/remove/update gift lines).
 * 5. Broadcast evaluation results to all widgets.
 */

import { AjaxCartAdapter, type CartData } from "./cart-adapter.js";
import { debounce, AbortableRequest } from "./debounce.js";
import { emit, on, PromoEvents, publishAnalytics } from "./event-bus.js";
import { fetchFreshCart, findGiftLineByOfferId, resolveLineKey } from "./guards.js";
import type { EvaluationResult, CartAction } from "./types.js";

const EVAL_DEBOUNCE_MS = 300;
const EVAL_ENDPOINT = "/apps/promo-engine/evaluate";
const SESSION_KEY = "promo_engine_session_id";

interface RuntimeConfig {
  shopDomain: string;
  publicKey: string;
  locale: string;
  currency: string;
  debug: boolean;
}

class PromoEngineRuntime {
  private config: RuntimeConfig;
  private sessionId: string;
  private evaluationAbort = new AbortableRequest();
  private debouncedEvaluate: ReturnType<typeof debounce>;
  private lastCartHash: string | null = null;

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.sessionId = this.getOrCreateSessionId();
    this.debouncedEvaluate = debounce(this.triggerEvaluation.bind(this), EVAL_DEBOUNCE_MS);
  }

  init(): void {
    this.log("Promo Engine initialized", this.config);
    this.listenForCartChanges();
    void this.triggerEvaluation();
  }

  private getOrCreateSessionId(): string {
    try {
      let id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  private listenForCartChanges(): void {
    // Patch window.fetch to catch themes (e.g. Dawn) that never fire cart events
    this.patchFetch();

    // Standard Shopify cart change events (fallback / other themes)
    document.addEventListener("cart:updated", () => this.debouncedEvaluate.call());
    document.addEventListener("cart:refresh", () => this.debouncedEvaluate.call());
    document.addEventListener("theme:cart:open", () => this.debouncedEvaluate.call());

    // Our own events
    on(PromoEvents.CartChanged, () => this.debouncedEvaluate.call());
  }

  private patchFetch(): void {
    const CART_MUTATE_RE = /\/cart\/(add|change|update)(\.js)?(\?|$)/;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const isCartMutation = method === "POST" && CART_MUTATE_RE.test(url);

      const response = await originalFetch(input, init);

      if (isCartMutation && response.ok) {
        console.info(`[PromoEngine] Cart mutation detected (${url}) — scheduling evaluation`);
        this.debouncedEvaluate.call();
      }

      return response;
    };
  }

  private async triggerEvaluation(): Promise<void> {
    emit(PromoEvents.EvaluationRequested);

    let cart: CartData;
    try {
      cart = await AjaxCartAdapter.getCart();
    } catch (e) {
      this.log("Failed to fetch cart", e);
      return;
    }

    const cartHash = this.buildCartHash(cart);
    if (cartHash === this.lastCartHash) {
      this.log("Cart unchanged, skipping evaluation");
      return;
    }

    console.info("[PromoEngine] Evaluating cart —", cart.items.map(i => `${i.title} ×${i.quantity}`).join(", ") || "empty", `| subtotal: $${(cart.total_price / 100).toFixed(2)}`);

    const signal = this.evaluationAbort.start();

    // Build market context from Shopify global if a non-base currency is active
    const shopifyGlobal = window.Shopify;
    const activeCurrency = shopifyGlobal?.currency?.active ?? this.config.currency;
    const exchangeRateRaw = shopifyGlobal?.currency?.rate;
    const exchangeRate = exchangeRateRaw ? parseFloat(exchangeRateRaw) : null;
    const market =
      activeCurrency && activeCurrency !== this.config.currency
        ? {
            id: activeCurrency,
            handle: activeCurrency.toLowerCase(),
            currencyCode: activeCurrency,
            countryCode: shopifyGlobal?.country ?? null,
            primaryLocale: shopifyGlobal?.locale ?? this.config.locale,
            exchangeRate: exchangeRate && !isNaN(exchangeRate) ? exchangeRate : null,
          }
        : null;

    try {
      const response = await fetch(EVAL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Promo-Shop": this.config.shopDomain,
          "X-Promo-Key": this.config.publicKey,
          "X-Promo-Session": this.sessionId,
        },
        body: JSON.stringify({
          cart: this.normalizeCart(cart),
          customer: null,
          market,
          locale: this.config.locale,
          salesChannel: "online_store",
          requestedUrl: window.location.href,
          sessionId: this.sessionId,
        }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "(no body)");
        throw new Error(`Evaluation failed: ${response.status} — ${errText}`);
      }

      const result: EvaluationResult = await response.json();
      this.lastCartHash = cartHash;

      const actions = Array.isArray(result.cartActions) ? result.cartActions : [];
      if (actions.length > 0) {
        console.info("[PromoEngine] Cart actions to apply:", actions.map(a => `${a.action}(${a.variantId ?? a.lineKey ?? ""}×${a.quantity ?? 0})`).join(", "));
      } else {
        console.info("[PromoEngine] Evaluation complete — no cart actions");
      }

      await this.applyCartActions(actions);
      emit(PromoEvents.EvaluationCompleted, result);

    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") {
        this.log("Evaluation aborted (superseded by newer request)");
        return;
      }
      this.log("Evaluation error", e);
      emit(PromoEvents.CartMutationError, { error: (e as Error).message });
    }
  }

  private async applyCartActions(actions: CartAction[]): Promise<void> {

    for (const action of actions) {
      try {
        switch (action.action) {
          case "add_line": {
            if (!action.variantId) break;
            const legacyId = parseInt(action.variantId.split("/").pop() ?? action.variantId, 10);
            console.info(`[PromoEngine] → add_line variantId=${action.variantId} qty=${action.quantity ?? 1}`);
            await AjaxCartAdapter.addLines([{
              variantId: String(legacyId),
              quantity: action.quantity ?? 1,
              properties: action.properties ?? {},
            }]);
            emit(PromoEvents.GiftAutoAdded, {
              variantId: action.variantId,
              quantity: action.quantity,
            });
            publishAnalytics("promo_engine:gift_auto_added", {
              variant_id: action.variantId,
              quantity: action.quantity,
              session_id: this.sessionId,
            });
            break;
          }

          case "update_line": {
            console.info(`[PromoEngine] → update_line key=${action.lineKey ?? "?"} qty=${action.quantity ?? 1}`);
            const freshCart = await fetchFreshCart();
            const currentLine = freshCart.items.find((item) => item.key === action.lineKey)
              ?? (action.offerId ? findGiftLineByOfferId(freshCart, action.offerId) : null);
            const lineKey = currentLine?.key
              ?? (action.variantId ? resolveLineKey(freshCart, parseInt(action.variantId.split("/").pop() ?? action.variantId, 10), action.properties ?? {}) : null);
            if (!lineKey) break;
            if (action.quantity === 0) {
              await AjaxCartAdapter.removeLine({ key: lineKey });
              emit(PromoEvents.GiftRemoved, { lineKey });
              publishAnalytics("promo_engine:gift_removed", {
                line_key: lineKey,
                reason: "quantity_correction",
                session_id: this.sessionId,
              });
            } else {
              await AjaxCartAdapter.updateLine({
                key: lineKey,
                quantity: action.quantity ?? 1,
                properties: action.properties,
              });
              emit(PromoEvents.GiftUpdated, { lineKey, quantity: action.quantity });
            }
            break;
          }

          case "remove_line": {
            console.info(`[PromoEngine] → remove_line key=${action.lineKey ?? "?"} reason=${action.reason ?? "offer_disqualified"}`);
            const freshCart = await fetchFreshCart();
            const currentLine = freshCart.items.find((item) => item.key === action.lineKey)
              ?? (action.offerId ? findGiftLineByOfferId(freshCart, action.offerId) : null);
            const lineKey = currentLine?.key
              ?? (action.variantId ? resolveLineKey(freshCart, parseInt(action.variantId.split("/").pop() ?? action.variantId, 10), action.properties ?? {}) : null);
            if (!lineKey) break;
            await AjaxCartAdapter.removeLine({ key: lineKey });
            emit(PromoEvents.GiftRemoved, { lineKey });
            publishAnalytics("promo_engine:gift_removed", {
              line_key: lineKey,
              reason: action.reason ?? "offer_disqualified",
              session_id: this.sessionId,
            });
            break;
          }
        }
      } catch (e) {
        this.log("Cart action failed", { action, error: e });
        emit(PromoEvents.CartMutationError, { action, error: (e as Error).message });
        publishAnalytics("promo_engine:cart_mutation_error", {
          action_type: action.action,
          error: (e as Error).message,
          session_id: this.sessionId,
        });
      }
    }
  }

  private buildCartHash(cart: CartData): string {
    const parts = [
      ...cart.items.map((i) => `${i.variant_id}:${i.quantity}`).sort(),
      cart.currency,
    ];
    return parts.join("|");
  }

  private normalizeCart(cart: CartData): object {
    return {
      token: cart.token,
      id: null,
      lines: cart.items.map((item) => ({
        key: item.key,
        variantId: `gid://shopify/ProductVariant/${item.variant_id}`,
        productId: `gid://shopify/Product/${item.product_id}`,
        quantity: item.quantity,
        priceCents: item.price,
        compareAtPriceCents: null,
        properties: item.properties,
        requiresSellingPlan: item.requires_selling_plan,
        sellingPlanId: item.selling_plan_allocation ? "has-plan" : null,
        productHandle: item.handle,
        productTitle: item.title,
        variantTitle: item.variant_title,
        vendor: item.vendor,
        productType: item.product_type,
        tags: item.tags ? item.tags.split(", ") : [],
        collections: [],
        availableForSale: item.available,
        inventoryPolicy: item.inventory_policy?.toUpperCase() === "CONTINUE" ? "CONTINUE" : "DENY",
        inventoryQuantity: item.inventory_quantity,
      })),
      subtotalCents: cart.total_price,
      discountCodes: cart.discount_codes?.map((d) => d.code) ?? [],
      currencyCode: cart.currency,
      totalQuantity: cart.item_count,
    };
  }

  private log(message: string, ...args: unknown[]): void {
    if (this.config.debug) {
      console.info(`[PromoEngine] ${message}`, ...args);
    }
  }

  /** Public API — exposed on window.PromoEngine */
  public readonly api = {
    refreshCart: () => this.debouncedEvaluate.flush(),
    evaluate: () => this.triggerEvaluation(),
    prepareCheckout: async () => {
      this.debouncedEvaluate.cancel();
      emit(PromoEvents.CheckoutPrepare);
      await this.triggerEvaluation();
    },
    on: (event: string, callback: (detail: unknown) => void) => on(event, callback),
  };
}

// ─── Global initialization ────────────────────────────────────────────────────

declare global {
  interface Window {
    PromoEngine?: PromoEngineRuntime["api"];
    __promoEngineConfig?: RuntimeConfig;
  }
}

function initRuntime() {
  const config = window.__promoEngineConfig;
  if (!config) {
    console.warn("[PromoEngine] No config found. Ensure the app embed is enabled in your theme.");
    return;
  }
  const runtime = new PromoEngineRuntime(config);
  window.PromoEngine = runtime.api;
  runtime.init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initRuntime);
} else {
  initRuntime();
}

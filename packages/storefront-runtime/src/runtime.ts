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
import { initGiftSlider } from "./widgets/gift-slider.js";
import { initFbtWidget } from "./widgets/fbt.js";
import { initBundleBuilder } from "./widgets/bundle-builder.js";
import { buildMarketContext } from "./market-context.js";
import type { EvaluationResult, CartAction } from "./types.js";

const DEFAULT_EVAL_DEBOUNCE_MS = 300;
const DEFAULT_EVAL_ENDPOINT = "/apps/promo-engine/evaluate";
const SESSION_KEY = "promo_engine_session_id";

/** crypto.randomUUID() requires a secure context and isn't present on older
 * Safari — fall back to a manual UUID v4 rather than let init() throw. */
function generateUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Shared by the runtime instance and by widgets (e.g. the gift slider) that
 * mount independently of PromoEngineRuntime but need the same session. */
function getOrCreateSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = generateUuid();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return generateUuid();
  }
}

interface RuntimeConfig {
  shopDomain: string;
  locale: string;
  currency: string;
  marketId?: string | null;
  marketHandle?: string | null;
  countryCode?: string | null;
  debug: boolean;
  debounceMs?: number;
  evalEndpoint?: string;
}

class PromoEngineRuntime {
  private config: RuntimeConfig;
  private sessionId: string;
  private evaluationAbort = new AbortableRequest();
  private debouncedEvaluate: ReturnType<typeof debounce>;
  private lastCartHash: string | null = null;
  private savedFetch: typeof window.fetch = window.fetch.bind(window);
  private refreshGuard = false;
  // Widgets (gift slider, bundles) mutate the cart outside the theme, so its drawer must be re-rendered.
  private widgetChangedCart = false;
  private capturedThemeSectionIds: string[] = [];
  private lastEvaluationResult: EvaluationResult | null = null;
  private readonly evalEndpoint: string;

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.sessionId = getOrCreateSessionId();
    const debounceMs = Number.isFinite(config.debounceMs)
      ? Math.max(100, Math.min(1_000, Math.round(config.debounceMs!)))
      : DEFAULT_EVAL_DEBOUNCE_MS;
    // App-proxy requests must stay same-origin. Reject absolute or arbitrary
    // paths so theme settings can never turn the runtime into a data exfiltrator.
    this.evalEndpoint = config.evalEndpoint?.startsWith("/apps/promo-engine/")
      ? config.evalEndpoint
      : DEFAULT_EVAL_ENDPOINT;
    this.debouncedEvaluate = debounce(() => this.triggerEvaluation(), debounceMs);
  }

  init(): void {
    this.log("Promo Engine initialized", this.config);
    this.detectTheme();
    this.listenForCartChanges();
    void this.triggerEvaluation();
  }

  private detectTheme(): void {
    type ShopifyGlobal = { theme?: { schema_name?: string; name?: string }; shop?: string };
    const sh = (window as unknown as { Shopify?: ShopifyGlobal }).Shopify;
    const name = sh?.theme?.schema_name ?? sh?.theme?.name ?? "unknown";
    this.log(`[PromoEngine] Theme detected: ${name}`);

    // Dawn: exposes <cart-drawer> web component → section rendering works natively
    // Others: we rely on patchFetch to capture the theme's own section IDs at runtime
    const hasDawnDrawer = !!document.querySelector("cart-drawer");
    if (hasDawnDrawer)
      this.log("[PromoEngine] Cart component: cart-drawer web component (Dawn-style)");
  }

  private listenForCartChanges(): void {
    // Patch window.fetch to catch themes (e.g. Dawn) that never fire cart events
    this.patchFetch();

    // Standard Shopify cart change events (fallback / other themes)
    document.addEventListener("cart:updated", () => this.debouncedEvaluate.call());
    document.addEventListener("cart:refresh", () => this.debouncedEvaluate.call());
    document.addEventListener("theme:cart:open", () => this.debouncedEvaluate.call());

    // Our own events
    on(PromoEvents.CartChanged, () => {
      this.widgetChangedCart = true;
      this.debouncedEvaluate.call();
    });
  }

  private patchFetch(): void {
    const CART_MUTATE_RE = /\/cart\/(add|change|update)(\.js)?(\?|$)/;
    // Only /cart* requests are worth cloning+parsing — every other fetch on
    // the page (product data, app pixels, third-party scripts) was being
    // intercepted and JSON-parsed for nothing.
    const CART_RELATED_RE = /\/cart(\.js|\/(add|change|update)(\.js)?)?(\?|$)/;
    this.savedFetch = window.fetch.bind(window);
    const originalFetch = this.savedFetch;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const isCartMutation = method === "POST" && CART_MUTATE_RE.test(url);
      const isCartRelated = CART_RELATED_RE.test(url);

      const response = await originalFetch(input, init);

      if (response.ok && isCartRelated) {
        // Spy on any response that carries rendered section HTML.
        // Themes include sections in add/update responses (or in separate GET /cart?sections=…).
        // We capture the section IDs so refreshCartUI can reuse them later.
        const cloned = response.clone();
        cloned
          .json()
          .then((data: unknown) => {
            if (
              !this.refreshGuard &&
              data !== null &&
              typeof data === "object" &&
              "sections" in (data as object)
            ) {
              const s = (data as { sections?: Record<string, unknown> }).sections ?? {};
              const htmlKeys = Object.keys(s).filter(
                (k) => typeof s[k] === "string" && (s[k] as string).length > 0,
              );
              if (htmlKeys.length > 0) {
                this.capturedThemeSectionIds = htmlKeys;
                this.log("Theme section IDs captured:", htmlKeys.join(", "));
              }
            }
          })
          .catch(() => {});

        if (isCartMutation && !this.refreshGuard) {
          this.log(`[PromoEngine] Cart mutation detected (${url}) — scheduling evaluation`);
          this.debouncedEvaluate.call();
        }
      }

      return response;
    };
  }

  private async refreshCartUI(): Promise<void> {
    type CartDrawerEl = HTMLElement & {
      getSectionsToRender?: () => Array<{ id: string; selector?: string }>;
      getSectionInnerHTML?: (html: string, selector?: string) => string;
    };
    const cartDrawerEl = document.querySelector<CartDrawerEl>("cart-drawer");

    // ── Tier 0: Reuse section IDs captured from the theme's own renders ───
    // When the theme processes an add-to-cart it fetches /cart?sections=… or
    // includes sections in its /cart/add.js response. We sniff those IDs in
    // patchFetch and replay the same request here so the theme's DOM wrappers
    // get refreshed with the current cart state (including our gifts).
    const tier0 = this.capturedThemeSectionIds
      .map((id) => ({ sectionId: id, selector: `#shopify-section-${id}` }))
      .filter((t) => !!document.querySelector(t.selector));

    // ── Tier 1: Dawn-style web component (getSectionsToRender API) ────────
    const nativeTargets: Array<{ sectionId: string; selector: string }> =
      cartDrawerEl?.getSectionsToRender
        ? cartDrawerEl.getSectionsToRender().map((s) => ({
            sectionId: s.id,
            selector: s.selector ?? `#${s.id}`,
          }))
        : [];

    // ── Tier 2: Scan DOM for cart-related section wrappers ────────────────
    const CART_KEYWORDS = ["cart", "drawer", "mini"];
    const domSections: Array<{ sectionId: string; selector: string }> = [];
    document.querySelectorAll('[id^="shopify-section-"]').forEach((el) => {
      const sectionId = el.id.replace("shopify-section-", "");
      if (CART_KEYWORDS.some((kw) => sectionId.toLowerCase().includes(kw))) {
        domSections.push({ sectionId, selector: `#${el.id}` });
      }
    });

    // ── Tier 3: Hardcoded well-known cart section targets ────────────────
    const COMMON: Array<{ sectionId: string; selector: string }> = [
      { sectionId: "cart-drawer", selector: "#CartDrawer" },
      { sectionId: "cart-drawer", selector: "#shopify-section-cart-drawer" },
      { sectionId: "cart-icon-bubble", selector: "#cart-icon-bubble" },
      { sectionId: "mini-cart", selector: "#mini-cart" },
      { sectionId: "mini-cart", selector: '[data-section-id="mini-cart"]' },
      { sectionId: "cart", selector: "#shopify-section-cart" },
    ];

    // Tier 0 has highest priority; dedup and keep only DOM-present targets
    const seenSelectors = new Set<string>();
    const allTargets = [...tier0, ...nativeTargets, ...domSections, ...COMMON].filter((t) => {
      if (seenSelectors.has(t.selector)) return false;
      seenSelectors.add(t.selector);
      return !!document.querySelector(t.selector);
    });

    this.log(
      "refreshCartUI — targets:",
      allTargets.length > 0
        ? allTargets.map((t) => `${t.sectionId}→${t.selector}`).join(", ")
        : "none found",
    );

    if (allTargets.length > 0) {
      const sectionIds = [...new Set(allTargets.map((t) => t.sectionId))];
      try {
        // Section Rendering API: `/?sections=` returns `{ [id]: html }`. `/cart` with an
        // `Accept: application/json` header returns the cart JSON and ignores `sections`.
        const resp = await this.savedFetch(`/?sections=${sectionIds.join(",")}`);
        if (resp.ok) {
          const body = (await resp.json()) as Record<string, unknown>;
          const sections = Object.fromEntries(
            Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          );
          this.log(
            "refreshCartUI — section render response keys:",
            Object.keys(sections).join(", ") || "none (section IDs not valid for this theme)",
          );
          const data = { sections };
          if (Object.keys(sections).length > 0) {
            let updated = 0;
            for (const { sectionId, selector } of allTargets) {
              const rawHtml = data.sections[sectionId];
              if (!rawHtml) continue;
              const el = document.querySelector(selector);
              if (!el) continue;
              // Replace like Dawn does: take the same selector out of the rendered section, so a
              // section that contains its own wrapper (#CartDrawer inside <cart-drawer>) isn't nested.
              const rendered = new DOMParser().parseFromString(rawHtml, "text/html");
              const innerHtml =
                rendered.querySelector(selector)?.innerHTML ??
                rendered.querySelector(".shopify-section")?.innerHTML ??
                rawHtml;
              el.innerHTML = innerHtml;
              updated++;
            }
            if (updated > 0) {
              this.log(
                `[PromoEngine] Cart UI refreshed via section rendering (${updated} element(s))`,
              );
              return;
            }
          }
        }
      } catch {
        // fall through to events
      }
    }

    // ── Tier 4: Standard cart events ──────────────────────────────────────
    // Note: avoid calling /cart/update.js here — it triggers extra evaluations
    // via shop_events_listener's async event dispatch even with the guard set.
    this.log("refreshCartUI — falling back to DOM events");
    document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
    document.dispatchEvent(new CustomEvent("cart:updated", { bubbles: true }));
    document.dispatchEvent(new CustomEvent("theme:cart:add", { bubbles: true }));
  }

  private async triggerEvaluation(
    options: { force?: boolean; emitResult?: boolean } = {},
  ): Promise<EvaluationResult | null> {
    if (options.emitResult !== false) emit(PromoEvents.EvaluationRequested);

    let cart: CartData;
    try {
      cart = await AjaxCartAdapter.getCart();
    } catch (e) {
      this.log("Failed to fetch cart", e);
      return null;
    }

    const cartHash = this.buildCartHash(cart);
    if (!options.force && cartHash === this.lastCartHash) {
      this.log("Cart unchanged, skipping evaluation");
      if (this.widgetChangedCart) {
        this.widgetChangedCart = false;
        await this.refreshCartUI();
      }
      return this.lastEvaluationResult;
    }

    const qualifyingSubtotal = cart.items_subtotal_price ?? cart.total_price;
    this.log(
      "[PromoEngine] Evaluating cart —",
      cart.items.map((i) => `${i.title} ×${i.quantity}`).join(", ") || "empty",
      `| subtotal: $${(qualifyingSubtotal / 100).toFixed(2)}`,
    );

    const signal = this.evaluationAbort.start();

    // Liquid provides the real Market GID. Currency alone is not a Market id.
    const shopifyGlobal = window.Shopify;
    const market = buildMarketContext(this.config, shopifyGlobal);

    try {
      const response = await fetch(this.evalEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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
      this.lastEvaluationResult = result;

      const actions = Array.isArray(result.cartActions) ? result.cartActions : [];
      if (actions.length > 0) {
        this.log(
          "[PromoEngine] Cart actions to apply:",
          actions
            .map((a) => `${a.action}(${a.variantId ?? a.lineKey ?? ""}×${a.quantity ?? 0})`)
            .join(", "),
        );
      } else {
        this.log("[PromoEngine] Evaluation complete — no cart actions");
      }

      await this.applyCartActions(actions);
      if (actions.length > 0 || this.widgetChangedCart) {
        this.widgetChangedCart = false;
        await this.refreshCartUI();
      }
      if (options.emitResult !== false) emit(PromoEvents.EvaluationCompleted, result);
      return result;
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") {
        this.log("Evaluation aborted (superseded by newer request)");
        return null;
      }
      this.log("Evaluation error", e);
      emit(PromoEvents.CartMutationError, { error: (e as Error).message });
      return null;
    }
  }

  private async applyCartActions(actions: CartAction[]): Promise<void> {
    for (const action of actions) {
      try {
        switch (action.action) {
          case "add_line": {
            if (!action.variantId) break;
            this.log(
              `[PromoEngine] → add_line variantId=${action.variantId} qty=${action.quantity ?? 1}`,
            );
            await AjaxCartAdapter.addLines([
              {
                variantId: action.variantId,
                quantity: action.quantity ?? 1,
                properties: action.properties ?? {},
              },
            ]);
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
            this.log(
              `[PromoEngine] → update_line key=${action.lineKey ?? "?"} qty=${action.quantity ?? 1}`,
            );
            const freshCart = await fetchFreshCart();
            const currentLine =
              freshCart.items.find((item) => item.key === action.lineKey) ??
              (action.offerId ? findGiftLineByOfferId(freshCart, action.offerId) : null);
            const lineKey =
              currentLine?.key ??
              (action.variantId
                ? resolveLineKey(
                    freshCart,
                    parseInt(action.variantId.split("/").pop() ?? action.variantId, 10),
                    action.properties ?? {},
                  )
                : null);
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
            this.log(
              `[PromoEngine] → remove_line key=${action.lineKey ?? "?"} reason=${action.reason ?? "offer_disqualified"}`,
            );
            const freshCart = await fetchFreshCart();
            const currentLine =
              freshCart.items.find((item) => item.key === action.lineKey) ??
              (action.offerId ? findGiftLineByOfferId(freshCart, action.offerId) : null);
            const lineKey =
              currentLine?.key ??
              (action.variantId
                ? resolveLineKey(
                    freshCart,
                    parseInt(action.variantId.split("/").pop() ?? action.variantId, 10),
                    action.properties ?? {},
                  )
                : null);
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
      ...cart.items
        .map((item) => {
          const properties = Object.entries(item.properties ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(",");
          return [
            item.key,
            item.variant_id,
            item.quantity,
            item.final_price ?? item.price,
            item.final_line_price ?? item.line_price ?? item.price * item.quantity,
            properties,
          ].join(":");
        })
        .sort(),
      String(cart.items_subtotal_price ?? cart.total_price),
      ...(cart.discount_codes?.map((discount) => discount.code).sort() ?? []),
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
        priceCents: item.final_price ?? item.price,
        lineSubtotalCents: item.final_line_price ?? item.line_price ?? item.price * item.quantity,
        compareAtPriceCents: null,
        properties: item.properties ?? {},
        requiresSellingPlan: item.requires_selling_plan ?? false,
        sellingPlanId: item.selling_plan_allocation ? "has-plan" : null,
        productHandle: item.handle,
        productTitle: item.title,
        variantTitle: item.variant_title,
        vendor: item.vendor,
        productType: item.product_type,
        tags: item.tags ? item.tags.split(", ") : [],
        collections: [],
        availableForSale: item.available ?? true,
        inventoryPolicy: item.inventory_policy?.toUpperCase() === "CONTINUE" ? "CONTINUE" : "DENY",
        inventoryQuantity: item.inventory_quantity ?? 0,
      })),
      attributes: cart.attributes ?? {},
      subtotalCents: cart.items_subtotal_price ?? cart.total_price,
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
    validateGiftOffer: async (offerId: string) => {
      const result = await this.triggerEvaluation({ force: true, emitResult: false });
      return result?.giftSlider?.offerId === offerId ? result.giftSlider : null;
    },
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
    // Called directly by theme blocks (fbt.liquid) that mount a widget into a
    // specific container rather than reacting to a runtime-wide event.
    initFbtWidget?: typeof initFbtWidget;
    initBundleBuilder?: typeof initBundleBuilder;
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
  // Exposed as its own global (not nested under PromoEngine) because blocks
  // like fbt.liquid poll for `window.initFbtWidget` directly.
  window.initFbtWidget = initFbtWidget;
  window.initBundleBuilder = initBundleBuilder;
  initGiftSlider(getOrCreateSessionId());
  runtime.init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initRuntime);
} else {
  initRuntime();
}

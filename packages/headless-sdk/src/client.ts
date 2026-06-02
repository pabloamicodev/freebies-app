/**
 * Promo Engine Headless SDK Client
 * For use in Hydrogen, custom React storefronts, and native mobile.
 * Does NOT depend on window / document — safe for SSR.
 */

import type { EvaluationResult } from "@promo/shared-types";

export interface PromoClientConfig {
  storeDomain: string;
  publicKey: string;
  locale?: string;
  /** Override the evaluation endpoint (default: /apps/promo-engine/evaluate). */
  apiBase?: string;
}

export interface EvaluateOptions {
  cart: HeadlessCart;
  customer?: HeadlessCustomer;
  marketId?: string;
  currencyCode?: string;
  countryCode?: string;
  sessionId?: string;
  salesChannel?: "online_store" | "headless" | "mobile_app" | "pos";
}

export interface HeadlessCart {
  id?: string;
  token?: string;
  lines: HeadlessCartLine[];
  currencyCode: string;
  discountCodes?: string[];
}

export interface HeadlessCartLine {
  variantId: string;
  productId: string;
  quantity: number;
  price: number;
  properties?: Record<string, string>;
  requiresSellingPlan?: boolean;
  sellingPlanId?: string | null;
  productHandle?: string;
  productTitle?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  collections?: string[];
}

export interface HeadlessCustomer {
  id: string;
  tags?: string[];
  totalSpentCents?: number;
  totalOrders?: number;
  lastOrderSpentCents?: number;
  countryCode?: string;
  isFirstTimeCustomer?: boolean;
}

export class PromoEngineClient {
  private config: Required<PromoClientConfig>;

  constructor(config: PromoClientConfig) {
    this.config = {
      locale: "en",
      apiBase: "/apps/promo-engine",
      ...config,
    };
  }

  /**
   * Evaluate all active offers for the current cart.
   * Returns qualified offers, cart actions, widgets, and messages.
   */
  async evaluate(options: EvaluateOptions): Promise<EvaluationResult> {
    const response = await fetch(`${this.config.apiBase}/evaluate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Promo-Shop": this.config.storeDomain,
        "X-Promo-Key": this.config.publicKey,
        "X-Promo-Session": options.sessionId ?? "headless",
      },
      body: JSON.stringify({
        shopDomain: this.config.storeDomain,
        cart: this.normalizeCart(options.cart),
        customer: options.customer ?? null,
        market: options.marketId
          ? {
              id: options.marketId,
              handle: "",
              currencyCode: options.currencyCode ?? options.cart.currencyCode,
              countryCode: options.countryCode ?? null,
              primaryLocale: this.config.locale,
            }
          : null,
        locale: this.config.locale,
        salesChannel: options.salesChannel ?? "headless",
        requestedUrl: null,
        sessionId: options.sessionId ?? "headless",
      }),
    });

    if (!response.ok) {
      throw new Error(`Promo Engine evaluation failed: ${response.status}`);
    }

    return response.json() as Promise<EvaluationResult>;
  }

  /** Pre-checkout cart stabilization — call before redirecting to checkout. */
  async prepareCheckout(options: EvaluateOptions): Promise<{ ready: boolean; message?: string }> {
    const response = await fetch(`${this.config.apiBase}/prepare-checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Promo-Shop": this.config.storeDomain,
        "X-Promo-Key": this.config.publicKey,
        "X-Promo-Session": options.sessionId ?? "headless",
      },
      body: JSON.stringify({
        shopDomain: this.config.storeDomain,
        cart: this.normalizeCart(options.cart),
        customer: options.customer ?? null,
        market: null,
        locale: this.config.locale,
        salesChannel: options.salesChannel ?? "headless",
        requestedUrl: null,
        sessionId: options.sessionId ?? "headless",
      }),
    });

    if (!response.ok) return { ready: false };
    return response.json() as Promise<{ ready: boolean; message?: string }>;
  }

  /** Report an analytics event to the promo engine. */
  async track(eventName: string, payload: Record<string, unknown>): Promise<void> {
    // Fire and forget
    navigator.sendBeacon(
      `${this.config.apiBase}/analytics`,
      JSON.stringify({
        events: [
          {
            event_name: eventName,
            shop_domain: this.config.storeDomain,
            occurred_at: new Date().toISOString(),
            ...payload,
          },
        ],
      }),
    );
  }

  private normalizeCart(cart: HeadlessCart) {
    return {
      token: cart.token ?? null,
      id: cart.id ?? null,
      lines: cart.lines.map((l, i) => ({
        key: `headless-line-${i}`,
        variantId: l.variantId,
        productId: l.productId,
        quantity: l.quantity,
        priceCents: Math.round(l.price * 100),
        compareAtPriceCents: null,
        properties: l.properties ?? {},
        requiresSellingPlan: l.requiresSellingPlan ?? false,
        sellingPlanId: l.sellingPlanId ?? null,
        productHandle: l.productHandle ?? "",
        productTitle: l.productTitle ?? "",
        variantTitle: null,
        vendor: l.vendor ?? "",
        productType: l.productType ?? "",
        tags: l.tags ?? [],
        collections: l.collections ?? [],
        availableForSale: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: null,
      })),
      subtotalCents: cart.lines.reduce((acc, l) => acc + Math.round(l.price * 100) * l.quantity, 0),
      discountCodes: cart.discountCodes ?? [],
      currencyCode: cart.currencyCode,
      totalQuantity: cart.lines.reduce((acc, l) => acc + l.quantity, 0),
    };
  }
}

export function createPromoClient(config: PromoClientConfig): PromoEngineClient {
  return new PromoEngineClient(config);
}

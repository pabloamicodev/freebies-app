/**
 * Cart Message — vanilla JS Web Component.
 * Usage: <promo-cart-message offer-id="..." widget-id="..."></promo-cart-message>
 * Renders qualification/success/info messages based on evaluation results.
 */

import { on, PromoEvents } from "../event-bus.js";
import type { EvaluationResult, CartMessagePayload } from "../types.js";

class PromoCartMessage extends HTMLElement {
  private offerId: string = "";
  private widgetId: string = "";
  private unsubscribe: (() => void) | null = null;

  connectedCallback() {
    this.offerId = this.getAttribute("offer-id") ?? "";
    this.widgetId = this.getAttribute("widget-id") ?? "";

    this.attachShadow({ mode: "open" });
    this.render(null);

    this.unsubscribe = on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
      const messages = (Array.isArray(result.cartMessages) ? result.cartMessages : [])
        .filter((m) => m.offerId === this.offerId || m.widgetId === this.widgetId)
        .sort((a, b) => a.priority - b.priority);

      this.render(messages[0] ?? null);
    });
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  private render(payload: CartMessagePayload | null) {
    if (!this.shadowRoot) return;

    if (!payload) {
      this.shadowRoot.innerHTML = `<style>:host { display: none; }</style>`;
      return;
    }

    const typeColors: Record<string, string> = {
      progress: "#f59e0b",
      success: "#059669",
      info: "#3b82f6",
    };
    const color = typeColors[payload.type] ?? "#111";

    // Sanitize message — strip all HTML tags to prevent XSS
    const safeMessage = this.sanitize(payload.message);

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .pe-msg {
          padding: 10px 14px;
          border-left: 3px solid ${color};
          background: ${color}18;
          border-radius: 0 6px 6px 0;
          font-size: 13px;
          line-height: 1.5;
          color: inherit;
        }
      </style>
      <div class="pe-msg" role="status" aria-live="polite">${safeMessage}</div>
    `;
  }

  private sanitize(raw: string): string {
    const div = document.createElement("div");
    div.textContent = raw;
    return div.innerHTML;
  }
}

customElements.define("promo-cart-message", PromoCartMessage);

export {};

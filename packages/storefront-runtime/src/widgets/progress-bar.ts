/**
 * Progress Bar — vanilla JS Web Component.
 * Usage: <promo-progress-bar offer-id="..." widget-id="..."></promo-progress-bar>
 * Listens for EvaluationCompleted events and re-renders automatically.
 */

import { on, PromoEvents } from "../event-bus.js";
import type { EvaluationResult, ProgressBarPayload } from "../types.js";

class PromoProgressBar extends HTMLElement {
  private offerId: string = "";
  private widgetId: string = "";
  private unsubscribe: (() => void) | null = null;

  connectedCallback() {
    this.offerId = this.getAttribute("offer-id") ?? "";
    this.widgetId = this.getAttribute("widget-id") ?? "";

    this.attachShadow({ mode: "open" });
    this.renderSkeleton();

    this.unsubscribe = on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
      const payload = (Array.isArray(result.progressBars) ? result.progressBars : []).find(
        (pb) => pb.offerId === this.offerId || pb.widgetId === this.widgetId,
      );
      if (payload) this.renderPayload(payload);
    });
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  private renderSkeleton() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: inherit; }
        .pe-pb-wrap { padding: 12px 0; }
        .pe-pb-msg { font-size: 14px; margin-bottom: 8px; color: inherit; }
        .pe-pb-track {
          background: #e5e7eb; border-radius: 999px; height: 6px; overflow: hidden;
        }
        .pe-pb-fill {
          background: #111; height: 100%; border-radius: 999px;
          transition: width .4s ease; width: 0%;
        }
        .pe-pb-fill.pe-goal { background: #059669; }
      </style>
      <div class="pe-pb-wrap" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
        <p class="pe-pb-msg"></p>
        <div class="pe-pb-track"><div class="pe-pb-fill"></div></div>
      </div>
    `;
  }

  private renderPayload(payload: ProgressBarPayload) {
    if (!this.shadowRoot) return;
    const wrap = this.shadowRoot.querySelector(".pe-pb-wrap") as HTMLElement;
    const msg = this.shadowRoot.querySelector(".pe-pb-msg") as HTMLElement;
    const fill = this.shadowRoot.querySelector(".pe-pb-fill") as HTMLElement;

    if (!wrap || !msg || !fill) return;

    const pct = Math.min(100, Math.round(payload.progressPercent));
    const message = payload.isGoalReached ? payload.messageAfterGoal : payload.messageBeforeGoal;

    msg.textContent = this.interpolateMessage(message, payload);
    fill.style.width = `${pct}%`;
    fill.classList.toggle("pe-goal", payload.isGoalReached);
    wrap.setAttribute("aria-valuenow", String(pct));
    this.setAttribute("aria-label", `Progress: ${pct}%`);
  }

  private interpolateMessage(template: string, payload: ProgressBarPayload): string {
    const remainingCents = payload.targetCents - payload.currentCents;
    const remainingQty = (payload.targetQuantity ?? 0) - payload.currentQuantity;
    const currency = this.getAttribute("currency") ?? "USD";

    const formatMoney = (cents: number) =>
      new Intl.NumberFormat(navigator.language, { style: "currency", currency }).format(cents / 100);

    return template
      .replace("{{remaining_amount}}", formatMoney(Math.max(0, remainingCents)))
      .replace("{{remaining_quantity}}", String(Math.max(0, remainingQty)))
      .replace("{{current_amount}}", formatMoney(payload.currentCents))
      .replace("{{target_amount}}", formatMoney(payload.targetCents));
  }
}

customElements.define("promo-progress-bar", PromoProgressBar);

export {};

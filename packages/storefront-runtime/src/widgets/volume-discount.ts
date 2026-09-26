/**
 * Volume Discount — vanilla JS Web Component.
 * Usage: <promo-volume-discount offer-id="..." variant-id="..."></promo-volume-discount>
 *
 * Shows quantity tiers on product pages.
 * Rerenders when variant changes.
 */

import { on, PromoEvents } from "../event-bus.js";
import { escapeHtml } from "../html.js";

interface VolumeTier {
  minQuantity: number;
  label: string;
  discountType: "percentage" | "fixed_amount" | "fixed_price";
  discountValue: number;
  originalPriceCents: number;
  discountedPriceCents: number;
}

interface VolumeDiscountPayload {
  offerId: string;
  variantId: string;
  tiers: VolumeTier[];
  currency: string;
}

const STYLES = `
:host { display: block; }
.pe-vd-wrap { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin: 16px 0; }
.pe-vd-title { padding: 10px 14px; background: #f9fafb; font-size: 13px; font-weight: 700; border-bottom: 1px solid #e5e7eb; }
.pe-vd-tier {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid #f3f4f6; cursor: pointer;
  transition: background .1s; width: 100%; background: transparent;
  color: inherit; font: inherit; text-align: left;
}
.pe-vd-tier:last-child { border-bottom: none; }
.pe-vd-tier:hover { background: #f9fafb; }
.pe-vd-tier.pe-active { background: #f0fdf4; border-left: 3px solid #059669; }
.pe-vd-qty { font-size: 14px; font-weight: 600; }
.pe-vd-label { font-size: 12px; color: #059669; font-weight: 700; background: #dcfce7; padding: 2px 8px; border-radius: 999px; }
.pe-vd-price { text-align: right; }
.pe-vd-price-original { font-size: 12px; color: #9ca3af; text-decoration: line-through; }
.pe-vd-price-discounted { font-size: 14px; font-weight: 700; color: #059669; }
`;

class PromoVolumeDiscount extends HTMLElement {
  private offerId: string = "";
  private variantId: string = "";
  private currency: string = "USD";
  private unsubscribeVariant: (() => void) | null = null;
  private abortController: AbortController | null = null;

  connectedCallback() {
    this.offerId = this.getAttribute("offer-id") ?? "";
    this.variantId = this.getAttribute("variant-id") ?? "";
    this.currency = this.getAttribute("currency") ?? "USD";

    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    void this.loadAndRender();

    // Listen for variant changes (product page variant selector)
    this.unsubscribeVariant = on<{ variantId: string }>(
      PromoEvents.ProductChanged,
      (detail) => {
        this.variantId = detail.variantId;
        this.setAttribute("variant-id", detail.variantId);
        void this.loadAndRender();
      },
    );
  }

  disconnectedCallback() {
    this.unsubscribeVariant?.();
    this.abortController?.abort();
  }

  private async loadAndRender() {
    if (!this.offerId || !this.variantId) return;
    if (!this.shadowRoot) return;

    // A newer variant selection supersedes any in-flight request so a slow,
    // stale response can't land after a faster, newer one and overwrite it.
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    try {
      const response = await fetch(
        `/apps/promo-engine/product-customizations?offer_id=${encodeURIComponent(this.offerId)}&variant_id=${encodeURIComponent(this.variantId)}`,
        { headers: { Accept: "application/json" }, signal: controller.signal },
      );
      if (controller.signal.aborted) return;

      if (!response.ok) { this.renderEmpty(); return; }

      const data = await response.json() as { volumeDiscount?: VolumeDiscountPayload };
      if (controller.signal.aborted) return;

      if (data.volumeDiscount) {
        this.renderTiers(data.volumeDiscount);
      } else {
        this.renderEmpty();
      }
    } catch {
      if (!controller.signal.aborted) this.renderEmpty();
    }
  }

  private renderTiers(payload: VolumeDiscountPayload) {
    if (!this.shadowRoot) return;

    const fmt = (cents: number) =>
      new Intl.NumberFormat(navigator.language, {
        style: "currency",
        currency: payload.currency,
      }).format(cents / 100);

    const tiersHtml = payload.tiers
      .map((tier, i) => {
        const quantity = Number.isSafeInteger(tier.minQuantity) && tier.minQuantity > 0
          ? tier.minQuantity
          : 1;
        const discountedPrice = fmt(tier.discountedPriceCents);
        const originalPrice = fmt(tier.originalPriceCents);
        const label = tier.label || (tier.discountType === "percentage" ? `-${Math.round(tier.discountValue)}%` : "Deal");
        return `
        <button type="button" class="pe-vd-tier ${i === 0 ? "pe-active" : ""}"
             data-qty="${quantity}"
             aria-label="${escapeHtml(`Buy ${quantity}+ for ${discountedPrice} each`)}">
          <div>
            <p class="pe-vd-qty">${quantity === 1 ? "1 item" : `${quantity}+ items`}</p>
          </div>
          <span class="pe-vd-label">${escapeHtml(label)}</span>
          <div class="pe-vd-price">
            ${tier.originalPriceCents !== tier.discountedPriceCents
              ? `<p class="pe-vd-price-original">${escapeHtml(originalPrice)}</p>` : ""}
            <p class="pe-vd-price-discounted">${escapeHtml(discountedPrice)} each</p>
          </div>
        </button>`;
      })
      .join("");

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="pe-vd-wrap">
        <div class="pe-vd-title">Volume Discounts</div>
        ${tiersHtml}
      </div>
    `;

    // Add click handlers for tier selection
    this.shadowRoot.querySelectorAll(".pe-vd-tier").forEach((el) => {
      el.addEventListener("click", () => {
        // Update quantity input on product page
        const qty = parseInt((el as HTMLElement).dataset["qty"] ?? "1", 10);
        const qtyInput = document.querySelector<HTMLInputElement>('input[name="quantity"]');
        if (qtyInput) {
          qtyInput.value = String(qty);
          qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // Update active state
        this.shadowRoot?.querySelectorAll(".pe-vd-tier").forEach((t) => t.classList.remove("pe-active"));
        el.classList.add("pe-active");
      });
    });
  }

  private renderEmpty() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `<style>:host { display: none; }</style>`;
  }
}

if (!customElements.get("promo-volume-discount")) {
  customElements.define("promo-volume-discount", PromoVolumeDiscount);
}

export {};

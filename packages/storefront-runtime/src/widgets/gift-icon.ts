/**
 * Gift Icon + Gift Thumbnail — vanilla JS Web Components.
 * Placed on product pages to indicate a gift offer is available.
 *
 * Usage:
 *   <promo-gift-icon offer-id="..." variant-id="..."></promo-gift-icon>
 *   <promo-gift-thumbnail offer-id="..." variant-id="..."></promo-gift-thumbnail>
 */

import { on, emit, PromoEvents, publishAnalytics } from "../event-bus.js";
import type { EvaluationResult } from "../types.js";

// ── Gift Icon ─────────────────────────────────────────────────────────────────

const ICON_STYLES = `
:host { display: inline-block; }
.pe-gift-icon-wrap {
  display: inline-flex; align-items: center; gap: 6px;
  background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 999px;
  padding: 4px 12px; font-size: 13px; font-weight: 600; color: #059669;
  cursor: pointer; transition: background .15s;
}
.pe-gift-icon-wrap:hover { background: #dcfce7; }
.pe-gift-icon-wrap.pe-hidden { display: none; }
.pe-gift-emoji { font-size: 15px; }
`;

class PromoGiftIcon extends HTMLElement {
  private offerId: string = "";
  private variantId: string = "";
  private unsubscribe: (() => void) | null = null;

  connectedCallback() {
    this.offerId = this.getAttribute("offer-id") ?? "";
    this.variantId = this.getAttribute("variant-id") ?? "";
    this.attachShadow({ mode: "open" });
    this.render(null);

    this.unsubscribe = on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
      const qualified = result.qualifiedOffers.find((o) => o.offerId === this.offerId);
      this.render(qualified ? { offerName: "Free Gift Available" } : null);
    });

    // Also listen for variant changes on product page
    on<{ variantId: string }>(PromoEvents.ProductChanged, (detail) => {
      this.variantId = detail.variantId;
    });
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  private render(offer: { offerName: string } | null) {
    if (!this.shadowRoot) return;
    const customText = this.getAttribute("label") ?? "Free Gift";
    const countdownSeconds = parseInt(this.getAttribute("countdown-seconds") ?? "0", 10);

    this.shadowRoot.innerHTML = `
      <style>${ICON_STYLES}</style>
      <div class="pe-gift-icon-wrap${offer ? "" : " pe-hidden"}"
           role="button" tabindex="0"
           aria-label="View free gift offer"
           title="${offer?.offerName ?? ""}">
        <span class="pe-gift-emoji" aria-hidden="true">🎁</span>
        <span>${customText}</span>
        ${countdownSeconds > 0 ? `<span class="pe-countdown" id="cd-${this.offerId}"></span>` : ""}
      </div>
    `;

    if (offer) {
      this.shadowRoot.querySelector(".pe-gift-icon-wrap")?.addEventListener("click", () => {
        emit(PromoEvents.GiftSliderRequested, { offerId: this.offerId });
        publishAnalytics("promo_engine:widget_clicked", {
          offer_id: this.offerId,
          widget_type: "gift_icon",
        });
      });

      if (countdownSeconds > 0) this.startCountdown(countdownSeconds);
    }
  }

  private startCountdown(seconds: number) {
    if (!this.shadowRoot) return;
    let remaining = seconds;
    const update = () => {
      const el = this.shadowRoot?.getElementById(`cd-${this.offerId}`);
      if (!el) return;
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      el.textContent = ` (${m}:${String(s).padStart(2, "0")})`;
      remaining--;
      if (remaining >= 0) setTimeout(update, 1000);
    };
    update();
  }
}

customElements.define("promo-gift-icon", PromoGiftIcon);

// ── Gift Thumbnail ────────────────────────────────────────────────────────────

const THUMBNAIL_STYLES = `
:host { display: block; }
.pe-thumb-wrap {
  border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px;
  background: #fff; max-width: 280px;
}
.pe-thumb-wrap.pe-hidden { display: none; }
.pe-thumb-offer-name { font-size: 11px; font-weight: 700; color: #059669; text-transform: uppercase; letter-spacing: .5px; margin: 0 0 8px; }
.pe-thumb-products { display: flex; gap: 6px; flex-wrap: wrap; }
.pe-thumb-product { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.pe-thumb-img { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid #e5e7eb; }
.pe-thumb-img-ph { width: 48px; height: 48px; background: #f3f4f6; border-radius: 4px; border: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: center; font-size: 20px; }
.pe-thumb-name { font-size: 10px; color: #374151; text-align: center; max-width: 56px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-thumb-count { font-size: 12px; color: #6b7280; margin-top: 6px; }
.pe-thumb-cta { margin-top: 8px; font-size: 12px; color: #111; font-weight: 600; cursor: pointer; text-decoration: underline; }
`;

class PromoGiftThumbnail extends HTMLElement {
  private offerId: string = "";
  private unsubscribe: (() => void) | null = null;

  connectedCallback() {
    this.offerId = this.getAttribute("offer-id") ?? "";
    this.attachShadow({ mode: "open" });
    this.render(null);

    this.unsubscribe = on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
      const qualified = result.qualifiedOffers.find((o) => o.offerId === this.offerId);
      const giftSlider = result.giftSlider;
      this.render(qualified && giftSlider ? giftSlider.selectableGifts : null);
    });
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  private render(gifts: Array<{ title: string; imageUrl: string | null; variantId: string }> | null) {
    if (!this.shadowRoot) return;

    if (!gifts || gifts.length === 0) {
      this.shadowRoot.innerHTML = `<style>${THUMBNAIL_STYLES}</style><div class="pe-thumb-wrap pe-hidden"></div>`;
      return;
    }

    const displayGifts = gifts.slice(0, 4);
    const productsHtml = displayGifts
      .map((g) =>
        g.imageUrl
          ? `<div class="pe-thumb-product">
               <img class="pe-thumb-img" src="${g.imageUrl}" alt="${g.title}" loading="lazy"/>
               <span class="pe-thumb-name">${g.title}</span>
             </div>`
          : `<div class="pe-thumb-product">
               <div class="pe-thumb-img-ph" aria-hidden="true">🎁</div>
               <span class="pe-thumb-name">${g.title}</span>
             </div>`,
      )
      .join("");

    this.shadowRoot.innerHTML = `
      <style>${THUMBNAIL_STYLES}</style>
      <div class="pe-thumb-wrap">
        <p class="pe-thumb-offer-name">🎁 Free Gift</p>
        <div class="pe-thumb-products">${productsHtml}</div>
        ${gifts.length > 4 ? `<p class="pe-thumb-count">+${gifts.length - 4} more gifts available</p>` : ""}
        <p class="pe-thumb-cta" role="button" tabindex="0">Choose your gift →</p>
      </div>
    `;

    this.shadowRoot.querySelector(".pe-thumb-cta")?.addEventListener("click", () => {
      emit(PromoEvents.GiftSliderRequested, { offerId: this.offerId });
    });
  }
}

customElements.define("promo-gift-thumbnail", PromoGiftThumbnail);

export {};

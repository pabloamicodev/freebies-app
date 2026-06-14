/**
 * Today Offer Block — inline Web Component version.
 * Unlike the floating today-offer.tsx widget, this is a static block
 * placed via theme editor in a specific position on the page.
 *
 * Usage: <promo-today-offer-block offer-ids="offer-1,offer-2"></promo-today-offer-block>
 */

import { on, PromoEvents, publishAnalytics } from "../event-bus.js";
import type { EvaluationResult } from "../types.js";

function escapeHtml(raw: unknown): string {
  const div = document.createElement("div");
  div.textContent = String(raw ?? "");
  return div.innerHTML;
}

function safeImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const BLOCK_STYLES = `
:host { display: block; }
.pe-tob-wrap { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
.pe-tob-header { background: #111; color: #fff; padding: 10px 14px; font-size: 13px; font-weight: 700; }
.pe-tob-items { }
.pe-tob-item {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px;
  border-bottom: 1px solid #f3f4f6; cursor: pointer; transition: background .12s;
  text-decoration: none; color: inherit;
}
.pe-tob-item:last-child { border-bottom: none; }
.pe-tob-item:hover { background: #f9fafb; }
.pe-tob-img { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; background: #f3f4f6; flex-shrink: 0; }
.pe-tob-info { flex: 1; min-width: 0; }
.pe-tob-title { font-size: 13px; font-weight: 600; margin: 0; }
.pe-tob-desc { font-size: 11px; color: #6b7280; margin: 2px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-tob-badge { font-size: 11px; color: #059669; font-weight: 700; flex-shrink: 0; }
.pe-tob-empty { display: none; }
`;

class PromoTodayOfferBlock extends HTMLElement {
  private filterOfferIds: string[] = [];
  private unsubscribe: (() => void) | null = null;

  connectedCallback() {
    const ids = this.getAttribute("offer-ids");
    this.filterOfferIds = ids ? ids.split(",").map((s) => s.trim()) : [];
    this.attachShadow({ mode: "open" });
    this.render([]);

    this.unsubscribe = on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
      let items = Array.isArray(result.qualifiedOffers) ? result.qualifiedOffers : [];
      if (this.filterOfferIds.length > 0) {
        items = items.filter((o) => this.filterOfferIds.includes(o.offerId));
      }
      this.render(items.map((o) => ({
        offerId: o.offerId,
        title: o.type,
        description: "",
        imageUrl: null,
        badgeText: "Active",
      })));
    });
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  private render(items: Array<{ offerId: string; title: string; description: string; imageUrl: string | null; badgeText: string }>) {
    if (!this.shadowRoot) return;

    const title = escapeHtml(this.getAttribute("title") ?? "Today's Offers");

    if (items.length === 0) {
      this.shadowRoot.innerHTML = `<style>${BLOCK_STYLES}</style><div class="pe-tob-empty"></div>`;
      return;
    }

    const itemsHtml = items.map((item) => {
      const offerId = escapeHtml(item.offerId);
      const itemTitle = escapeHtml(item.title);
      const description = escapeHtml(item.description);
      const badgeText = escapeHtml(item.badgeText);
      const imageUrl = safeImageUrl(item.imageUrl);

      return `
      <div class="pe-tob-item" data-offer="${offerId}" role="button" tabindex="0">
        ${imageUrl
          ? `<img class="pe-tob-img" src="${imageUrl}" alt="${itemTitle}" loading="lazy">`
          : `<div class="pe-tob-img" aria-hidden="true">🎁</div>`
        }
        <div class="pe-tob-info">
          <p class="pe-tob-title">${itemTitle}</p>
          ${description ? `<p class="pe-tob-desc">${description}</p>` : ""}
        </div>
        <span class="pe-tob-badge">${badgeText}</span>
      </div>
    `;
    }).join("");

    this.shadowRoot.innerHTML = `
      <style>${BLOCK_STYLES}</style>
      <div class="pe-tob-wrap">
        <div class="pe-tob-header">${title}</div>
        <div class="pe-tob-items">${itemsHtml}</div>
      </div>
    `;

    this.shadowRoot.querySelectorAll(".pe-tob-item").forEach((el) => {
      const offerId = (el as HTMLElement).dataset["offer"] ?? "";
      el.addEventListener("click", () => {
        publishAnalytics("promo_engine:widget_clicked", {
          offer_id: offerId,
          widget_type: "today_offer_block",
        });
      });
    });
  }
}

customElements.define("promo-today-offer-block", PromoTodayOfferBlock);

export {};

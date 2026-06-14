// NOTE: This file uses Preact JSX (class= not className=, style strings not objects).
// @jsxImportSource preact is required — do not replace with React imports.
/** @jsxImportSource preact */
import { useState, useEffect } from "preact/hooks";
import { h, Fragment } from "preact";
import { render } from "preact";
import { on, emit, PromoEvents, publishAnalytics } from "../event-bus.js";
import { AjaxCartAdapter } from "../cart-adapter.js";
import type { GiftSliderPayload, SelectableGift, EvaluationResult } from "../types.js";

// ─── Styles — injected once ───────────────────────────────────────────────────

const SLIDER_STYLES = `
.pe-slider-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.4);
  z-index: 9999; display: flex; align-items: flex-end; justify-content: center;
}
@media (min-width: 768px) {
  .pe-slider-overlay { align-items: center; }
}
.pe-slider-modal {
  background: #fff; border-radius: 12px 12px 0 0; width: 100%; max-width: 540px;
  max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 -4px 24px rgba(0,0,0,.15);
}
@media (min-width: 768px) {
  .pe-slider-modal { border-radius: 12px; max-height: 640px; }
}
.pe-slider-header {
  padding: 20px 20px 12px; border-bottom: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: flex-start;
}
.pe-slider-title { font-size: 18px; font-weight: 700; margin: 0; }
.pe-slider-subtitle { font-size: 13px; color: #6b7280; margin: 4px 0 0; }
.pe-slider-close {
  background: none; border: none; font-size: 20px; cursor: pointer;
  color: #6b7280; padding: 0 4px; line-height: 1;
}
.pe-slider-body { overflow-y: auto; padding: 16px; flex: 1; }
.pe-gift-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@media (min-width: 480px) {
  .pe-gift-grid { grid-template-columns: repeat(3, 1fr); }
}
.pe-gift-card {
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 12px 10px;
  cursor: pointer; transition: border-color .15s, box-shadow .15s; position: relative;
}
.pe-gift-card:hover:not(.pe-unavailable) { border-color: #111; }
.pe-gift-card.pe-selected { border-color: #111; background: #f9f9f9; }
.pe-gift-card.pe-unavailable { opacity: .5; cursor: not-allowed; }
.pe-gift-check {
  position: absolute; top: 8px; right: 8px; width: 20px; height: 20px;
  background: #111; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; color: #fff; font-size: 12px;
}
.pe-gift-img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; background: #f3f4f6; }
.pe-gift-img-placeholder { width: 100%; aspect-ratio: 1; background: #f3f4f6; border-radius: 4px; }
.pe-gift-name { font-size: 13px; font-weight: 600; margin: 8px 0 2px; line-height: 1.3; }
.pe-gift-variant { font-size: 11px; color: #6b7280; margin: 0; }
.pe-gift-price { font-size: 12px; color: #6b7280; margin: 4px 0 0; }
.pe-gift-price s { opacity: .6; }
.pe-gift-free { color: #059669; font-weight: 700; }
.pe-slider-footer {
  padding: 14px 20px; border-top: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.pe-selected-count { font-size: 13px; color: #6b7280; }
.pe-btn-confirm {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background .15s; flex: 1;
}
.pe-btn-confirm:hover { background: #333; }
.pe-btn-confirm:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-loading { display: flex; align-items: center; justify-content: center; padding: 40px; }
.pe-spinner {
  width: 28px; height: 28px; border: 3px solid #e5e7eb;
  border-top-color: #111; border-radius: 50%; animation: pe-spin .7s linear infinite;
}
@keyframes pe-spin { to { transform: rotate(360deg); } }
`;

function injectStyles() {
  if (document.getElementById("pe-slider-styles")) return;
  const style = document.createElement("style");
  style.id = "pe-slider-styles";
  style.textContent = SLIDER_STYLES;
  document.head.appendChild(style);
}

// ─── Component ────────────────────────────────────────────────────────────────

interface GiftSliderProps {
  payload: GiftSliderPayload;
  sessionId: string;
  onClose: () => void;
  onConfirm: (selectedVariantIds: string[]) => Promise<void>;
}

function GiftSlider({ payload, sessionId, onClose, onConfirm }: GiftSliderProps) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(payload.selectableGifts.filter((g) => g.isSelected).map((g) => g.variantId)),
  );
  const [loading, setLoading] = useState(false);

  const maxSelectable = payload.maxSelectableCount - payload.alreadySelectedCount;
  const canSelectMore = selected.size < maxSelectable;

  function toggleGift(gift: SelectableGift) {
    if (!gift.isAvailable) return;
    const next = new Set(selected);
    if (next.has(gift.variantId)) {
      next.delete(gift.variantId);
    } else if (canSelectMore) {
      next.add(gift.variantId);
    }
    setSelected(next);
  }

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm([...selected]);
      publishAnalytics("promo_engine:gift_selected", {
        offer_id: payload.offerId,
        variant_ids: [...selected],
        session_id: sessionId,
      });
      onClose();
    } finally {
      setLoading(false);
    }
  }

  // Close on backdrop click
  function handleOverlayClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("pe-slider-overlay")) {
      onClose();
    }
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div class="pe-slider-overlay" onClick={handleOverlayClick} role="dialog" aria-modal="true">
      <div class="pe-slider-modal">
        <div class="pe-slider-header">
          <div>
            <h2 class="pe-slider-title">{payload.title}</h2>
            {payload.subtitle && <p class="pe-slider-subtitle">{payload.subtitle}</p>}
          </div>
          <button class="pe-slider-close" onClick={onClose} aria-label="Close gift selection">
            ✕
          </button>
        </div>

        <div class="pe-slider-body">
          <div class="pe-gift-grid">
            {payload.selectableGifts.map((gift) => {
              const isSelected = selected.has(gift.variantId);
              const unavailable = !gift.isAvailable;
              return (
                <div
                  key={gift.variantId}
                  class={`pe-gift-card${isSelected ? " pe-selected" : ""}${unavailable ? " pe-unavailable" : ""}`}
                  onClick={() => toggleGift(gift)}
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-disabled={unavailable}
                  tabIndex={unavailable ? -1 : 0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGift(gift); } }}
                >
                  {isSelected && <span class="pe-gift-check" aria-hidden="true">✓</span>}
                  {gift.imageUrl ? (
                    <img
                      class="pe-gift-img"
                      src={gift.imageUrl}
                      alt={gift.title}
                      loading="lazy"
                      width={160}
                      height={160}
                    />
                  ) : (
                    <div class="pe-gift-img-placeholder" aria-hidden="true" />
                  )}
                  <p class="pe-gift-name">{gift.title}</p>
                  {gift.variantTitle && <p class="pe-gift-variant">{gift.variantTitle}</p>}
                  <p class="pe-gift-price">
                    {gift.discountedPriceCents === 0 ? (
                      <span class="pe-gift-free">Free</span>
                    ) : (
                      <>
                        <s>${(gift.originalPriceCents / 100).toFixed(2)}</s>{" "}
                        <span class="pe-gift-free">${(gift.discountedPriceCents / 100).toFixed(2)}</span>
                      </>
                    )}
                  </p>
                  {unavailable && (
                    <p style={{ fontSize: "11px", color: "#ef4444", marginTop: "4px" }}>
                      Out of stock
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div class="pe-slider-footer">
          <p class="pe-selected-count">
            {selected.size} / {maxSelectable} selected
          </p>
          <button
            class="pe-btn-confirm"
            onClick={handleConfirm}
            disabled={selected.size === 0 || loading}
          >
            {loading ? (
              <span class="pe-spinner" style={{ display: "inline-block" }} />
            ) : (
              `Add ${selected.size > 0 ? selected.size : ""} Gift${selected.size !== 1 ? "s" : ""} to Cart`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mount / unmount ──────────────────────────────────────────────────────────

let sliderContainer: HTMLDivElement | null = null;

function mountSlider(payload: GiftSliderPayload, sessionId: string) {
  injectStyles();

  if (!sliderContainer) {
    sliderContainer = document.createElement("div");
    sliderContainer.id = "pe-gift-slider-root";
    document.body.appendChild(sliderContainer);
  }

  const unmount = () => {
    if (sliderContainer) {
      render(h(Fragment, null), sliderContainer);
      emit(PromoEvents.GiftSliderClosed);
      publishAnalytics("promo_engine:gift_slider_opened", {
        offer_id: payload.offerId,
        session_id: sessionId,
      });
    }
  };

  const handleConfirm = async (selectedVariantIds: string[]) => {
    // Remove previously selected gifts for this offer that are no longer selected
    const cart = await AjaxCartAdapter.getCart();
    const existingGifts = cart.items.filter(
      (item) => item.properties["_promo_engine_offer_id"] === payload.offerId,
    );

    for (const gift of existingGifts) {
      if (!selectedVariantIds.includes(String(gift.variant_id))) {
        await AjaxCartAdapter.removeLine({ key: gift.key });
      }
    }

    // Add newly selected gifts
    for (const variantId of selectedVariantIds) {
      const alreadyInCart = existingGifts.some((g) => String(g.variant_id) === variantId);
      if (!alreadyInCart) {
        const giftInfo = payload.selectableGifts.find((g) => g.variantId === variantId);
        await AjaxCartAdapter.addLines([{
          variantId,
          quantity: 1,
          properties: {
            _promo_engine_line_type: "gift",
            _promo_engine_offer_id: payload.offerId,
            _promo_engine_reward_id: giftInfo?.variantId ?? variantId,
            _promo_engine_offer_version: "1",
            _promo_engine_hash: "", // server will verify
          },
        }]);
      }
    }

    // Notify runtime to re-evaluate
    emit(PromoEvents.CartChanged);
  };

  render(
    h(GiftSlider, {
      payload,
      sessionId,
      onClose: unmount,
      onConfirm: handleConfirm,
    }),
    sliderContainer,
  );

  publishAnalytics("promo_engine:gift_slider_opened", {
    offer_id: payload.offerId,
    session_id: sessionId,
  });
}

/** Initialize the gift slider — listens for slider requests from runtime. */
export function initGiftSlider(sessionId: string) {
  on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
    if (result.giftSlider && Array.isArray(result.giftSlider.selectableGifts)) {
      mountSlider(result.giftSlider, sessionId);
    }
  });

  on<GiftSliderPayload>(PromoEvents.GiftSliderRequested, (payload) => {
    mountSlider(payload, sessionId);
  });
}

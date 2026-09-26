// NOTE: This file uses Preact JSX (class= not className=, style strings not objects).
// @jsxImportSource preact is required — do not replace with React imports.
/** @jsxImportSource preact */
import { useState, useEffect, useRef } from "preact/hooks";
import { h, Fragment } from "preact";
import { render } from "preact";
import { on, emit, PromoEvents, publishAnalytics } from "../event-bus.js";
import { AjaxCartAdapter } from "../cart-adapter.js";
import {
  giftRewardKey,
  loadDeclinedGiftRewards,
  saveDeclinedGiftRewards,
} from "../declined-gifts.js";
import type { GiftSliderPayload, SelectableGift, EvaluationResult } from "../types.js";

const AUTO_OPENED_STORAGE_KEY = "promo_engine_gift_slider_auto_opened";
const MAX_TRACKED_AUTO_OPENED = 50;

function loadAutoOpenedCartStates(): Set<string> {
  try {
    const raw = sessionStorage.getItem(AUTO_OPENED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveAutoOpenedCartStates(states: Set<string>): void {
  try {
    sessionStorage.setItem(
      AUTO_OPENED_STORAGE_KEY,
      JSON.stringify([...states].slice(-MAX_TRACKED_AUTO_OPENED)),
    );
  } catch {
    // Storage unavailable — worst case the slider can auto-open again this page view.
  }
}

// ─── Styles — injected once ───────────────────────────────────────────────────

const SLIDER_STYLES = `
.pe-slider-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.4); border: 0; padding: 0;
  margin: 0; width: 100%; max-width: none; height: 100%; max-height: none;
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
  color: #6b7280; padding: 0; line-height: 1; min-width: 48px; min-height: 48px;
}
.pe-slider-body { overflow-y: auto; padding: 16px; flex: 1; }
.pe-gift-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@media (min-width: 480px) {
  .pe-gift-grid { grid-template-columns: repeat(3, 1fr); }
}
.pe-gift-card {
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 12px 10px;
  cursor: pointer; transition: border-color .15s, box-shadow .15s; position: relative;
  background: #fff; color: inherit; text-align: left; width: 100%; font: inherit;
}
.pe-gift-card:hover:not(.pe-unavailable) { border-color: #111; }
.pe-gift-card:focus-visible, .pe-slider-close:focus-visible, .pe-btn-confirm:focus-visible {
  outline: 3px solid #2563eb; outline-offset: 2px;
}
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
.pe-gift-unavailable { color: #b42318; font-size: 11px; margin: 4px 0 0; }
.pe-slider-footer {
  padding: 14px 20px; border-top: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.pe-selected-count { font-size: 13px; color: #6b7280; }
.pe-btn-confirm {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; min-height: 48px; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background .15s; flex: 1;
}
.pe-btn-confirm:hover { background: #333; }
.pe-btn-confirm:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-slider-error { color: #b42318; font-size: 13px; margin: 0 20px 12px; }
.pe-loading { display: flex; align-items: center; justify-content: center; padding: 40px; }
.pe-spinner {
  width: 28px; height: 28px; border: 3px solid #e5e7eb;
  border-top-color: #111; border-radius: 50%; animation: pe-spin .7s linear infinite;
}
@keyframes pe-spin { to { transform: rotate(360deg); } }
.pe-sr-only {
  position: absolute; clip-path: inset(50%); overflow: hidden;
  width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .pe-gift-card, .pe-btn-confirm { transition: none; }
  .pe-spinner { animation: none; opacity: .65; }
}
`;

function injectStyles() {
  if (document.getElementById("pe-slider-styles")) return;
  const style = document.createElement("style");
  style.id = "pe-slider-styles";
  style.textContent = SLIDER_STYLES;
  document.head.appendChild(style);
}

// ─── Component ────────────────────────────────────────────────────────────────

function formatMoney(cents: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(navigator.language || "en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currencyCode}`;
  }
}

interface GiftSliderProps {
  payload: GiftSliderPayload;
  sessionId: string;
  onClose: () => void;
  onConfirm: (selectedGifts: SelectableGift[]) => Promise<void>;
  /** Called when the customer dismisses the slider (X, backdrop, Escape)
   * without ever selecting a gift — as opposed to onClose, which also fires
   * after a successful confirm. */
  onDismissWithoutSelection: () => void;
}

function giftKey(gift: Pick<SelectableGift, "rewardId" | "variantId">): string {
  return `${gift.rewardId}:${gift.variantId}`;
}

function GiftSlider({
  payload,
  sessionId,
  onClose,
  onConfirm,
  onDismissWithoutSelection,
}: GiftSliderProps) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(payload.selectableGifts.filter((gift) => gift.isSelected).map(giftKey)),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const initiallySelectedCount = useRef(selected.size);

  const maxSelectable = payload.maxSelectableCount;

  function toggleGift(gift: SelectableGift) {
    const key = giftKey(gift);
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      if (!gift.isAvailable) return;
      const rewardSelectedCount = payload.selectableGifts.filter(
        (candidate) => candidate.rewardId === gift.rewardId && next.has(giftKey(candidate)),
      ).length;
      if (next.size >= maxSelectable || rewardSelectedCount >= gift.rewardMaxQuantity) return;
      next.add(key);
    }
    setError(null);
    setSelected(next);
  }

  async function handleConfirm() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const selectedGifts = payload.selectableGifts.filter((gift) => selected.has(giftKey(gift)));
      await onConfirm(selectedGifts);
      publishAnalytics("promo_engine:gift_selected", {
        offer_id: payload.offerId,
        variant_ids: selectedGifts.map((gift) => gift.variantId),
        session_id: sessionId,
      });
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "We couldn't update your gifts. Please try again.",
      );
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  }

  // Dismiss without confirming (X button, backdrop click, Escape) — as
  // opposed to onClose, which is also called after a successful confirm.
  function handleDismiss() {
    if (loading) return;
    if (selected.size === 0) onDismissWithoutSelection();
    onClose();
  }

  // Close on backdrop click
  function handleOverlayClick(e: MouseEvent) {
    if (!loading && e.target === e.currentTarget) {
      handleDismiss();
    }
  }

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    closeButtonRef.current?.focus();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      class="pe-slider-overlay"
      aria-labelledby="pe-slider-title"
      aria-describedby={payload.subtitle ? "pe-slider-subtitle" : undefined}
      onClick={handleOverlayClick}
      onCancel={(event) => {
        event.preventDefault();
        handleDismiss();
      }}
      aria-busy={loading}
    >
      <div class="pe-slider-modal">
        <div class="pe-slider-header">
          <div>
            <h2 class="pe-slider-title" id="pe-slider-title">
              {payload.title}
            </h2>
            {payload.subtitle && (
              <p class="pe-slider-subtitle" id="pe-slider-subtitle">
                {payload.subtitle}
              </p>
            )}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            class="pe-slider-close"
            onClick={handleDismiss}
            disabled={loading}
            aria-label="Close gift selection"
          >
            ✕
          </button>
        </div>

        <div class="pe-slider-body">
          <div class="pe-gift-grid">
            {payload.selectableGifts.map((gift) => {
              const key = giftKey(gift);
              const isSelected = selected.has(key);
              const unavailable = !gift.isAvailable;
              return (
                <button
                  key={key}
                  type="button"
                  class={`pe-gift-card${isSelected ? " pe-selected" : ""}${unavailable ? " pe-unavailable" : ""}`}
                  onClick={() => toggleGift(gift)}
                  aria-pressed={isSelected}
                  disabled={unavailable && !isSelected}
                >
                  {isSelected && (
                    <span class="pe-gift-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
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
                        <s>{formatMoney(gift.originalPriceCents, payload.currencyCode)}</s>{" "}
                        <span class="pe-gift-free">
                          {formatMoney(gift.discountedPriceCents, payload.currencyCode)}
                        </span>
                      </>
                    )}
                  </p>
                  {gift.replacesTitle && (
                    <p class="pe-gift-variant">Replaces {gift.replacesTitle} (out of stock)</p>
                  )}
                  {unavailable && <p class="pe-gift-unavailable">Out of stock</p>}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <p class="pe-slider-error" role="alert" aria-live="assertive">
            {error}
          </p>
        )}

        <div class="pe-slider-footer">
          <p class="pe-selected-count" aria-live="polite">
            {selected.size} / {maxSelectable} selected
          </p>
          <button
            class="pe-btn-confirm"
            type="button"
            onClick={handleConfirm}
            disabled={(selected.size === 0 && initiallySelectedCount.current === 0) || loading}
            aria-label={loading ? "Updating gifts" : undefined}
          >
            {loading ? (
              <>
                <span class="pe-spinner" style={{ display: "inline-block" }} aria-hidden="true" />
                <span class="pe-sr-only">Updating gifts</span>
              </>
            ) : selected.size === 0 && initiallySelectedCount.current === 0 ? (
              "Select a gift"
            ) : selected.size === 0 ? (
              "Remove Gifts from Cart"
            ) : (
              `Add ${selected.size > 0 ? selected.size : ""} Gift${selected.size !== 1 ? "s" : ""} to Cart`
            )}
          </button>
        </div>
      </div>
    </dialog>
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
      publishAnalytics("promo_engine:gift_slider_closed", {
        offer_id: payload.offerId,
        session_id: sessionId,
      });
    }
  };

  const handleDismissWithoutSelection = () => {
    const declined = loadDeclinedGiftRewards();
    for (const gift of payload.selectableGifts) declined.add(giftRewardKey(payload.offerId, gift.rewardId));
    saveDeclinedGiftRewards(declined);
  };

  const handleConfirm = async (selectedGifts: SelectableGift[]) => {
    const freshPayload = await window.PromoEngine?.validateGiftOffer(payload.offerId);
    if (!freshPayload) {
      throw new Error("This gift offer is no longer available. Your cart was not changed.");
    }
    const freshGiftByKey = new Map(
      freshPayload.selectableGifts.map((gift) => [giftKey(gift), gift]),
    );
    const validatedSelected = selectedGifts.map((gift) => freshGiftByKey.get(giftKey(gift)));
    if (validatedSelected.some((gift) => !gift?.isAvailable)) {
      throw new Error("One of the selected gifts is no longer available. Please choose again.");
    }
    const selectedByReward = new Map<string, number>();
    for (const gift of validatedSelected) {
      if (!gift) continue;
      const nextCount = (selectedByReward.get(gift.rewardId) ?? 0) + 1;
      if (nextCount > gift.rewardMaxQuantity) {
        throw new Error("Too many gifts were selected for this reward.");
      }
      selectedByReward.set(gift.rewardId, nextCount);
    }
    if (validatedSelected.length > freshPayload.maxSelectableCount) {
      throw new Error("Too many gifts were selected for this offer.");
    }

    // Remove previously selected gifts for this offer that are no longer selected
    const cart = await AjaxCartAdapter.getCart();
    const existingGifts = cart.items.filter(
      (item) => item.properties?.["_promo_engine_offer_id"] === payload.offerId,
    );

    const selectedKeys = new Set(
      validatedSelected.flatMap((gift) => (gift ? [giftKey(gift)] : [])),
    );
    const giftsToRemove = existingGifts.filter((gift) => {
      const properties = gift.properties ?? {};
      const key = `${properties["_promo_engine_reward_id"] ?? ""}:gid://shopify/ProductVariant/${gift.variant_id}`;
      const isCurrentVersion =
        properties["_promo_engine_offer_version"] ===
        String(freshPayload.selectableGifts[0]?.offerVersion ?? "");
      return !selectedKeys.has(key) || !isCurrentVersion;
    });

    // Add the new selection first so a failed add never destroys the buyer's
    // current gift, then remove stale lines in one cart update request.
    const giftsToAdd = validatedSelected.flatMap((giftInfo) => {
      if (!giftInfo) return [];
      const legacyVariantId = giftInfo.variantId.split("/").pop() ?? giftInfo.variantId;
      const alreadyInCart = existingGifts.some(
        (gift) =>
          String(gift.variant_id) === legacyVariantId &&
          gift.properties?.["_promo_engine_reward_id"] === giftInfo.rewardId &&
          gift.properties?.["_promo_engine_offer_version"] === String(giftInfo.offerVersion),
      );
      return alreadyInCart ? [] : [{
        variantId: giftInfo.variantId,
        quantity: 1,
        properties: {
          _promo_engine_line_type: "gift",
          _promo_engine_offer_id: payload.offerId,
          _promo_engine_reward_id: giftInfo.rewardId,
          _promo_engine_offer_version: String(giftInfo.offerVersion),
        },
      }];
    });
    if (giftsToAdd.length > 0) await AjaxCartAdapter.addLines(giftsToAdd);
    if (giftsToRemove.length > 0) {
      await AjaxCartAdapter.removeLines(giftsToRemove.map((gift) => ({ key: gift.key })));
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
      onDismissWithoutSelection: handleDismissWithoutSelection,
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
  const payloadByOfferId = new Map<string, GiftSliderPayload>();
  // Persisted (not just in-memory) — Shopify storefront navigation is a full
  // page reload, so an in-memory Set would let the slider auto-open again on
  // every single page view for the same unchanged cart state.
  const autoOpenedCartStates = loadAutoOpenedCartStates();
  let latestPayload: GiftSliderPayload | null = null;

  on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
    payloadByOfferId.clear();
    latestPayload = null;
    if (result.giftSlider && Array.isArray(result.giftSlider.selectableGifts)) {
      latestPayload = result.giftSlider;
      payloadByOfferId.set(result.giftSlider.offerId, result.giftSlider);
    }
    const autoOpenKey = result.giftSlider
      ? `${result.giftSlider.offerId}:${result.cartHash}:${result.giftSlider.selectableGifts.map((gift) => gift.offerVersion).join(",")}`
      : null;
    const declinedGiftRewards = loadDeclinedGiftRewards();
    const hasNonDeclinedGift = (slider: GiftSliderPayload) =>
      slider.selectableGifts.some(
        (gift) => gift.isAvailable && !declinedGiftRewards.has(giftRewardKey(slider.offerId, gift.rewardId)),
      );
    if (
      result.giftSlider &&
      Array.isArray(result.giftSlider.selectableGifts) &&
      result.giftSlider.alreadySelectedCount === 0 &&
      hasNonDeclinedGift(result.giftSlider) &&
      autoOpenKey &&
      !autoOpenedCartStates.has(autoOpenKey)
    ) {
      autoOpenedCartStates.add(autoOpenKey);
      saveAutoOpenedCartStates(autoOpenedCartStates);
      mountSlider(result.giftSlider, sessionId);
    }
  });

  on<GiftSliderPayload | { offerId?: string }>(PromoEvents.GiftSliderRequested, (request) => {
    void (async () => {
      const directPayload = "selectableGifts" in request ? request : null;
      const cachedPayload =
        directPayload ??
        (request.offerId ? payloadByOfferId.get(request.offerId) : latestPayload) ??
        latestPayload;
      if (!cachedPayload) return;
      if (directPayload || !window.PromoEngine?.validateGiftOffer) {
        mountSlider(cachedPayload, sessionId);
        return;
      }
      const freshPayload = await window.PromoEngine.validateGiftOffer(cachedPayload.offerId);
      if (!freshPayload) return;
      latestPayload = freshPayload;
      payloadByOfferId.set(freshPayload.offerId, freshPayload);
      mountSlider(freshPayload, sessionId);
    })();
  });

  document.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-promo-gift-slider-trigger]")
        : null;
    if (!target) return;
    emit(PromoEvents.GiftSliderRequested, {
      offerId: target.dataset["offerId"] || undefined,
    });
  });
}

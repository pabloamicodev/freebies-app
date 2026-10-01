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

/** One auto-open per qualified stretch of an offer. Keys are `offerId:versions`
 * (no cart hash) and are dropped as soon as the offer stops producing a slider,
 * so crossing the threshold again after dipping below re-opens the picker. */
export function decideAutoOpen(
  opened: ReadonlySet<string>,
  slider: GiftSliderPayload | null,
  declined: ReadonlySet<string>,
): { open: boolean; keys: Set<string> } {
  if (!slider || !Array.isArray(slider.selectableGifts)) return { open: false, keys: new Set() };
  const key = `${slider.offerId}:${slider.selectableGifts.map((gift) => gift.offerVersion).join(",")}`;
  const keys = new Set([...opened].filter((k) => k.startsWith(`${slider.offerId}:`)));
  if (keys.has(key)) return { open: false, keys };
  if (slider.alreadySelectedCount > 0) {
    keys.add(key);
    return { open: false, keys };
  }
  const canPick = slider.selectableGifts.some(
    (gift) => gift.isAvailable && !declined.has(giftRewardKey(slider.offerId, gift.rewardId)),
  );
  if (!canPick) return { open: false, keys };
  keys.add(key);
  return { open: true, keys };
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
.pe-gift-card.pe-unavailable .pe-gift-img,
.pe-gift-card.pe-unavailable .pe-gift-img-placeholder { filter: grayscale(1); }
.pe-gift-check {
  position: absolute; top: 8px; right: 8px; width: 20px; height: 20px;
  background: #111; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; color: #fff; font-size: 12px;
}
.pe-gift-badge {
  position: absolute; top: 8px; left: 8px; z-index: 1;
  display: inline-flex; align-items: center; padding: 2px 8px;
  border-radius: 999px; font-size: 10px; font-weight: 700;
  letter-spacing: .3px; text-transform: uppercase; line-height: 1.4;
  background: #fef2f2; color: #b42318; border: 1px solid #fecaca;
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

// The Ajax Cart API's error responses (cart-adapter.ts's fetchJson) are raw
// `Cart API error 422: {"status":422,"message":"...already sold out.",...}`
// text meant for logs, never customers. This is the last line of defense
// against a race between the popup loading and the customer confirming —
// the client already refuses to select or submit a known-unavailable
// variant, but stock can still change in that window.
const RAW_CART_API_ERROR = /^Cart API error \d+: (.*)$/s;
const SOLD_OUT_TEXT = /sold out|out of stock|not enough (inventory|stock)|no longer available/i;
const SOLD_OUT_MESSAGE = "That size just sold out — pick another.";

/** An error whose message was written for customers and may be shown as-is. */
export class GiftSliderError extends Error {}

/** One or more gift variants turned out to be sold out; the slider dims and
 * deselects `variantIds` (may be empty when the culprit can't be identified). */
export class GiftSoldOutError extends GiftSliderError {
  constructor(public readonly variantIds: string[], message = SOLD_OUT_MESSAGE) {
    super(message);
  }
}

/** Shopify's own error text from a failed cart mutation (Ajax Cart API JSON
 * body or Storefront API userErrors), or null when there isn't any. */
function cartErrorText(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = RAW_CART_API_ERROR.exec(error.message);
  if (!match) return error.message;
  try {
    const body: unknown = JSON.parse(match[1] ?? "");
    if (body && typeof body === "object") {
      const { message, description } = body as { message?: unknown; description?: unknown };
      return [message, description].filter((part) => typeof part === "string").join(" ") || null;
    }
  } catch {
    // not JSON
  }
  return null;
}

export function isSoldOutCartError(error: unknown): boolean {
  if (error instanceof GiftSoldOutError) return true;
  const text = cartErrorText(error);
  return text !== null && SOLD_OUT_TEXT.test(text);
}

/** Every customer-visible gift error goes through here: only our own
 * GiftSliderError messages are shown verbatim, a stock failure becomes a short
 * sold-out message, and anything else (raw Cart API bodies, network errors,
 * Storefront API userErrors) becomes `fallback`. */
export function friendlyGiftError(error: unknown, fallback: string): string {
  if (error instanceof GiftSliderError) return error.message;
  if (isSoldOutCartError(error)) return SOLD_OUT_MESSAGE;
  return fallback;
}

/** Which of the gifts just sent to the Cart API the sold-out error names —
 * Shopify's message quotes "<product> - <variant>". */
export function soldOutVariantIdsFromError(
  error: unknown,
  attempted: Array<Pick<SelectableGift, "variantId" | "title" | "variantTitle">>,
): string[] {
  if (attempted.length === 1) return [attempted[0]!.variantId];
  const text = cartErrorText(error)?.toLowerCase() ?? "";
  const fullName = (gift: (typeof attempted)[number]) =>
    (gift.variantTitle ? `${gift.title} - ${gift.variantTitle}` : gift.title).toLowerCase();
  const byFullName = attempted.filter((gift) => text.includes(`'${fullName(gift)}'`));
  return byFullName.map((gift) => gift.variantId);
}

type LiveStockGift = Pick<SelectableGift, "variantId" | "productHandle">;

/** Live stock from the storefront's own product JSON — the server payload's
 * isAvailable comes from a webhook-fed cache that can lag real sales. Returns
 * the variant GIDs Shopify currently reports as unavailable; anything it
 * can't confirm (no handle, product unpublished, network error) is left out. */
export async function fetchSoldOutVariantIds(
  gifts: LiveStockGift[],
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const soldOut = new Set<string>();
  const byHandle = new Map<string, LiveStockGift[]>();
  for (const gift of gifts) {
    if (!gift.productHandle) continue;
    byHandle.set(gift.productHandle, [...(byHandle.get(gift.productHandle) ?? []), gift]);
  }
  const root = (typeof window !== "undefined" && window.Shopify?.routes?.root) || "/";
  await Promise.all(
    [...byHandle].map(async ([handle, handleGifts]) => {
      try {
        const response = await fetchImpl(`${root}products/${encodeURIComponent(handle)}.js`, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const product = (await response.json()) as { variants?: Array<{ id: number; available: boolean }> };
        const availableById = new Map((product.variants ?? []).map((v) => [String(v.id), v.available]));
        for (const gift of handleGifts) {
          if (availableById.get(gift.variantId.split("/").pop() ?? "") === false) soldOut.add(gift.variantId);
        }
      } catch {
        // Unknown stock — keep the server's answer.
      }
    }),
  );
  return soldOut;
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
  // Variants found sold out after the payload was built (live stock check or a
  // Cart API rejection) — overrides the payload's isAvailable.
  const [soldOut, setSoldOut] = useState<Set<string>>(new Set());
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const initiallySelectedCount = useRef(selected.size);

  const maxSelectable = payload.maxSelectableCount;
  const isAvailable = (gift: SelectableGift) => gift.isAvailable && !soldOut.has(gift.variantId);

  function markSoldOut(variantIds: Iterable<string>) {
    const ids = new Set(variantIds);
    if (ids.size === 0) return;
    setSoldOut((prev) => new Set([...prev, ...ids]));
    // Gifts already in the cart stay selected (removing them is the customer's
    // call, and the confirm button explains why it's blocked); new picks go.
    setSelected((prev) => {
      const next = new Set(prev);
      for (const gift of payload.selectableGifts) {
        if (ids.has(gift.variantId) && !gift.isSelected) next.delete(giftKey(gift));
      }
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    void fetchSoldOutVariantIds(payload.selectableGifts.filter((gift) => gift.isAvailable)).then(
      (ids) => {
        if (!cancelled) markSoldOut(ids);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [payload]);

  function toggleGift(gift: SelectableGift) {
    const key = giftKey(gift);
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      if (!isAvailable(gift)) return;
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
    const selectedGifts = payload.selectableGifts.filter((gift) => selected.has(giftKey(gift)));
    // The customer can only reach an unavailable selection by having it
    // already in their cart when the popup opened (toggleGift refuses to
    // select an unavailable variant) — never send that to the Cart API.
    if (selectedGifts.some((gift) => !isAvailable(gift))) {
      setError("One of your selected items just sold out. Please choose another.");
      return;
    }
    submittingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      await onConfirm(selectedGifts);
      publishAnalytics("promo_engine:gift_selected", {
        offer_id: payload.offerId,
        variant_ids: selectedGifts.map((gift) => gift.variantId),
        session_id: sessionId,
      });
      onClose();
    } catch (caught) {
      if (caught instanceof GiftSoldOutError) markSoldOut(caught.variantIds);
      setError(friendlyGiftError(caught, "We couldn't update your gifts. Please try again."));
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  }

  const hasUnavailableSelection = payload.selectableGifts.some(
    (gift) => selected.has(giftKey(gift)) && !isAvailable(gift),
  );

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
              const unavailable = !isAvailable(gift);
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
                  {unavailable && (
                    <span class="pe-gift-badge" aria-hidden="true">
                      {payload.labels?.outOfStock ?? "Sold out"}
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
                      <span class="pe-gift-free">{payload.labels?.free ?? "Free"}</span>
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
                    <p class="pe-gift-variant">
                      {(payload.labels?.replaces ?? "Replaces {{title}} (out of stock)").replace(
                        "{{title}}",
                        gift.replacesTitle,
                      )}
                    </p>
                  )}
                  {unavailable && (
                    <p class="pe-gift-unavailable">{payload.labels?.outOfStock ?? "Out of stock"}</p>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {(error || hasUnavailableSelection) && (
          <p class="pe-slider-error" role="alert" aria-live="assertive">
            {error ?? "One of your selected items is sold out — remove it to continue."}
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
            disabled={
              (selected.size === 0 && initiallySelectedCount.current === 0) ||
              loading ||
              hasUnavailableSelection
            }
            aria-label={loading ? "Updating gifts" : undefined}
          >
            {loading ? (
              <>
                <span class="pe-spinner" style={{ display: "inline-block" }} aria-hidden="true" />
                <span class="pe-sr-only">Updating gifts</span>
              </>
            ) : selected.size === 0 && initiallySelectedCount.current === 0 ? (
              payload.labels?.selectPrompt ?? "Select a gift"
            ) : selected.size === 0 ? (
              payload.labels?.remove ?? "Remove Gifts from Cart"
            ) : (
              payload.labels?.confirm ??
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
      throw new GiftSliderError("This gift offer is no longer available. Your cart was not changed.");
    }
    const freshGiftByKey = new Map(
      freshPayload.selectableGifts.map((gift) => [giftKey(gift), gift]),
    );
    const validatedSelected = selectedGifts.map((gift) => freshGiftByKey.get(giftKey(gift)));
    const goneOrSoldOut = selectedGifts.filter((_, index) => !validatedSelected[index]?.isAvailable);
    if (goneOrSoldOut.length > 0) {
      throw new GiftSoldOutError(
        goneOrSoldOut.map((gift) => gift.variantId),
        "One of the selected gifts is no longer available. Please choose again.",
      );
    }
    const selectedByReward = new Map<string, number>();
    for (const gift of validatedSelected) {
      if (!gift) continue;
      const nextCount = (selectedByReward.get(gift.rewardId) ?? 0) + 1;
      if (nextCount > gift.rewardMaxQuantity) {
        throw new GiftSliderError("Too many gifts were selected for this reward.");
      }
      selectedByReward.set(gift.rewardId, nextCount);
    }
    if (validatedSelected.length > freshPayload.maxSelectableCount) {
      throw new GiftSliderError("Too many gifts were selected for this offer.");
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
    const newGifts = validatedSelected.flatMap((giftInfo) => {
      if (!giftInfo) return [];
      const legacyVariantId = giftInfo.variantId.split("/").pop() ?? giftInfo.variantId;
      const alreadyInCart = existingGifts.some(
        (gift) =>
          String(gift.variant_id) === legacyVariantId &&
          gift.properties?.["_promo_engine_reward_id"] === giftInfo.rewardId &&
          gift.properties?.["_promo_engine_offer_version"] === String(giftInfo.offerVersion),
      );
      return alreadyInCart ? [] : [giftInfo];
    });
    const giftsToAdd = newGifts.map((giftInfo) => ({
      variantId: giftInfo.variantId,
      quantity: 1,
      properties: {
        _promo_engine_line_type: "gift",
        _promo_engine_offer_id: payload.offerId,
        _promo_engine_reward_id: giftInfo.rewardId,
        _promo_engine_offer_version: String(giftInfo.offerVersion),
      },
    }));
    if (giftsToAdd.length > 0) {
      try {
        await AjaxCartAdapter.addLines(giftsToAdd);
      } catch (caught) {
        if (!isSoldOutCartError(caught)) throw caught;
        let ids = soldOutVariantIdsFromError(caught, newGifts);
        if (ids.length === 0) ids = [...(await fetchSoldOutVariantIds(newGifts))];
        throw new GiftSoldOutError(ids);
      }
    }
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
  // every single page view while the offer stays qualified.
  let autoOpenedCartStates =loadAutoOpenedCartStates();
  let latestPayload: GiftSliderPayload | null = null;

  on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
    payloadByOfferId.clear();
    latestPayload = null;
    if (result.giftSlider && Array.isArray(result.giftSlider.selectableGifts)) {
      latestPayload = result.giftSlider;
      payloadByOfferId.set(result.giftSlider.offerId, result.giftSlider);
    }
    const { open, keys } = decideAutoOpen(autoOpenedCartStates, result.giftSlider, loadDeclinedGiftRewards());
    if (keys.size !== autoOpenedCartStates.size || [...keys].some((k) => !autoOpenedCartStates.has(k))) {
      autoOpenedCartStates = keys;
      saveAutoOpenedCartStates(keys);
    }
    if (open && result.giftSlider) mountSlider(result.giftSlider, sessionId);
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

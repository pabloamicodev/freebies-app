// Product-first picker body of the gift modal, requested lazily by gift-slider.tsx only when the modal offers more than one product.
// Built with preact aliased to preact-shim.ts (see build.mjs); the selection state lives in the slider, this file is the view plus pure pick rules.
/** @jsxImportSource preact */
import { useState, useEffect } from "preact/hooks";
import { formatMoney } from "../format.js";
import type { GiftSliderPayload, SelectableGift } from "../types.js";

export interface PickerGroup {
  key: string;
  rewardId: string;
  rewardMax: number;
  gifts: SelectableGift[];
}

export interface PickerState {
  selected: Set<string>;
  /** Picked products that still need a variant. They count toward the limit. */
  pending: Set<string>;
}

export interface ProductPickerProps {
  gifts: readonly SelectableGift[];
  state: PickerState;
  soldOut: ReadonlySet<string>;
  maxSelectable: number;
  labels: GiftSliderPayload["labels"];
  currencyCode: string;
  disabled: boolean;
  onChange: (state: PickerState) => void;
}

const giftKey = (gift: Pick<SelectableGift, "rewardId" | "variantId">) => `${gift.rewardId}:${gift.variantId}`;

/** One group per product within a reward; a gift without a product id stands alone. */
export function groupGifts(gifts: readonly SelectableGift[]): PickerGroup[] {
  const groups = new Map<string, PickerGroup>();
  for (const gift of gifts) {
    const key = `${gift.rewardId}:${gift.productId || gift.variantId}`;
    const group = groups.get(key) ?? { key, rewardId: gift.rewardId, rewardMax: gift.rewardMaxQuantity, gifts: [] };
    group.gifts.push(gift);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const isPicked = (state: PickerState, group: PickerGroup) =>
  state.pending.has(group.key) || group.gifts.some((gift) => state.selected.has(giftKey(gift)));

function dropGroup(state: PickerState, group: PickerGroup): PickerState {
  const selected = new Set(state.selected);
  const pending = new Set(state.pending);
  for (const gift of group.gifts) selected.delete(giftKey(gift));
  pending.delete(group.key);
  return { selected, pending };
}

/** Makes room for `group` (a single choice replaces the others) and enforces the limits, which count products. Null when full. */
function makeRoom(state: PickerState, group: PickerGroup, groups: readonly PickerGroup[], max: number): PickerState | null {
  let next = dropGroup(state, group);
  if (max === 1) next = { selected: new Set(), pending: new Set() };
  else if (group.rewardMax === 1) {
    for (const other of groups) if (other !== group && other.rewardId === group.rewardId) next = dropGroup(next, other);
  }
  const picked = groups.filter((other) => isPicked(next, other));
  if (picked.length >= max || picked.filter((other) => other.rewardId === group.rewardId).length >= group.rewardMax) return null;
  return next;
}

/** Card click on a product with a single variant: toggles it. */
export function toggleProduct(state: PickerState, group: PickerGroup, groups: readonly PickerGroup[], max: number, soldOut: ReadonlySet<string> = new Set()): PickerState | null {
  if (isPicked(state, group)) return dropGroup(state, group);
  const gift = group.gifts[0]!;
  if (!gift.isAvailable || soldOut.has(gift.variantId)) return null;
  const next = makeRoom(state, group, groups, max);
  next?.selected.add(giftKey(gift));
  return next;
}

/** Card click on a product with variants: reserves a slot for it until a variant is chosen. */
export function reserveProduct(state: PickerState, group: PickerGroup, groups: readonly PickerGroup[], max: number): PickerState | null {
  if (isPicked(state, group)) return state;
  const next = makeRoom(state, group, groups, max);
  next?.pending.add(group.key);
  return next;
}

/** Variant chip click: chooses it (replacing the product's other variant) or, when already chosen, unpicks the product. */
export function chooseVariant(state: PickerState, group: PickerGroup, gift: SelectableGift, groups: readonly PickerGroup[], max: number, soldOut: ReadonlySet<string> = new Set()): PickerState | null {
  if (state.selected.has(giftKey(gift))) return dropGroup(state, group);
  if (!gift.isAvailable || soldOut.has(gift.variantId)) return null;
  const next = isPicked(state, group) ? dropGroup(state, group) : makeRoom(state, group, groups, max);
  next?.selected.add(giftKey(gift));
  return next;
}

const STYLES = `
.pe-product { display: flex; flex-direction: column; gap: 8px; }
.pe-product .pe-gift-card { flex: none; }
.pe-variant-row { display: flex; flex-wrap: wrap; gap: 6px; }
.pe-variant-chip {
  min-height: 44px; min-width: 44px; padding: 6px 12px; border: 2px solid #e5e7eb; border-radius: 999px;
  background: #fff; color: inherit; font: inherit; font-size: 13px; cursor: pointer;
}
.pe-variant-chip:hover:not(:disabled) { border-color: #111; }
.pe-variant-chip[aria-pressed="true"] { border-color: #111; background: #111; color: #fff; }
.pe-variant-chip:disabled { opacity: .5; text-decoration: line-through; cursor: not-allowed; }
.pe-variant-chip:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
.pe-variant-prompt { font-size: 11px; color: #6b7280; margin: 2px 0 0; }
`;

function injectStyles() {
  if (document.getElementById("pe-picker-styles")) return;
  const style = document.createElement("style");
  style.id = "pe-picker-styles";
  style.textContent = STYLES;
  document.head.appendChild(style);
}

export function ProductPicker({ gifts, state, soldOut, maxSelectable, labels, currencyCode, disabled, onChange }: ProductPickerProps) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = groupGifts(gifts);
  const usable = (gift: SelectableGift) => gift.isAvailable && !soldOut.has(gift.variantId);
  const outOfStock = labels?.outOfStock ?? "Sold out";
  useEffect(injectStyles, []);
  // A reserved product whose last variant sold out cannot be completed.
  const stale = groups.filter((group) => state.pending.has(group.key) && !group.gifts.some(usable));
  useEffect(() => {
    if (stale.length === 0) return;
    onChange(stale.reduce((next, group) => dropGroup(next, group), state));
  }, [stale.length]);

  const apply = (next: PickerState | null) => next && onChange(next);

  return (
    <div class="pe-gift-grid">
      {groups.map((group) => {
        const first = group.gifts.find((gift) => gift.imageUrl) ?? group.gifts[0]!;
        const hasVariants = group.gifts.length > 1;
        const picked = isPicked(state, group);
        const chosen = group.gifts.find((gift) => state.selected.has(giftKey(gift)));
        const unavailable = !group.gifts.some(usable) && !picked;
        const expanded = hasVariants && open === group.key;
        const prices = group.gifts.map((gift) => gift.discountedPriceCents);
        const price = Math.min(...prices);
        const original = group.gifts.find((gift) => gift.discountedPriceCents === price)!.originalPriceCents;
        const panelId = `pe-variants-${group.key.replace(/[^a-z0-9]/gi, "-")}`;
        return (
          <div class="pe-product" key={group.key}>
            <button
              type="button"
              class={`pe-gift-card${picked ? " pe-selected" : ""}${unavailable ? " pe-unavailable" : ""}`}
              aria-pressed={picked}
              aria-expanded={hasVariants ? expanded : undefined}
              aria-controls={hasVariants ? panelId : undefined}
              disabled={disabled || unavailable}
              onClick={() => {
                if (!hasVariants) return apply(toggleProduct(state, group, groups, maxSelectable, soldOut));
                if (expanded) {
                  setOpen(null);
                  if (state.pending.has(group.key)) onChange(dropGroup(state, group));
                  return;
                }
                const next = reserveProduct(state, group, groups, maxSelectable);
                if (!next) return;
                if (next !== state) onChange(next);
                setOpen(group.key);
              }}
            >
              {picked && !state.pending.has(group.key) && (
                <span class="pe-gift-check" aria-hidden="true">
                  ✓
                </span>
              )}
              {unavailable && (
                <span class="pe-gift-badge" aria-hidden="true">
                  {outOfStock}
                </span>
              )}
              {first.imageUrl ? (
                <img class="pe-gift-img" src={first.imageUrl} alt={first.title} loading="lazy" width={160} height={160} />
              ) : (
                <div class="pe-gift-img-placeholder" aria-hidden="true" />
              )}
              <p class="pe-gift-name">{first.title}</p>
              {chosen?.variantTitle && <p class="pe-gift-variant">{chosen.variantTitle}</p>}
              <p class="pe-gift-price">
                {price === 0 ? (
                  <span class="pe-gift-free">{labels?.free ?? "Free"}</span>
                ) : (
                  <>
                    <s>{formatMoney(original, currencyCode)}</s> <span class="pe-gift-free">{formatMoney(price, currencyCode)}</span>
                  </>
                )}
              </p>
              {unavailable && <p class="pe-gift-unavailable">{outOfStock}</p>}
              {state.pending.has(group.key) && <p class="pe-variant-prompt">Choose a variant</p>}
            </button>
            {expanded && (
              <div class="pe-variant-row" id={panelId} role="group" aria-label={first.title}>
                {group.gifts.map((gift) => (
                  <button
                    key={gift.variantId}
                    type="button"
                    class="pe-variant-chip"
                    aria-pressed={state.selected.has(giftKey(gift))}
                    disabled={disabled || (!usable(gift) && !state.selected.has(giftKey(gift)))}
                    onClick={() => {
                      const next = chooseVariant(state, group, gift, groups, maxSelectable, soldOut);
                      if (!next) return;
                      onChange(next);
                      if (next.selected.has(giftKey(gift))) setOpen(null);
                    }}
                  >
                    {gift.variantTitle ?? gift.title}
                    {!usable(gift) && <span class="pe-sr-only"> ({outOfStock})</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

declare global {
  interface Window {
    __peGiftPicker?: { ProductPicker: typeof ProductPicker };
  }
}

window.__peGiftPicker = { ProductPicker };

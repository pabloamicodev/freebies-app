// The cart prompt, started next to the picker. Two things for a shopper who has not taken a free gift they are eligible for:
//  - a non-modal "free gift unlocked" button in the theme's cart drawer and on the cart page (data-promo-gift-cta);
//  - a reminder when they head to checkout: the picker opens once with "Don't forget your free gift" and checkout continues when it closes.
// Talks to the picker only through events. Accelerated checkout buttons (Shop Pay, Apple Pay, Google Pay) live in iframes and are not intercepted.
import { emit, on, PromoEvents } from "../event-bus.js";
import { t } from "../i18n.js";
import type { EvaluationResult, GiftSliderPayload } from "../types.js";

const PROMPT_STYLES = `
.pe-gift-prompt { padding: 8px 16px; }
.pe-gift-prompt button {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 48px; padding: 10px 14px;
  border: 1px dashed var(--mlf-primary, #111); border-radius: var(--mlf-radius, 8px);
  background: var(--mlf-background, #fff); color: var(--mlf-text, inherit); font: inherit; font-weight: 600; text-align: left; cursor: pointer;
}
.pe-gift-prompt--float { position: fixed; left: 16px; bottom: 16px; z-index: 9000; padding: 0; }
.pe-gift-continue {
  display: block; width: calc(100% - 40px); min-height: 48px; margin: 0 20px 16px; padding: 0; border: 0; background: none;
  color: inherit; font: inherit; text-decoration: underline; cursor: pointer;
}
.pe-gift-prompt button:focus-visible, .pe-gift-continue:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
`;
const FORM = "form[action$='/cart']";
const CHECKOUT = "button[name=checkout],input[name=checkout],a[href*='/checkout'],.cart__checkout-button";
const ACCELERATED = ".shopify-payment-button,shopify-accelerated-checkout,shopify-accelerated-checkout-cart,[data-shopify-buttoncontainer]";
const MODAL = "#pe-gift-slider-root dialog";
const REMINDED_KEY = "promo_engine_gift_reminded";
const CHECKOUT_WAIT_MS = 4_000;

const visible = (el: Element) => typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true });

function reminded(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(REMINDED_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** The offer to prompt for: eligible, nothing chosen yet, and at least one gift still available. */
function promptSlider(result: EvaluationResult | null): GiftSliderPayload | null {
  const sliders = result ? [result.giftSlider, ...(result.additionalGiftSliders || [])] : [];
  return sliders.find((s) => s && Array.isArray(s.selectableGifts) && !s.alreadySelectedCount && !s.selectableGifts.some((g) => g.isSelected) && s.selectableGifts.some((g) => g.isAvailable)) || null;
}

let slider: GiftSliderPayload | null = null;
let picking = false;
let checkout: HTMLElement | null = null;
let bypass = false;
let ui: { row: HTMLElement; button: HTMLButtonElement } | undefined;
let observer: MutationObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function build(): { row: HTMLElement; button: HTMLButtonElement } {
  const style = document.createElement("style");
  style.textContent = PROMPT_STYLES;
  document.head.appendChild(style);
  const row = document.createElement("div");
  row.className = "pe-gift-prompt";
  const button = row.appendChild(document.createElement("button"));
  button.type = "button";
  button.setAttribute("data-promo-gift-slider-trigger", "");
  button.setAttribute("data-promo-gift-cta", "");
  button.innerHTML = "<span aria-hidden=true>\u{1F381}</span>";
  button.append(t("giftPrompt"));
  // Safari does not focus a button on click, and the picker returns focus to whatever was focused when it opened.
  button.onclick = () => button.focus();
  return { row, button };
}

/** Idempotent: re-run after any theme re-render; it changes nothing that is already in place (a no-op write would retrigger the observer). */
function sync(): void {
  timer = undefined;
  try {
    // The button stays under an open picker (which is modal): it is what keeps the focus the picker gives back when it closes.
    if (!slider) {
      if (ui) ui.row.remove();
      if (observer) observer.disconnect();
      return;
    }
    ui = ui || build();
    const { row, button } = ui;
    if (button.dataset["offerId"] !== slider.offerId) button.dataset["offerId"] = slider.offerId;
    const forms = [...document.querySelectorAll(FORM)].filter((f) => !f.closest("#pe-gift-slider-root"));
    const form = forms.find(visible) || forms[0];
    const host = (form && form.parentNode) || document.body;
    const after = form ? form.nextSibling : null;
    const next = after === row ? row.nextSibling : after;
    if (row.classList.contains("pe-gift-prompt--float") !== (host === document.body)) row.classList.toggle("pe-gift-prompt--float");
    if (row.parentNode !== host || row.nextSibling !== next) host.insertBefore(row, next);
    observer = observer || new MutationObserver(() => {
      timer = timer || setTimeout(sync, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "open", "aria-hidden"] });
  } catch {
    // A theme DOM we do not understand: the picker itself still works.
  }
}

/** Lets the shopper's checkout click through again, however the theme wires it (link, submit button, script). */
function proceed(): void {
  const held = checkout;
  checkout = null;
  // A theme re-render may have replaced the button the shopper pressed: press the one that stands in its place.
  const control = held && (held.isConnected ? held : document.querySelector<HTMLElement>(CHECKOUT));
  if (!control) return;
  bypass = true;
  control.click();
  bypass = false;
}

function interceptCheckout(event: MouseEvent): void {
  const control = event.target instanceof Element ? event.target.closest<HTMLElement>(CHECKOUT) : null;
  if (!control || bypass || !slider || picking || control.closest(ACCELERATED) || reminded().includes(slider.offerId)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    sessionStorage.setItem(REMINDED_KEY, JSON.stringify([...reminded(), slider.offerId]));
  } catch {
    // Without storage the reminder can repeat on the next page: acceptable.
  }
  checkout = control;
  emit(PromoEvents.GiftSliderRequested, { ...slider, title: t("giftReminder"), subtitle: null });
}

/** Checkout waits for the gift to be in the cart, but never longer than CHECKOUT_WAIT_MS: a slow or failed add must not trap the shopper. */
function checkoutAfterPick(): void {
  const abort = new AbortController();
  const wait = setTimeout(() => abort.abort(), CHECKOUT_WAIT_MS);
  const gifts = slider ? slider.selectableGifts.map((g) => g.variantId.split("/").pop()) : [];
  fetch(`${window.Shopify?.routes?.root || "/"}cart.js`, { signal: abort.signal, headers: { Accept: "application/json" } })
    .then((response) => response.json())
    .then((cart: { items?: Array<{ variant_id: number }> }) => {
      if (!(cart.items || []).some((item) => gifts.includes(String(item.variant_id)))) console.warn("[promo-engine] the gift is not in the cart; continuing to checkout");
    })
    .catch(() => console.warn("[promo-engine] could not confirm the gift; continuing to checkout"))
    .finally(() => {
      clearTimeout(wait);
      proceed();
    });
}

function decorateReminder(): void {
  const dialog = document.querySelector(MODAL);
  const modal = dialog && dialog.querySelector(".pe-slider-modal");
  if (!dialog || !modal) return;
  dialog.setAttribute("data-promo-gift-reminder", "");
  const skip = modal.appendChild(document.createElement("button"));
  skip.type = "button";
  skip.className = "pe-gift-continue";
  skip.setAttribute("data-promo-gift-reminder-continue", "");
  skip.textContent = t("giftReminderContinue");
  skip.onclick = () => dialog.querySelector<HTMLElement>("[data-promo-gift-close]")?.click();
}

export function initGiftPrompt(): void {
  let stalled: ReturnType<typeof setTimeout> | undefined;
  on<EvaluationResult>(PromoEvents.EvaluationCompleted, (result) => {
    slider = promptSlider(result);
    sync();
  });
  on(PromoEvents.GiftSliderOpened, () => {
    picking = true;
    if (checkout) decorateReminder();
    sync();
  });
  // After a confirmed pick the prompt stays hidden until the next evaluation says whether a gift is still owed.
  on<{ confirmed?: boolean } | undefined>(PromoEvents.GiftSliderClosed, (detail) => {
    const confirmed = Boolean(detail && detail.confirmed);
    picking = false;
    clearTimeout(stalled);
    if (confirmed) {
      if (checkout) checkoutAfterPick();
      slider = null;
    } else proceed();
    sync();
  });
  document.addEventListener("click", interceptCheckout, true);
  document.addEventListener("click", (event) => {
    if (checkout && event.target instanceof Element && event.target.closest(`${MODAL} .pe-btn-confirm`)) stalled = setTimeout(proceed, CHECKOUT_WAIT_MS);
  });
  picking = document.querySelector(MODAL) !== null;
  slider = promptSlider(window.PromoEngine ? window.PromoEngine.lastResult() : null);
  sync();
}

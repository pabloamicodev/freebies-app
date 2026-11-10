// Gift-removed notice asset: a small non-blocking toast, requested by the main bundle the first time the runtime removes a gift Shopify did not discount.
// The main bundle passes the (merchant-translatable) copy; this chunk only draws it. role="status" so it is announced without moving focus.
const STYLES = `
.pe-gift-notice { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483000; display: flex; align-items: center; gap: 8px;
  max-width: min(480px, calc(100vw - 32px)); padding: 10px 12px 10px 14px; border-radius: 8px; background: #111; color: #fff; font: 14px/1.4 system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.3); transition: opacity .2s; }
/* Closed: still in the accessibility tree (so the text change is announced) but visually clipped. */
.pe-gift-notice:not([data-open]) { clip-path: inset(50%); width: 1px; height: 1px; padding: 0; overflow: hidden; opacity: 0; pointer-events: none; }
.pe-gift-notice button { flex: none; min-width: 24px; min-height: 24px; border: 0; background: none; color: inherit; font: inherit; font-size: 18px; line-height: 1; cursor: pointer; }
.pe-gift-notice button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .pe-gift-notice { transition: none; } }
`;
const DISMISS_MS = 8_000;

export {};

declare global {
  interface Window {
    __peGiftNotice?: (message: string, closeLabel: string) => void;
  }
}

let box: HTMLElement | undefined;
let text: HTMLElement | undefined;
let closeBtn: HTMLButtonElement | undefined;
let before: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function hide(): void {
  clearTimeout(timer);
  // Closing with focus inside would drop it to <body>; hand it back to where it was (WCAG 2.4.3).
  if (box?.contains(document.activeElement)) {
    if (before?.isConnected && !box.contains(before)) before.focus();
    else (document.activeElement as HTMLElement).blur();
  }
  box?.removeAttribute("data-open");
  if (closeBtn) closeBtn.hidden = true;
  if (text) text.textContent = "";
}

function arm(): void {
  clearTimeout(timer);
  timer = setTimeout(hide, DISMISS_MS);
}

function build(closeLabel: string): void {
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);
  box = document.createElement("div");
  box.className = "pe-gift-notice";
  box.setAttribute("role", "status");
  text = document.createElement("span");
  closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", closeLabel);
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", hide);
  closeBtn.hidden = true;
  box.append(text, closeBtn);
  // Reading or focusing the notice pauses its timer (WCAG 2.2.1).
  box.addEventListener("mouseenter", () => clearTimeout(timer));
  box.addEventListener("focusin", (e) => {
    clearTimeout(timer);
    if (!box!.contains(e.relatedTarget as Node | null)) before = e.relatedTarget as HTMLElement | null;
  });
  box.addEventListener("mouseleave", arm);
  box.addEventListener("focusout", (e) => {
    if (!box!.contains(e.relatedTarget as Node | null)) arm();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && box?.hasAttribute("data-open")) hide();
  });
  document.body.appendChild(box);
}

window.__peGiftNotice = (message: string, closeLabel: string) => {
  if (!box || !text || !closeBtn) build(closeLabel);
  // The empty live region is in the tree before the text lands, so assistive tech announces the change.
  hide();
  setTimeout(() => {
    text!.textContent = message;
    closeBtn!.hidden = false;
    box!.setAttribute("data-open", "");
    arm();
  }, 50);
};

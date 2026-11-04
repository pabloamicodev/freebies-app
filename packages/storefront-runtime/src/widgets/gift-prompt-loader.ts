const self = (typeof document === "undefined" ? "" : (document.currentScript as HTMLScriptElement | null)?.src) || "";
let requested = false;

/** Requests the cart prompt asset that sits next to this bundle, once. It only enhances the picker, so a failed request is ignored. */
export function loadGiftPrompt(): void {
  const src = self.replace("promo-engine.js", "promo-engine-gift-prompt.js");
  if (requested || src === self) return;
  requested = true;
  const script = document.createElement("script");
  script.src = src;
  document.head.appendChild(script);
}

const pickerSrc = self.replace("promo-engine.js", "promo-engine-gift-picker.js");
/** Whether the product picker asset can be requested at all (not when this bundle's own URL is unknown). */
export const canLoadGiftPicker = () => pickerSrc !== self || Boolean(window.__peGiftPicker);

/** Requests the product picker asset (multi-product gift modals only); rejects when it fails so the modal falls back to one card per variant. */
export function loadGiftPicker(): Promise<NonNullable<Window["__peGiftPicker"]>> {
  return new Promise((resolve, reject) => {
    if (window.__peGiftPicker) return resolve(window.__peGiftPicker);
    const script = document.createElement("script");
    script.src = pickerSrc;
    script.onload = () => (window.__peGiftPicker ? resolve(window.__peGiftPicker) : reject(new Error("picker chunk did not register")));
    script.onerror = () => reject(new Error("picker chunk failed to load"));
    document.head.appendChild(script);
  });
}

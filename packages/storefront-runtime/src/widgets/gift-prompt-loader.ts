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

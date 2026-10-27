import type { initFbtWidget } from "./fbt.js";
import type { initBundleBuilder } from "./bundle-builder.js";

export interface BlocksApi {
  initFbtWidget: typeof initFbtWidget;
  initBundleBuilder: typeof initBundleBuilder;
}

declare global {
  interface Window {
    __peBlocks?: BlocksApi;
  }
}

const self = (typeof document === "undefined" ? "" : (document.currentScript as HTMLScriptElement | null)?.src) || "";
let pending: Promise<BlocksApi> | null = null;

/** Requests the FBT / bundle-builder chunk that sits next to this bundle, once. A failed request is retried by the next mount. */
export function loadBlocks(): Promise<BlocksApi> {
  if (window.__peBlocks) return Promise.resolve(window.__peBlocks);
  const src = self.replace("promo-engine.js", "promo-engine-blocks.js");
  if (src === self) return Promise.reject(new Error("blocks chunk URL unavailable"));
  pending ??= new Promise<BlocksApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => (window.__peBlocks ? resolve(window.__peBlocks) : reject(new Error("blocks chunk did not register")));
    script.onerror = () => reject(new Error("blocks chunk failed to load"));
    document.head.appendChild(script);
  }).catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

function failMount(container: HTMLElement, error: unknown): void {
  container.setAttribute("data-promo-engine-error", "true");
  console.warn("[PromoEngine] Block could not load:", error);
}

/** Same signature the theme blocks already call; the widget code arrives on demand. */
export const lazyInitFbtWidget: typeof initFbtWidget = (container, ...args) => {
  loadBlocks().then((blocks) => blocks.initFbtWidget(container, ...args)).catch((error) => failMount(container, error));
};

export const lazyInitBundleBuilder: typeof initBundleBuilder = (container, ...args) => {
  loadBlocks().then((blocks) => blocks.initBundleBuilder(container, ...args)).catch((error) => failMount(container, error));
};

// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canPromise, contextKey, encodeContext } from "../eligibility-context.js";
import { emit, PromoEvents } from "../event-bus.js";
import type { EvaluationResult } from "../types.js";
import "./gift-icon.js";
import "./volume-discount.js";
import { initBundleBuilder } from "./bundle-builder.js";
import { initFbtWidget } from "./fbt.js";

const OFFER = "offer-1";
const BLOCKS = resolve(__dirname, "../../../../apps/shopify-admin/extensions/theme-extension/blocks");

const result = (over: Partial<EvaluationResult> = {}) =>
  ({ qualifiedOffers: [{ offerId: OFFER }], giftSlider: null, ...over }) as unknown as EvaluationResult;

const settle = () => new Promise((r) => setTimeout(r, 60));

beforeEach(() => {
  document.body.innerHTML = "";
  (window as unknown as { __promoEngineConfig?: unknown }).__promoEngineConfig = {};
  history.replaceState(null, "", "/products/x");
});
afterEach(() => vi.unstubAllGlobals());

describe("canPromise", () => {
  it("cart scope follows the qualified offers", () => {
    expect(canPromise(result(), OFFER, "cart")).toBe(true);
    expect(canPromise(result({ qualifiedOffers: [] }), OFFER, "cart")).toBe(false);
    expect(canPromise(null, OFFER, "cart")).toBe(false);
  });

  it("add scope vetoes only on an explicit false pageGate", () => {
    expect(canPromise(result({ pageGate: { [OFFER]: false } }), OFFER, "add")).toBe(false);
    expect(canPromise(result({ pageGate: { [OFFER]: true } }), OFFER, "add")).toBe(true);
    expect(canPromise(result({ pageGate: { other: false } }), OFFER, "add")).toBe(true);
    expect(canPromise(result(), OFFER, "add")).toBe(true);
    expect(canPromise(null, OFFER, "add")).toBe(false);
  });
});

describe("encodeContext", () => {
  it("is independent of key order, so the proxy cache key is stable", () => {
    const a = encodeContext({ _promo_template: "t", _promo_page_url: "/p" });
    const b = encodeContext({ _promo_page_url: "/p", _promo_template: "t" });
    expect(a).toBe(b);
  });
});

describe("gift icon", () => {
  const hidden = (el: Element) => el.shadowRoot!.querySelector(".pe-gift-icon-wrap")!.classList.contains("pe-hidden");

  it("hides when the page gate fails for the offer and shows again when it passes", () => {
    const el = document.createElement("promo-gift-icon");
    el.setAttribute("offer-id", OFFER);
    document.body.appendChild(el);

    emit(PromoEvents.EvaluationCompleted, result({ pageGate: { [OFFER]: false } }));
    expect(hidden(el)).toBe(true);
    emit(PromoEvents.EvaluationCompleted, result({ pageGate: { [OFFER]: true } }));
    expect(hidden(el)).toBe(false);
    emit(PromoEvents.EvaluationCompleted, result());
    expect(hidden(el)).toBe(false);
  });
});

describe("volume discount", () => {
  it("sends the stamp context and asks again when it changes", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const el = document.createElement("promo-volume-discount");
    el.setAttribute("offer-id", OFFER);
    el.setAttribute("variant-id", "gid://shopify/ProductVariant/1");
    document.body.appendChild(el);
    await settle();

    const first = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(first).toContain(`ctx=${encodeContext()}`);

    emit(PromoEvents.EvaluationCompleted, result());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    history.replaceState(null, "", "/products/x?utm_source=tiktok");
    expect(contextKey()).toContain("utm_source=tiktok");
    emit(PromoEvents.EvaluationCompleted, result());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toContain(`ctx=${encodeContext()}`);
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).not.toBe(first);
  });
});

describe("bundle builder", () => {
  it("renders, withdraws on a failing pageGate and returns on a passing one", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    initBundleBuilder(
      container,
      { offerId: OFFER, bundleId: "b", title: "Build it", description: null, layoutMode: "all_steps_one_page", steps: [], tiers: [], currency: "USD" },
      "s",
    );
    await settle();
    expect(container.textContent).toContain("Build it");

    emit(PromoEvents.EvaluationCompleted, result({ pageGate: { [OFFER]: false } }));
    await settle();
    expect(container.textContent).not.toContain("Build it");

    emit(PromoEvents.EvaluationCompleted, result({ pageGate: { [OFFER]: true } }));
    await settle();
    expect(container.textContent).toContain("Build it");
  });
});

describe("fbt", () => {
  it("withdraws on a failing pageGate", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const product = {
      variantId: "v", productId: "p", title: "Thing", variantTitle: null, handle: "t", imageUrl: null,
      priceCents: 1000, compareAtPriceCents: null, discountedPriceCents: 900, isAvailable: true,
    };
    initFbtWidget(
      container,
      { offerId: OFFER, mainProduct: product, relatedProducts: [product], title: "Together", buttonText: "Add", discountPercent: 10, maxProducts: 1, layout: "amazon" },
      "USD",
      "s",
    );
    await settle();
    expect(container.textContent).toContain("Together");

    emit(PromoEvents.EvaluationCompleted, result({ pageGate: { [OFFER]: false } }));
    await settle();
    expect(container.textContent).not.toContain("Together");
  });
});

describe("theme blocks", () => {
  const read = (name: string) => readFileSync(resolve(BLOCKS, name), "utf8");

  it("fbt reuses the runtime evaluation instead of issuing its own", () => {
    const liquid = read("fbt.liquid");
    expect(liquid).not.toContain("/apps/promo-engine/evaluate");
    expect(liquid).toContain("PromoEngine.lastResult()");
    expect(liquid).toContain("promo-engine:evaluation-completed");
    expect(liquid).toContain("canPromise(result, u.offerId, 'add')");
  });

  it("bundle builder sends the encoded context, not a raw page_url", () => {
    const liquid = read("bundle_builder.liquid");
    expect(liquid).toContain("encodedEligibilityContext()");
    expect(liquid).not.toContain("page_url");
  });
});

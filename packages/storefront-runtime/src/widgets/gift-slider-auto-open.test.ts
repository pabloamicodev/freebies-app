import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, type VNode } from "preact";
import type * as Preact from "preact";
import { emit, PromoEvents } from "../event-bus.js";
import { loadDeclinedGiftRewards } from "../declined-gifts.js";
import { PromoEngineRuntime } from "../runtime.js";
import type { EvaluationResult, GiftSliderPayload } from "../types.js";
import { initGiftSlider } from "./gift-slider.js";

vi.mock("preact", async (importOriginal) => ({
  ...(await importOriginal<typeof Preact>()),
  render: vi.fn(),
}));

const AUTO_OPENED_KEY = "promo_engine_gift_slider_auto_opened_v2";
const slider = (offerId: string): GiftSliderPayload => ({
  offerId,
  title: `Gift ${offerId}`,
  subtitle: null,
  maxSelectableCount: 1,
  alreadySelectedCount: 0,
  selectableGifts: [{
    rewardId: `reward-${offerId}`,
    offerVersion: 1,
    variantId: "gid://shopify/ProductVariant/1",
    productHandle: offerId,
    isAvailable: true,
    isSelected: false,
    rewardMaxQuantity: 1,
  }],
}) as GiftSliderPayload;

function evaluate(...sliders: GiftSliderPayload[]) {
  emit(PromoEvents.EvaluationCompleted, {
    qualifiedOffers: sliders.map(({ offerId }) => ({ offerId })),
    giftSlider: sliders[0] ?? null,
    additionalGiftSliders: sliders.slice(1),
  } as EvaluationResult);
}

function openedOfferIds(): string[] {
  return vi.mocked(render).mock.calls.flatMap(([node]) => {
    const payload = (node as VNode<{ payload?: GiftSliderPayload }>).props.payload;
    return payload ? [payload.offerId] : [];
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(render).mockClear();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { Shopify: { routes: { root: "/" } } }));
  vi.stubGlobal("document", {
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild: vi.fn() },
    body: { appendChild: vi.fn() },
    addEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("gift slider auto-open lifecycle", () => {
  it("reopens after dismissal without selecting, dropping below $85, and qualifying again", async () => {
    Object.assign(window, { location: { href: "https://test.myshopify.com/cart" } });
    let subtotal = 9_000;
    const requests: Array<{ declinedGiftRewards: string[] }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/cart.js") {
        return new Response(JSON.stringify({
          token: "test-cart",
          items: [{ key: "paid-line", variant_id: 2, product_id: 2, quantity: 1, price: subtotal, properties: {} }],
          total_price: subtotal,
          item_count: 1,
          currency: "USD",
        }));
      }
      if (url.includes("/evaluate")) {
        requests.push(JSON.parse(String(init?.body)) as { declinedGiftRewards: string[] });
        return new Response(JSON.stringify({
          qualifiedOffers: subtotal >= 8_500 ? [{ offerId: "first" }] : [],
          giftSlider: subtotal >= 8_500 ? slider("first") : null,
          cartActions: [],
        }));
      }
      return new Response(JSON.stringify({ variants: [{ id: 1, available: true }] }));
    }));
    window.fetch = fetch;
    const runtime = new PromoEngineRuntime({ shopDomain: "test.myshopify.com", locale: "en", currency: "USD", debug: false });
    initGiftSlider("test-session");

    await runtime.api.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first"]);
    const node = vi.mocked(render).mock.calls[0]![0] as VNode<{
      onDismissWithoutSelection: () => void;
      onClose: () => void;
    }>;
    node.props.onDismissWithoutSelection();
    node.props.onClose();
    expect(loadDeclinedGiftRewards()).toEqual(new Set(["first:reward-first"]));

    subtotal = 9_100;
    await runtime.api.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first"]);
    expect.soft(requests[1]!.declinedGiftRewards).toEqual(["first:reward-first"]);

    subtotal = 8_000;
    await runtime.api.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(sessionStorage.getItem(AUTO_OPENED_KEY)!)).toEqual([]);
    expect.soft(loadDeclinedGiftRewards()).toEqual(new Set());

    subtotal = 9_000;
    await runtime.api.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[3]!.declinedGiftRewards).toEqual([]);
    expect(openedOfferIds()).toEqual(["first", "first"]);
  });

  it("opens with server stock when the new live-stock preflight stalls", async () => {
    initGiftSlider("test-session");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    evaluate(slider("first"));
    expect(sessionStorage.getItem(AUTO_OPENED_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(openedOfferIds()).toEqual(["first"]);
    expect(JSON.parse(sessionStorage.getItem(AUTO_OPENED_KEY)!)).toEqual(["first:1"]);
  });

  it("does not mark a sold-out picker as opened and can open when stock returns", async () => {
    initGiftSlider("test-session");
    const fetchStock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ variants: [{ id: 1, available: false }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ variants: [{ id: 1, available: true }] })));
    vi.stubGlobal("fetch", fetchStock);
    evaluate(slider("first"));
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual([]);
    expect(sessionStorage.getItem(AUTO_OPENED_KEY)).toBeNull();
    evaluate(slider("first"));
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first"]);
  });

  it.each([
    { name: "no configured fallback", hasFallback: false },
    { name: "a sold-out fallback", hasFallback: true },
  ])("does not open automatically or manually with sold-out gifts and $name", async ({ hasFallback }) => {
    initGiftSlider("test-session");
    const unavailable = slider("first");
    unavailable.selectableGifts[0]!.isAvailable = false;
    if (hasFallback) {
      unavailable.selectableGifts.push({
        ...unavailable.selectableGifts[0]!,
        variantId: "gid://shopify/ProductVariant/2",
        isFallback: true,
      });
    }
    const fetchStock = vi.fn();
    vi.stubGlobal("fetch", fetchStock);

    evaluate(unavailable);
    await vi.advanceTimersByTimeAsync(0);
    emit(PromoEvents.GiftSliderRequested, { offerId: unavailable.offerId });
    await vi.advanceTimersByTimeAsync(0);

    expect(openedOfferIds()).toEqual([]);
    expect(sessionStorage.getItem(AUTO_OPENED_KEY)).toBeNull();
    expect(fetchStock).not.toHaveBeenCalled();
  });

  it("does not open when live stock invalidates both the primary and its fallback, then retries after restock", async () => {
    initGiftSlider("test-session");
    const payload = slider("first");
    payload.selectableGifts.push({
      ...payload.selectableGifts[0]!,
      variantId: "gid://shopify/ProductVariant/2",
      isFallback: true,
    });
    let fallbackAvailable = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ variants: [
      { id: 1, available: false },
      { id: 2, available: fallbackAvailable },
    ] }))));

    evaluate(payload);
    await vi.advanceTimersByTimeAsync(0);
    emit(PromoEvents.GiftSliderRequested, { offerId: payload.offerId });
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual([]);
    expect(sessionStorage.getItem(AUTO_OPENED_KEY)).toBeNull();

    fallbackAvailable = true;
    evaluate(payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first"]);
    expect(JSON.parse(sessionStorage.getItem(AUTO_OPENED_KEY)!)).toEqual(["first:1,1"]);
  });

  it("skips an offer with no live stock and opens the next available offer", async () => {
    initGiftSlider("test-session");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ variants: [{ id: 1, available: false }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ variants: [{ id: 1, available: true }] }))));

    evaluate(slider("sold-out"), slider("available"));
    await vi.advanceTimersByTimeAsync(0);

    expect(openedOfferIds()).toEqual(["available"]);
    expect(JSON.parse(sessionStorage.getItem(AUTO_OPENED_KEY)!)).toEqual(["available:1"]);
  });

  it("keeps unopened offers queued when another offer qualifies while a picker is open", async () => {
    initGiftSlider("test-session");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ variants: [{ id: 1, available: true }] }))));
    evaluate(slider("first"), slider("second"));
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first"]);
    expect(JSON.parse(sessionStorage.getItem(AUTO_OPENED_KEY)!)).toEqual(["first:1"]);
    evaluate(slider("first"), slider("second"), slider("third"));
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first"]);
    emit(PromoEvents.GiftSliderClosed);
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first", "second"]);
    emit(PromoEvents.GiftSliderClosed);
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first", "second", "third"]);
  });

  it("does not open a stale eligible offer after the cart drops below its threshold", async () => {
    initGiftSlider("test-session");
    let finishStock!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finishStock = resolve; })));
    evaluate(slider("first"));
    evaluate();
    finishStock(new Response(JSON.stringify({ variants: [{ id: 1, available: true }] })));
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual([]);
    expect(sessionStorage.getItem(AUTO_OPENED_KEY)).toBeNull();
  });

  it("bounds stock response body parsing as well as the initial request", async () => {
    initGiftSlider("test-session");
    const fetchStock = vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }));
    vi.stubGlobal("fetch", fetchStock);
    evaluate(slider("first"));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(openedOfferIds()).toEqual(["first"]);
  });

  it("recovers sessions whose old bundle acknowledged a picker that never opened", async () => {
    sessionStorage.setItem("promo_engine_gift_slider_auto_opened", JSON.stringify(["first:1"]));
    initGiftSlider("test-session");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ variants: [{ id: 1, available: true }] }))));
    evaluate(slider("first"));
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["first"]);
    expect(JSON.parse(sessionStorage.getItem(AUTO_OPENED_KEY)!)).toEqual(["first:1"]);
  });

  it("does not let a pending auto-open replace a manually requested picker", async () => {
    initGiftSlider("test-session");
    let finishFirst!: (response: Response) => void;
    const stock = () => new Response(JSON.stringify({ variants: [{ id: 1, available: true }] }));
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve; }))
      .mockImplementation(async () => stock()));
    evaluate(slider("first"), slider("second"));
    emit(PromoEvents.GiftSliderRequested, { offerId: "second" });
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["second"]);
    finishFirst(stock());
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["second"]);
    emit(PromoEvents.GiftSliderClosed);
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["second", "first"]);
  });

  it("queues newly qualified offers while a manually opened picker is visible", async () => {
    initGiftSlider("test-session");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ variants: [{ id: 1, available: true }] }))));
    emit(PromoEvents.GiftSliderRequested, slider("manual"));
    await vi.advanceTimersByTimeAsync(0);
    evaluate(slider("manual"), slider("first"));
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["manual"]);
    emit(PromoEvents.GiftSliderClosed);
    await vi.advanceTimersByTimeAsync(0);
    expect(openedOfferIds()).toEqual(["manual", "first"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GiftSliderModule from "./widgets/gift-slider.js";

vi.mock("./widgets/gift-slider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GiftSliderModule>()),
  initGiftSlider: vi.fn(),
}));

import { initRuntime, PromoEngineRuntime } from "./runtime.js";
import { OWN_REQUEST_HEADER } from "./cart-adapter.js";
import { loadDeclinedGiftRewards, saveDeclinedGiftRewards } from "./declined-gifts.js";

const CONFIG = { shopDomain: "s.myshopify.com", locale: "en", currency: "USD", debug: false, cartItemCount: 0 };
const GIFT_PROPS = {
  _promo_engine_line_type: "gift",
  _promo_engine_offer_id: "o1",
  _promo_engine_reward_id: "r1",
};

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
const emptyCart = { token: "t", items: [], total_price: 0, currency: "USD", item_count: 0 };
const okResult = (extra: Record<string, unknown> = {}) => ({
  requestId: "r",
  cartHash: "h",
  qualifiedOffers: [],
  disqualifiedOffers: [],
  cartActions: [],
  discountCodes: { add: [], remove: [] },
  giftSlider: null,
  cartMessages: [],
  progressBars: [],
  upsells: [],
  warnings: [],
  evaluatedAt: "now",
  ...extra,
});

function harness(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [re, handler] of routes) if (re.test(url)) return handler(init);
    return new Response("{}", { status: 404 });
  });
  const win = {
    fetch: fetchStub,
    location: { href: "https://s.example/", origin: "https://s.example", pathname: "/", search: "" },
    Shopify: { routes: { root: "/" } },
    dispatchEvent: vi.fn(),
    addEventListener: (type: string, h: (e: unknown) => void) => void (listeners[type] ??= []).push(h),
    removeEventListener: vi.fn(),
    __promoEngineConfig: CONFIG,
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("fetch", fetchStub);
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("document", {
    readyState: "complete",
    querySelector: () => null,
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      open() {}
      send() {}
    },
  );
  const count = (re: RegExp) => calls.filter((c) => re.test(c.url)).length;
  return { calls, listeners, win, count, fetchStub };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("evaluate timeout", () => {
  it("aborts a hung /evaluate after 7 s and reports a timeout", async () => {
    const h = harness([
      [/cart\.js/, () => json(emptyCart)],
      [
        /evaluate/,
        (init) =>
          new Promise<Response>((_, reject) =>
            init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
          ),
      ],
    ]);
    const rt = new PromoEngineRuntime(CONFIG);
    const pending = rt.api.evaluate();
    await vi.advanceTimersByTimeAsync(6_900);
    expect(h.win.dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "promo-engine:cart-mutation-error" }));
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toBeNull();
    const errorEvent = h.win.dispatchEvent.mock.calls
      .map((c) => c[0] as CustomEvent)
      .find((e) => e.type === "promo-engine:cart-mutation-error");
    expect((errorEvent!.detail as { error: string }).error).toMatch(/timed out/);
  });
});

describe("429 + Retry-After", () => {
  beforeEach(() => void vi.spyOn(Math, "random").mockReturnValue(0.5));
  afterEach(() => vi.restoreAllMocks());

  it("jitters the delay by +-30% so tabs do not retry in lockstep", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const h = harness([
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => new Response("no", { status: 429, headers: { "Retry-After": "10" } })],
    ]);
    const rt = new PromoEngineRuntime(CONFIG);
    await rt.api.evaluate();
    await vi.advanceTimersByTimeAsync(6_900);
    expect(h.count(/evaluate/)).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.count(/evaluate/)).toBe(2);
  });

  it("retries once after the server-specified delay, not before", async () => {
    let evaluateCalls = 0;
    const h = harness([
      [/cart\.js/, () => json(emptyCart)],
      [
        /evaluate/,
        () => (++evaluateCalls === 1 ? new Response("slow down", { status: 429, headers: { "Retry-After": "3" } }) : json(okResult())),
      ],
    ]);
    const rt = new PromoEngineRuntime(CONFIG);
    expect(await rt.api.evaluate()).toBeNull();
    expect(h.count(/evaluate/)).toBe(1);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(h.count(/evaluate/)).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.count(/evaluate/)).toBe(2);
  });

  it.each([429, 503])("publishes a successful retry after %s so qualified gift pickers can open", async (status) => {
    let evaluateCalls = 0;
    const result = okResult({ giftSlider: { offerId: "o1", selectableGifts: [] } });
    const h = harness([
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => ++evaluateCalls === 1
        ? new Response("retry", { status, headers: { "Retry-After": "1" } })
        : json(result)],
    ]);
    const rt = new PromoEngineRuntime(CONFIG);
    await rt.api.evaluate();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.win.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "promo-engine:evaluation-completed",
      detail: result,
    }));
  });

  it("preserves a forced silent gift validation when it must retry", async () => {
    let evaluateCalls = 0;
    const h = harness([
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => ++evaluateCalls === 2
        ? new Response("retry", { status: 429, headers: { "Retry-After": "1" } })
        : json(okResult())],
    ]);
    const rt = new PromoEngineRuntime(CONFIG);
    await rt.api.evaluate();
    h.win.dispatchEvent.mockClear();
    await rt.api.validateGiftOffer("o1");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.count(/evaluate/)).toBe(3);
    expect(h.win.dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "promo-engine:evaluation-completed",
    }));
  });

  it("gives up after 3 consecutive rate limits instead of hammering", async () => {
    const h = harness([
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => new Response("no", { status: 429, headers: { "Retry-After": "1" } })],
    ]);
    const rt = new PromoEngineRuntime(CONFIG);
    await rt.api.evaluate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.count(/evaluate/)).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.count(/evaluate/)).toBe(4);
    expect(h.win.dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "promo-engine:cart-mutation-error" }));
  });
});

describe("declined-gift false positive", () => {
  const giftAction = {
    action: "add_line",
    variantId: "gid://shopify/ProductVariant/55",
    quantity: 1,
    properties: GIFT_PROPS,
  };
  const evaluateWith = (addStatus: number) =>
    harness([
      [/cart\/add\.js/, () => json({ description: "nope" }, { status: addStatus })],
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => json(okResult({ qualifiedOffers: [{ offerId: "o1" }], cartActions: [giftAction] }))],
    ]);

  it("a gift whose add FAILED is not later treated as customer-declined", async () => {
    evaluateWith(500);
    const rt = new PromoEngineRuntime(CONFIG);
    await rt.api.evaluate();
    await rt.api.evaluate();
    expect((rt as unknown as { declinedGiftRewards: Set<string> }).declinedGiftRewards.size).toBe(0);
  });

  it("a gift that was added and then vanished IS recorded as declined", async () => {
    evaluateWith(200);
    const rt = new PromoEngineRuntime(CONFIG);
    await rt.api.evaluate();
    await rt.api.evaluate();
    expect([...(rt as unknown as { declinedGiftRewards: Set<string> }).declinedGiftRewards]).toEqual(["o1:r1"]);
  });

  it("clears a dismissal recorded while evaluation was pending, preserving other qualified offers", async () => {
    let finishEvaluation!: (response: Response) => void;
    const h = harness([
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => new Promise<Response>((resolve) => { finishEvaluation = resolve; })],
    ]);
    const rt = new PromoEngineRuntime(CONFIG);
    const pending = rt.api.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    saveDeclinedGiftRewards(new Set(["o1:r1", "o2:r2"]));
    finishEvaluation(json(okResult({ qualifiedOffers: [{ offerId: "o2" }] })));
    await pending;
    expect(loadDeclinedGiftRewards()).toEqual(new Set(["o2:r2"]));

    const next = rt.api.validateGiftOffer("o2");
    await vi.advanceTimersByTimeAsync(0);
    const body = JSON.parse(String(h.calls.filter(({ url }) => /evaluate/.test(url))[1]!.init?.body));
    expect(body.declinedGiftRewards).toEqual(["o2:r2"]);
    finishEvaluation(json(okResult({ qualifiedOffers: [{ offerId: "o2" }] })));
    await next;
  });

  it("does not overwrite a newly dismissed reward when detecting another removed gift", async () => {
    let addGift = true;
    const h = harness([
      [/cart\/add\.js/, () => json(emptyCart)],
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => json(okResult({
        qualifiedOffers: [{ offerId: "o1" }, { offerId: "o2" }],
        cartActions: addGift ? [giftAction] : [],
      }))],
    ]);
    const rt = new PromoEngineRuntime(CONFIG);
    await rt.api.evaluate();
    saveDeclinedGiftRewards(new Set(["o2:r2"]));
    addGift = false;
    await rt.api.validateGiftOffer("o1");
    const body = JSON.parse(String(h.calls.filter(({ url }) => /evaluate/.test(url))[1]!.init?.body));
    expect(new Set(body.declinedGiftRewards)).toEqual(new Set(["o1:r1", "o2:r2"]));
    expect(loadDeclinedGiftRewards()).toEqual(new Set(["o1:r1", "o2:r2"]));
  });
});

describe("init guard, bfcache and per-request guard", () => {
  it("never initialises twice", () => {
    const h = harness([]);
    initRuntime();
    const first = (h.win as unknown as { PromoEngine?: unknown }).PromoEngine;
    initRuntime();
    expect((h.win as unknown as { PromoEngine?: unknown }).PromoEngine).toBe(first);
    expect(h.listeners["pageshow"]).toHaveLength(1);
  });

  it("re-evaluates after a bfcache restore but not a normal pageshow", async () => {
    const h = harness([
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => json(okResult())],
    ]);
    initRuntime();
    h.listeners["pageshow"]![0]!({ persisted: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.count(/cart\.js/)).toBe(0);
    h.listeners["pageshow"]![0]!({ persisted: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.count(/cart\.js/)).toBe(1);
  });

  it("ignores only our own cart requests, so a theme add during our work still re-evaluates", async () => {
    const h = harness([
      [/cart\/add/, () => json({})],
      [/cart\.js/, () => json(emptyCart)],
      [/evaluate/, () => json(okResult())],
    ]);
    initRuntime();
    await h.win.fetch("/cart/add.js", { method: "POST", body: "{}", headers: { [OWN_REQUEST_HEADER]: "1" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.count(/\/cart\.js$/)).toBe(0);
    await h.win.fetch("/cart/add.js", { method: "POST", body: "{}" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.count(/\/cart\.js$/)).toBe(1);
  });
});

let cartVersion = 0;

describe("gift hold on theme add-to-cart", () => {
  const giftAction = { action: "add_line", variantId: "gid://shopify/ProductVariant/55", quantity: 1, properties: GIFT_PROPS };
  const isOwn = (init?: RequestInit) => Boolean((init?.headers as Record<string, string> | undefined)?.[OWN_REQUEST_HEADER]);

  function setup(offerType = "gift") {
    let actions: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness([
      [/cart\/add/, (init) => (isOwn(init) ? gate.then(() => json({})) : json({ items: [{ id: 1 }] }))],
      [/cart\.js/, () => json({ ...emptyCart, total_price: ++cartVersion })],
      [/evaluate/, () => json(okResult({ qualifiedOffers: [{ offerId: "o1", type: offerType }], cartActions: actions }))],
    ]);
    initRuntime();
    vi.stubGlobal("fetch", h.win.fetch);
    const api = (h.win as unknown as { PromoEngine: { evaluate: () => Promise<unknown>; whenGiftsReady: () => Promise<void> } }).PromoEngine;
    const giftAdds = () => h.calls.filter((c) => /cart\/add/.test(c.url) && isOwn(c.init)).length;
    return { h, api, release, giftAdds, armGift: () => void (actions = [giftAction]) };
  }
  const themeAdd = (h: ReturnType<typeof harness>) => h.win.fetch("/cart/add.js", { method: "POST", body: "{}" });

  it("resolves the theme add only after our gift add completed, with the original response", async () => {
    const t = setup();
    await t.api.evaluate();
    t.armGift();
    let settled = false;
    const added = themeAdd(t.h).then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(500);
    expect(t.giftAdds()).toBe(1);
    expect(settled).toBe(false);
    t.release();
    const response = await added;
    expect(await response.json()).toEqual({ items: [{ id: 1 }] });
    expect(t.h.win.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "promo-engine:gifts-ready" }));
  });

  it("does not re-trigger on its own gift add", async () => {
    const t = setup();
    await t.api.evaluate();
    t.armGift();
    const added = themeAdd(t.h);
    await vi.advanceTimersByTimeAsync(0);
    t.release();
    await added;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.giftAdds()).toBe(1);
    expect(t.h.count(/evaluate/)).toBe(2);
  });

  it("releases the theme add with the original response after 3 s and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    await t.api.evaluate();
    t.armGift();
    let settled = false;
    const added = themeAdd(t.h).then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(2_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await (await added).json()).toEqual({ items: [{ id: 1 }] });
    expect(warn).toHaveBeenCalled();
    t.release();
    warn.mockRestore();
  });

  it("does not hold when no gift offer applies", async () => {
    const t = setup("discount");
    await t.api.evaluate();
    t.armGift();
    await themeAdd(t.h);
    expect(t.h.count(/evaluate/)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.h.count(/evaluate/)).toBe(2);
    t.release();
  });

  it("whenGiftsReady waits for pending gift mutations", async () => {
    const t = setup();
    t.armGift();
    let ready = false;
    const pending = t.api.whenGiftsReady().then(() => (ready = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(ready).toBe(false);
    t.release();
    await pending;
    expect(t.giftAdds()).toBe(1);
  });
});

describe("gift hold on XHR add-to-cart", () => {
  it("replays the completion events only after our gift add completed", async () => {
    vi.resetModules();
    const fresh = await import("./runtime.js");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness([
      [/cart\/add/, (init) => ((init?.headers as Record<string, string> | undefined)?.[OWN_REQUEST_HEADER] ? gate.then(() => json({})) : json({}))],
      [/cart\.js/, () => json({ ...emptyCart, total_price: ++cartVersion })],
      [/evaluate/, () => json(okResult({ qualifiedOffers: [{ offerId: "o1", type: "gift" }], cartActions: [
        { action: "add_line", variantId: "gid://shopify/ProductVariant/55", quantity: 1, properties: GIFT_PROPS },
      ] }))],
    ]);
    class FakeXhr extends EventTarget {
      readyState = 0;
      status = 0;
      open(_method: string, _url: string, _async?: boolean) {}
      send() {
        setTimeout(() => {
          this.readyState = 4;
          this.status = 200;
          for (const type of ["readystatechange", "load", "loadend"]) this.dispatchEvent(new Event(type));
        }, 10);
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    fresh.initRuntime();
    vi.stubGlobal("fetch", h.win.fetch);

    const xhr = new FakeXhr();
    const seen: string[] = [];
    xhr.open("POST", "/cart/add.js", true);
    for (const type of ["readystatechange", "load", "loadend"]) xhr.addEventListener(type, () => seen.push(type));
    xhr.send();
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["readystatechange", "load", "loadend"]);
  });
});

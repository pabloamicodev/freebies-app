/**
 * Gift funding end to end: when Shopify's best-of leaves the auto-added gift at full price, the real runtime removes
 * it once, tells /evaluate not to re-add it while the cart is unchanged, and never records it as a customer decline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GiftSliderModule from "./widgets/gift-slider.js";

vi.mock("./widgets/gift-slider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GiftSliderModule>()),
  initGiftSlider: vi.fn(),
}));

import { evaluate, type OfferDefinition } from "@promo/rule-engine";
import { PromoEngineRuntime } from "./runtime.js";
import { loadDeclinedGiftRewards } from "./declined-gifts.js";

const CONFIG = { shopDomain: "s.myshopify.com", locale: "en", currency: "USD", debug: false, cartItemCount: 0 };
const OFFER = "offer-funding";

const offer: OfferDefinition = {
  id: OFFER,
  version: 1,
  type: "gift",
  priority: 100,
  stopLowerPriority: false,
  startsAt: null,
  endsAt: null,
  conditions: [
    { id: "c", scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 7000, currencyCode: "USD", includeGiftValues: false }, sortOrder: 0, isEnabled: true },
  ],
  rewards: [
    {
      id: "r1",
      rewardType: "product_gift",
      discountType: "free",
      value: { percentage: 100 },
      target: { scope: "cart", variantIds: ["gid://shopify/ProductVariant/101"] },
      quantity: 1,
      isAutoAdd: true,
      isCustomerSelectable: false,
      trackMode: "variant",
      sortOrder: 0,
      label: null,
      minCartSubtotalCents: 7000,
    },
  ],
  combinationPolicy: { combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, stopLowerPriority: false, maxApplicationsPerCart: null, maxApplicationsPerCustomer: null },
  giftValueCountsForOtherOffers: false,
};

type Item = { key: string; variant_id: number; product_id: number; quantity: number; price: number; properties: Record<string, string> };

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function shop(opts: { shopifyFundsGift: boolean; flipAfterFirstUnfundedRead?: boolean }) {
  let funds = opts.shopifyFundsGift;
  let flip = opts.flipAfterFirstUnfundedRead ?? false;
  let items: Item[] = [{ key: "paid", variant_id: 1, product_id: 1, quantity: 1, price: 12000, properties: {} }];
  let next = 0;
  const counts = { add: 0, change: 0 };
  const cart = () => {
    const isGift = (i: Item) => i.properties["_promo_engine_line_type"] === "gift";
    const lines = items.map((i) => ({ ...i, original_line_price: i.price * i.quantity, final_line_price: isGift(i) && funds ? 0 : i.price * i.quantity }));
    if (flip && items.some(isGift) && !funds) {
      funds = true; // the read that just built `lines` was unfunded; every later one is funded
      flip = false;
    }
    return { token: "t", items: lines, total_price: 0, currency: "USD", item_count: items.length };
  };
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (/cart\/add\.js/.test(url)) {
      counts.add++;
      for (const line of body.items) items = [...items, { key: `g${next++}`, variant_id: line.id, product_id: line.id, quantity: line.quantity, price: 1499, properties: line.properties }];
      return json(cart());
    }
    if (/cart\/change\.js/.test(url)) {
      counts.change++;
      items = items.filter((i) => i.key !== body.id);
      return json(cart());
    }
    if (/evaluate/.test(url)) {
      return json(await evaluate({ shopDomain: "s.myshopify.com", ...body, customer: null, market: null }, { offers: [offer], usageStates: [], now: new Date("2026-06-01T12:00:00Z"), shopCurrencyCode: "USD" }));
    }
    return json(cart());
  });
  vi.stubGlobal("fetch", fetchStub);
  vi.stubGlobal("window", {
    fetch: fetchStub,
    location: { href: "https://s.example/", origin: "https://s.example", pathname: "/", search: "" },
    Shopify: { routes: { root: "/" } },
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    __promoEngineConfig: CONFIG,
  });
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("document", { readyState: "complete", querySelector: () => null, addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal("XMLHttpRequest", class { open() {} send() {} });
  const rt = new PromoEngineRuntime(CONFIG);
  return {
    counts,
    setFunds: (v: boolean) => void (funds = v),
    setPaidQty: (qty: number) => void (items = items.map((i) => (i.key === "paid" ? { ...i, quantity: qty } : i))),
    gifts: () => items.filter((i) => i.properties["_promo_engine_line_type"] === "gift").length,
    sync: async () => {
      await rt.api.validateGiftOffer(OFFER);
      await vi.advanceTimersByTimeAsync(11_000);
    },
    declined: () => [...loadDeclinedGiftRewards()],
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("gift funding in the storefront runtime", () => {
  it("removes a gift Shopify left at full price once, never loops, never records a decline; re-adds once the cart changes and the gift is funded", async () => {
    const s = shop({ shopifyFundsGift: false });
    await s.sync();
    expect(s.gifts()).toBe(0);
    for (let i = 0; i < 3; i++) await s.sync();
    expect(s.counts).toEqual({ add: 1, change: 1 });
    expect(s.gifts()).toBe(0);
    expect(s.declined()).toEqual([]);

    s.setFunds(true);
    s.setPaidQty(2);
    await s.sync();
    await s.sync();
    expect(s.gifts()).toBe(1);
    expect(s.counts).toEqual({ add: 2, change: 1 });
    expect(s.declined()).toEqual([]);
  });

  it("keeps a gift Shopify discounted", async () => {
    const s = shop({ shopifyFundsGift: true });
    await s.sync();
    await s.sync();
    expect(s.gifts()).toBe(1);
    expect(s.counts).toEqual({ add: 1, change: 0 });
  });

  it("does not remove a gift that was only transiently unfunded (the confirming read is funded)", async () => {
    const s = shop({ shopifyFundsGift: false, flipAfterFirstUnfundedRead: true });
    await s.sync();
    await s.sync();
    expect(s.gifts()).toBe(1);
    expect(s.counts.change).toBe(0);
  });
});

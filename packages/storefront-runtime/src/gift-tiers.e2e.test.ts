/**
 * Gift tiers end to end: the real runtime talks to a stub /evaluate that runs the real rule-engine, with a cart
 * that applies the runtime's add/remove calls. Pins that a gift dropped because the cart fell below its tier is
 * never recorded as a decline (and returns on re-qualification), while a gift the shopper removed stays declined.
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
const OFFER = "offer-tiers";
const T1 = 7000;
const T2 = 11000;

const giftReward = (id: string, variant: number, minCartSubtotalCents: number, sortOrder: number) => ({
  id,
  rewardType: "product_gift" as const,
  discountType: "free",
  value: { percentage: 100 },
  target: { scope: "cart", variantIds: [`gid://shopify/ProductVariant/${variant}`] },
  quantity: 1,
  isAutoAdd: true,
  isCustomerSelectable: false,
  trackMode: "variant" as const,
  sortOrder,
  label: null,
  minCartSubtotalCents,
});

const offer = (tierMode?: "highest"): OfferDefinition => ({
  id: OFFER,
  version: 1,
  type: "gift",
  priority: 100,
  ...(tierMode ? { tierMode } : {}),
  stopLowerPriority: false,
  startsAt: null,
  endsAt: null,
  conditions: [
    { id: "c", scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: T1, currencyCode: "USD", includeGiftValues: false }, sortOrder: 0, isEnabled: true },
  ],
  rewards: [giftReward("r1", 101, T1, 0), giftReward("r2", 102, T2, 1)],
  combinationPolicy: { combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, stopLowerPriority: false, maxApplicationsPerCart: null, maxApplicationsPerCustomer: null },
  giftValueCountsForOtherOffers: false,
});

type Item = { key: string; variant_id: number; product_id: number; quantity: number; price: number; properties: Record<string, string> };

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function shop(tierMode?: "highest") {
  let items: Item[] = [{ key: "paid", variant_id: 1, product_id: 1, quantity: 1, price: 12000, properties: {} }];
  let next = 0;
  const cart = () => ({ token: "t", items, total_price: items.reduce((sum, i) => sum + i.price * i.quantity, 0), currency: "USD", item_count: items.reduce((sum, i) => sum + i.quantity, 0) });
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (/cart\/add\.js/.test(url)) {
      for (const line of body.items) items = [...items, { key: `g${next++}`, variant_id: line.id, product_id: line.id, quantity: line.quantity, price: 3000, properties: line.properties }];
      return json(cart());
    }
    if (/cart\/change\.js/.test(url)) {
      items = items.filter((i) => i.key !== body.id);
      return json(cart());
    }
    if (/evaluate/.test(url)) {
      const result = await evaluate({ shopDomain: "s.myshopify.com", ...body, customer: null, market: null }, { offers: [offer(tierMode)], usageStates: [], now: new Date("2026-06-01T12:00:00Z"), shopCurrencyCode: "USD" });
      return json(result);
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
    setPaid: (cents: number) => void (items = items.map((i) => (i.key === "paid" ? { ...i, price: cents } : i))),
    shopperRemoves: (rewardId: string) => void (items = items.filter((i) => i.properties["_promo_engine_reward_id"] !== rewardId)),
    gifts: () => items.filter((i) => i.properties["_promo_engine_line_type"] === "gift").map((i) => i.properties["_promo_engine_reward_id"]).sort(),
    // Past the add grace window, so a vanished gift can only be read as the shopper's removal.
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

describe("gift tiers in the storefront runtime", () => {
  it("adds every reached tier's gift, drops a gift whose tier is no longer met without a decline, and re-adds it on re-qualifying", async () => {
    const s = shop();
    await s.sync();
    expect(s.gifts()).toEqual(["r1", "r2"]);
    await s.sync();

    s.setPaid(8000);
    await s.sync();
    expect(s.gifts()).toEqual(["r1"]);
    expect(s.declined()).toEqual([]);

    await s.sync();
    expect(s.gifts()).toEqual(["r1"]);
    expect(s.declined()).toEqual([]);

    s.setPaid(12000);
    await s.sync();
    expect(s.gifts()).toEqual(["r1", "r2"]);
    expect(s.declined()).toEqual([]);
  });

  it("a gift the shopper removed stays declined, also after the cart drops below its tier and climbs back", async () => {
    const s = shop();
    await s.sync();
    await s.sync();
    s.shopperRemoves("r2");
    await s.sync();
    expect(s.declined()).toEqual([`${OFFER}:r2`]);
    expect(s.gifts()).toEqual(["r1"]);

    s.setPaid(8000);
    await s.sync();
    s.setPaid(12000);
    await s.sync();
    await s.sync();
    expect(s.declined()).toEqual([`${OFFER}:r2`]);
    expect(s.gifts()).toEqual(["r1"]);
  });

  it("highest mode swaps the lower tier's gift for the top one and back, never as a decline", async () => {
    const s = shop("highest");
    await s.sync();
    await s.sync();
    expect(s.gifts()).toEqual(["r2"]);

    s.setPaid(8000);
    await s.sync();
    await s.sync();
    expect(s.gifts()).toEqual(["r1"]);

    s.setPaid(12000);
    await s.sync();
    await s.sync();
    expect(s.gifts()).toEqual(["r2"]);
    expect(s.declined()).toEqual([]);
  });
});

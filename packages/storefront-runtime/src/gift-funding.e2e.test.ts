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

const reward = (id: string, variant: number, quantity = 1) => ({
  id,
  rewardType: "product_gift" as const,
  discountType: "free",
  value: { percentage: 100 },
  target: { scope: "cart", variantIds: [`gid://shopify/ProductVariant/${variant}`] },
  quantity,
  isAutoAdd: true,
  isCustomerSelectable: false,
  trackMode: "variant" as const,
  sortOrder: variant,
  label: null,
  minCartSubtotalCents: 7000,
});

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
  rewards: [reward("r1", 101), reward("r2", 102)],
  combinationPolicy: { combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, stopLowerPriority: false, maxApplicationsPerCart: null, maxApplicationsPerCustomer: null },
  giftValueCountsForOtherOffers: false,
};

type Item = { key: string; variant_id: number; product_id: number; quantity: number; price: number; properties: Record<string, string>; funded?: boolean };

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function shop(opts: { shopifyFundsGift: boolean; flipAfterFirstUnfundedRead?: boolean; flag?: boolean | null; extraItems?: Item[]; rewards?: number; rewardQty?: number }) {
  const rewardCount = opts.rewards ?? 1;
  let funds = opts.shopifyFundsGift;
  let flip = opts.flipAfterFirstUnfundedRead ?? false;
  let items: Item[] = [{ key: "paid", variant_id: 1, product_id: 1, quantity: 1, price: 12000, properties: {} }, ...(opts.extraItems ?? [])];
  const offerDef = rewardCount === 1 ? { ...offer, rewards: [reward("r1", 101)] } : offer;
  let next = 0;
  const counts = { add: 0, change: 0 };
  const removed: string[] = [];
  const dispatch = vi.fn();
  let onChange: (() => void) | null = null;
  const cart = () => {
    const isGift = (i: Item) => i.properties["_promo_engine_line_type"] === "gift";
    const lines = items.map((i) => ({ ...i, original_line_price: i.price * i.quantity, final_line_price: isGift(i) && (i.funded ?? funds) ? 0 : i.price * i.quantity }));
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
      removed.push(body.id);
      onChange?.();
      items = items.filter((i) => i.key !== body.id);
      return json(cart());
    }
    if (/evaluate/.test(url)) {
      return json(await evaluate({ shopDomain: "s.myshopify.com", ...body, customer: null, market: null }, { offers: [offerDef], usageStates: [], now: new Date("2026-06-01T12:00:00Z"), shopCurrencyCode: "USD" }));
    }
    return json(cart());
  });
  vi.stubGlobal("fetch", fetchStub);
  vi.stubGlobal("window", {
    fetch: fetchStub,
    location: { href: "https://s.example/", origin: "https://s.example", pathname: "/", search: "" },
    Shopify: { routes: { root: "/" } },
    dispatchEvent: dispatch,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    __promoEngineConfig: CONFIG,
  });
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("document", { readyState: "complete", querySelector: () => null, addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal("XMLHttpRequest", class { open() {} send() {} });
  const config: ConstructorParameters<typeof PromoEngineRuntime>[0] = { ...CONFIG, removeUnfundedGifts: opts.flag === undefined ? true : opts.flag };
  const rt = new PromoEngineRuntime(config);
  return {
    counts,
    onChange: (fn: () => void) => void (onChange = fn),
    rt,
    config,
    items: () => items,
    setFunds: (v: boolean) => void (funds = v),
    setPaidQty: (qty: number) => void (items = items.map((i) => (i.key === "paid" ? { ...i, quantity: qty } : i))),
    gifts: () => items.filter((i) => i.properties["_promo_engine_line_type"] === "gift").length,
    removeKeys: () => removed,
    notDiscountedRemovals: () => dispatch.mock.calls.filter(([e]) => (e as CustomEvent).detail?.reason === "gift_not_discounted").length,
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

  it("never touches a full-price gift-looking line that carries none of our properties (other app or theme)", async () => {
    const other: Item = { key: "other", variant_id: 777, product_id: 777, quantity: 1, price: 1499, properties: {} };
    const s = shop({ shopifyFundsGift: false, extraItems: [other], rewards: 1 });
    await s.sync();
    await s.sync();
    expect(s.notDiscountedRemovals()).toBeGreaterThan(0);
    expect(s.removeKeys()).not.toContain("other");
    expect(s.items().some((i) => i.key === "other")).toBe(true);
  });

  it("keeps a picker reward when one of its tagged lines is discounted and another is charged", async () => {
    const tag = { _promo_engine_line_type: "gift", _promo_engine_offer_id: OFFER, _promo_engine_reward_id: "r1" };
    const free: Item = { key: "pick-free", variant_id: 101, product_id: 101, quantity: 1, price: 1499, properties: tag, funded: true };
    const charged: Item = { key: "pick-charged", variant_id: 101, product_id: 101, quantity: 1, price: 1499, properties: { ...tag, extra: "1" }, funded: false };
    const s = shop({ shopifyFundsGift: false, extraItems: [free, charged], rewards: 1 });
    const removeUnfunded = (s.rt as unknown as { removeUnfundedGifts(cart: unknown, signal: AbortSignal): Promise<unknown> }).removeUnfundedGifts.bind(s.rt);
    await removeUnfunded(await (await fetch("/cart.js")).json(), new AbortController().signal);
    expect(s.counts.change).toBe(0);
    expect(s.items().map((i) => i.key)).toEqual(expect.arrayContaining(["pick-free", "pick-charged"]));
  });

  it("lifts the suppression when the login context changes (a customer-gated gift may now be valid) and re-adds once", async () => {
    const s = shop({ shopifyFundsGift: false });
    await s.sync();
    await s.sync();
    expect(s.counts).toEqual({ add: 1, change: 1 });
    expect(s.gifts()).toBe(0);

    s.setFunds(true);
    s.config.customerId = 42;
    await s.sync();
    await s.sync();
    expect(s.counts).toEqual({ add: 2, change: 1 });
    expect(s.gifts()).toBe(1);
    expect(s.declined()).toEqual([]);
  });

  it("stops removing once the evaluation is superseded and suppresses only what it removed", async () => {
    const s = shop({ shopifyFundsGift: false, flag: false, rewards: 2 });
    await s.sync();
    const gifts = s.items().filter((i) => i.properties["_promo_engine_line_type"] === "gift");
    expect(gifts.length).toBe(2);
    const ctl = new AbortController();
    s.onChange(() => ctl.abort());
    const removeUnfunded = (s.rt as unknown as { removeUnfundedGifts(cart: unknown, signal: AbortSignal): Promise<unknown> }).removeUnfundedGifts.bind(s.rt);
    const before = s.counts.change;
    await removeUnfunded(await (await fetch("/cart.js")).json(), ctl.signal);
    expect(s.counts.change - before).toBe(1);
    const stored = JSON.parse(sessionStorage.getItem("promo_engine_unfunded_gifts") ?? "{}") as Record<string, string>;
    expect(Object.keys(stored)).toHaveLength(1);
  });

  it("does nothing when the per-shop flag is off: no removal, no suppression, no re-check", async () => {
    for (const flag of [false, null, undefined]) {
      const s = shop({ shopifyFundsGift: false, flag: flag as boolean | null });
      if (flag === undefined) delete s.config.removeUnfundedGifts;
      await s.sync();
      await s.sync();
      expect(s.gifts()).toBe(1);
      expect(s.counts).toEqual({ add: 1, change: 0 });
      expect(sessionStorage.getItem("promo_engine_unfunded_gifts")).toBeNull();
      vi.unstubAllGlobals();
    }
  });
});

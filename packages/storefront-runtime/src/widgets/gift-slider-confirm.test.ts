// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit, PromoEvents } from "../event-bus.js";
import type { GiftSliderPayload } from "../types.js";
import { initGiftSlider } from "./gift-slider.js";

const gift = (id: number, over = {}) => ({
  rewardId: "reward-1",
  offerVersion: 7,
  rewardMaxQuantity: 1,
  variantId: `gid://shopify/ProductVariant/${id}`,
  productId: "gid://shopify/Product/1",
  title: "T-Shirt",
  variantTitle: `Size ${id}`,
  imageUrl: null,
  originalPriceCents: 3000,
  discountedPriceCents: 0,
  isAvailable: true,
  isSelected: false,
  ...over,
});
const payload = (): GiftSliderPayload =>
  ({ offerId: "offer-1", title: "Gift", subtitle: null, maxSelectableCount: 1, alreadySelectedCount: 0, selectableGifts: [gift(11), gift(12)] }) as unknown as GiftSliderPayload;

let cartItems: Array<Record<string, unknown>>;
let adds: unknown[];

const tick = () => new Promise((r) => setTimeout(r, 30));
const dialog = () => document.querySelector("#pe-gift-slider-root dialog");
const confirm = () => document.querySelector<HTMLButtonElement>(".pe-btn-confirm")!;

async function open() {
  emit(PromoEvents.GiftSliderRequested, payload());
  await tick();
  await tick();
  document.querySelector<HTMLElement>(".pe-gift-card")?.click();
  await tick();
}

beforeEach(() => {
  cartItems = [];
  adds = [];
  sessionStorage.clear();
  (window as unknown as Record<string, unknown>).Shopify = { routes: { root: "/" } };
  (window as unknown as Record<string, unknown>).PromoEngine = { validateGiftOffer: async () => payload() };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/cart.js") || String(url).includes("/cart/change.js")) return new Response(JSON.stringify({ token: "t", items: cartItems, item_count: 0, total_price: 0, currency: "USD" }));
    if (String(url).includes("/cart/add.js")) {
      adds.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ items: [] }));
    }
    if (String(url).includes("/products/")) return new Response(JSON.stringify({ variants: [] }), { status: 404 });
    return new Response("{}");
  }));
});
afterEach(() => vi.unstubAllGlobals());

initGiftSlider("session");

describe("gift picker confirm", () => {
  it("closes after a pick even when the analytics hook throws, and cannot add a second gift", async () => {
    await open();
    expect(dialog()).not.toBeNull();
    (window as unknown as { Shopify: Record<string, unknown> }).Shopify.analytics = { publish: () => { throw new Error("pixel boom"); } };
    const button = confirm();
    button.click();
    button.click();
    await tick();
    await tick();
    expect(adds).toHaveLength(1);
    expect(dialog()).toBeNull();
  });

  it("does not add a second shirt when the legacy Cart Gift Tiers app already put one of this reward's variants in the cart", async () => {
    cartItems = [{ key: "legacy", variant_id: 12, product_id: 1, quantity: 1, properties: { __cart_gift_tier: "tier-1" } }];
    await open();
    const button = confirm();
    button.click();
    await tick();
    await tick();
    expect(document.querySelector(".pe-error, [role=alert]")?.textContent).toBeUndefined();
    expect(adds).toHaveLength(0);
    expect(dialog()).toBeNull();
  });
});

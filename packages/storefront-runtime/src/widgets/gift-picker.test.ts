// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit, PromoEvents } from "../event-bus.js";
import type { GiftSliderPayload, SelectableGift } from "../types.js";
import { chooseVariant, groupGifts, reserveProduct, toggleProduct, type PickerState } from "./gift-picker.js";
import { initGiftSlider } from "./gift-slider.js";

const variantGid = (id: number) => `gid://shopify/ProductVariant/${id}`;
const gift = (product: number, variant: number, over: Partial<SelectableGift> = {}): SelectableGift => ({
  rewardId: "reward-1",
  offerVersion: 7,
  rewardMaxQuantity: 1,
  variantId: variantGid(variant),
  productId: `gid://shopify/Product/${product}`,
  title: `Product ${product}`,
  variantTitle: `V${variant}`,
  imageUrl: null,
  originalPriceCents: 3000,
  discountedPriceCents: 0,
  isAvailable: true,
  isSelected: false,
  ...over,
});
const single = (product: number, variant: number, over: Partial<SelectableGift> = {}) => gift(product, variant, { variantTitle: null, ...over });
const payload = (selectableGifts: SelectableGift[], maxSelectableCount = 1): GiftSliderPayload =>
  ({ offerId: "offer-1", title: "Gift", subtitle: null, maxSelectableCount, alreadySelectedCount: selectableGifts.filter((g) => g.isSelected).length, currencyCode: "USD", selectableGifts }) as unknown as GiftSliderPayload;

let current: GiftSliderPayload;
let adds: Array<{ items: Array<{ id: number; properties: Record<string, string> }> }>;
const tick = () => new Promise((r) => setTimeout(r, 30));
const q = <T extends Element = HTMLButtonElement>(sel: string) => document.querySelector<T>(sel)!;
const all = (sel: string) => [...document.querySelectorAll<HTMLButtonElement>(sel)];
const cards = () => all(".pe-gift-card");
const chips = () => all(".pe-variant-chip");
const confirm = () => q(".pe-btn-confirm");

async function open(next: GiftSliderPayload) {
  current = next;
  emit(PromoEvents.GiftSliderRequested, next);
  await tick();
  await tick();
}
async function click(el: HTMLElement) {
  el.click();
  await tick();
}

beforeEach(() => {
  adds = [];
  sessionStorage.clear();
  (window as unknown as Record<string, unknown>).Shopify = { routes: { root: "/" } };
  (window as unknown as Record<string, unknown>).PromoEngine = { validateGiftOffer: async () => current };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/cart.js") || String(url).includes("/cart/change.js")) return new Response(JSON.stringify({ token: "t", items: [], item_count: 0, total_price: 0, currency: "USD" }));
    if (String(url).includes("/cart/add.js")) {
      adds.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ items: [] }));
    }
    if (String(url).includes("/products/")) return new Response("{}", { status: 404 });
    return new Response("{}");
  }));
});
afterEach(async () => {
  document.querySelector<HTMLElement>("[data-promo-gift-close]")?.click();
  await tick();
  vi.unstubAllGlobals();
});

initGiftSlider("session");

describe("pick rules", () => {
  const empty = (): PickerState => ({ selected: new Set(), pending: new Set() });
  const key = (variant: number) => `reward-1:${variantGid(variant)}`;

  it("groups variants by product within a reward", () => {
    const groups = groupGifts([gift(1, 11), gift(1, 12), gift(2, 21)]);
    expect(groups.map((g) => g.gifts.length)).toEqual([2, 1]);
  });

  it("counts products, not variants, against the limit", () => {
    const groups = groupGifts([gift(1, 11, { rewardMaxQuantity: 2 }), gift(1, 12, { rewardMaxQuantity: 2 }), gift(2, 21, { rewardMaxQuantity: 2 }), gift(3, 31, { rewardMaxQuantity: 2 })]);
    let state: PickerState | null = reserveProduct(empty(), groups[0]!, groups, 2);
    state = chooseVariant(state!, groups[0]!, groups[0]!.gifts[1]!, groups, 2);
    expect([...state!.selected]).toEqual([key(12)]);
    state = reserveProduct(state!, groups[1]!, groups, 2);
    expect(state!.pending.size).toBe(1);
    expect(reserveProduct(state!, groups[2]!, groups, 2)).toBeNull();
  });

  it("replaces the product's variant instead of adding a second one", () => {
    const groups = groupGifts([gift(1, 11), gift(1, 12), gift(2, 21)]);
    const state = chooseVariant({ selected: new Set([key(11)]), pending: new Set() }, groups[0]!, groups[0]!.gifts[1]!, groups, 5)!;
    expect([...state.selected]).toEqual([key(12)]);
  });

  it("a single-choice modal swaps products", () => {
    const groups = groupGifts([single(1, 11), single(2, 21)]);
    const first = toggleProduct(empty(), groups[0]!, groups, 1)!;
    const second = toggleProduct(first, groups[1]!, groups, 1)!;
    expect([...second.selected]).toEqual([key(21)]);
  });

  it("refuses a sold-out variant", () => {
    const groups = groupGifts([gift(1, 11), gift(1, 12)]);
    expect(chooseVariant(empty(), groups[0]!, groups[0]!.gifts[0]!, groups, 2, new Set([variantGid(11)]))).toBeNull();
  });
});

describe("gift modal layouts", () => {
  it("shows one card per variant when every choice belongs to one product", async () => {
    await open(payload([gift(1, 11), gift(1, 12), gift(1, 13)]));
    expect(cards()).toHaveLength(3);
    expect(document.querySelector(".pe-product")).toBeNull();
    await click(cards()[1]!);
    expect(cards()[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(confirm().disabled).toBe(false);
  });

  it("shows one card per product when the choices span several products", async () => {
    await open(payload([gift(1, 11), gift(1, 12), gift(2, 21), single(3, 31)], 2));
    expect(cards()).toHaveLength(3);
    expect(cards().map((c) => c.querySelector(".pe-gift-name")!.textContent)).toEqual(["Product 1", "Product 2", "Product 3"]);
    expect(q(".pe-gift-card .pe-gift-free").textContent).toBe("Free");
    expect(chips()).toHaveLength(0);
  });

  it("selects a product without variants with one click", async () => {
    await open(payload([gift(1, 11), single(2, 21)]));
    await click(cards()[1]!);
    expect(cards()[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(confirm().disabled).toBe(false);
  });

  it("opens the variant chooser, keeps Confirm disabled until a variant is chosen, then adds that variant", async () => {
    await open(payload([gift(1, 11, { rewardMaxQuantity: 2 }), gift(1, 12, { rewardMaxQuantity: 2 }), single(2, 21, { rewardMaxQuantity: 2 })], 2));
    await click(cards()[0]!);
    expect(cards()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(chips().map((c) => c.textContent)).toEqual(["V11", "V12"]);
    expect(confirm().disabled).toBe(true);
    expect(q(".pe-selected-count").textContent).toContain("1 / 2");

    await click(cards()[1]!);
    expect(confirm().disabled).toBe(true);

    await click(chips()[1]!);
    expect(chips()).toHaveLength(0);
    expect(cards()[0]!.querySelector(".pe-gift-variant")!.textContent).toBe("V12");
    expect(confirm().disabled).toBe(false);
  });

  it("enables Confirm once every picked product has a variant and sends the chosen variants", async () => {
    await open(payload([gift(1, 11, { rewardMaxQuantity: 2 }), gift(1, 12, { rewardMaxQuantity: 2 }), single(2, 21, { rewardMaxQuantity: 2 })], 2));
    await click(cards()[0]!);
    await click(chips()[1]!);
    await click(cards()[1]!);
    expect(confirm().disabled).toBe(false);
    await click(confirm());
    await tick();
    expect(adds).toHaveLength(1);
    expect(adds[0]!.items.map((i) => i.id).sort()).toEqual([12, 21]);
    expect(adds[0]!.items.every((i) => i.properties["_promo_engine_reward_id"] === "reward-1" && i.properties["_promo_engine_offer_version"] === "7")).toBe(true);
    expect(document.querySelector("#pe-gift-slider-root dialog")).toBeNull();
  });

  it("stops at the limit and ignores further products", async () => {
    await open(payload([single(1, 11, { rewardMaxQuantity: 2 }), single(2, 21, { rewardMaxQuantity: 2 }), single(3, 31, { rewardMaxQuantity: 2 })], 2));
    await click(cards()[0]!);
    await click(cards()[1]!);
    await click(cards()[2]!);
    expect(cards().map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "true", "false"]);
  });

  it("reserving a product for a variant counts toward the limit", async () => {
    await open(payload([gift(1, 11, { rewardMaxQuantity: 2 }), gift(1, 12, { rewardMaxQuantity: 2 }), single(2, 21, { rewardMaxQuantity: 2 }), single(3, 31, { rewardMaxQuantity: 2 })], 2));
    await click(cards()[0]!);
    await click(cards()[1]!);
    await click(cards()[2]!);
    expect(cards().map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "true", "false"]);
  });

  it("disables a product whose variants are all sold out and a single sold-out variant", async () => {
    await open(payload([gift(1, 11, { isAvailable: false }), gift(1, 12, { isAvailable: false }), gift(2, 21), gift(2, 22, { isAvailable: false })]));
    expect(cards()[0]!.disabled).toBe(true);
    expect(cards()[0]!.textContent).toContain("Sold out");
    expect(cards()[1]!.disabled).toBe(false);
    await click(cards()[1]!);
    expect(chips().map((c) => c.disabled)).toEqual([false, true]);
    await click(chips()[1]!);
    expect(confirm().disabled).toBe(true);
    await click(chips()[0]!);
    expect(confirm().disabled).toBe(false);
  });

  it("shows current picks when the modal is reopened", async () => {
    const picks = payload([gift(1, 11, { isSelected: true }), gift(1, 12), single(2, 21)]);
    await open(picks);
    expect(cards()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(cards()[0]!.querySelector(".pe-gift-variant")!.textContent).toBe("V11");
    expect(cards()[1]!.getAttribute("aria-pressed")).toBe("false");
    await click(cards()[0]!);
    expect(chips().map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  it("works for several one-product rewards with quantity 1 each", async () => {
    await open(payload([gift(1, 11, { rewardId: "a" }), gift(1, 12, { rewardId: "a" }), gift(2, 21, { rewardId: "b" }), gift(2, 22, { rewardId: "b" })], 2));
    await click(cards()[0]!);
    await click(chips()[0]!);
    await click(cards()[1]!);
    await click(chips()[1]!);
    expect(confirm().disabled).toBe(false);
    await click(confirm());
    await tick();
    expect(adds[0]!.items.map((i) => [i.id, i.properties["_promo_engine_reward_id"]]).sort()).toEqual([[11, "a"], [22, "b"]]);
  });
});

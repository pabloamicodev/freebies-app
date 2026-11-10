import { afterEach, describe, expect, it, vi } from "vitest";
import type { CartData } from "./cart-adapter.js";
import { cartFingerprint, loadUnfundedSuppressions, saveUnfundedSuppressions, unfundedGiftKeys } from "./unfunded-gifts.js";

type Line = Record<string, unknown>;
const gift = (key: string, orig?: number, fin?: number, reward = "r1"): Line => ({
  key,
  variant_id: 9,
  quantity: 1,
  properties: { _promo_engine_line_type: "gift", _promo_engine_offer_id: "o", _promo_engine_reward_id: reward },
  ...(orig === undefined ? {} : { original_line_price: orig }),
  ...(fin === undefined ? {} : { final_line_price: fin }),
});
const paid = (key: string, variant: number, quantity: number): Line => ({ key, variant_id: variant, quantity, properties: null, original_line_price: 100, final_line_price: 100 });
const cart = (items: Line[], extra: Partial<CartData> = {}) => ({ items, currency: "USD", ...extra }) as unknown as CartData;

afterEach(() => vi.unstubAllGlobals());

describe("unfundedGiftKeys", () => {
  it("flags a reward whose every line is charged in full", () => {
    expect([...unfundedGiftKeys(cart([gift("a", 1499, 1499)]))]).toEqual(["o:r1"]);
  });
  it("does not flag a reward when any of its lines is discounted (picker overflow)", () => {
    expect(unfundedGiftKeys(cart([gift("a", 1499, 0), gift("b", 1499, 1499)])).size).toBe(0);
  });
  it("never flags with missing price fields or a zero original", () => {
    expect(unfundedGiftKeys(cart([gift("a")])).size).toBe(0);
    expect(unfundedGiftKeys(cart([gift("a", 1499)])).size).toBe(0);
    expect(unfundedGiftKeys(cart([gift("a", undefined, 1499)])).size).toBe(0);
    expect(unfundedGiftKeys(cart([gift("a", 0, 0)])).size).toBe(0);
  });
  it("ignores untagged and non-gift lines", () => {
    const partial = { key: "x", variant_id: 1, quantity: 1, properties: { _promo_engine_line_type: "gift" }, original_line_price: 5, final_line_price: 5 };
    expect(unfundedGiftKeys(cart([paid("p", 1, 1), partial])).size).toBe(0);
  });
});

describe("cartFingerprint", () => {
  it("is order-insensitive and ignores gift lines and prices", () => {
    const a = cartFingerprint(cart([paid("1", 1, 2), paid("2", 3, 1), gift("g", 5, 5)]));
    const b = cartFingerprint(cart([{ ...paid("2", 3, 1), final_line_price: 1 }, paid("1", 1, 2)]));
    expect(a).toBe(b);
    expect(cartFingerprint(cart([paid("1", 1, 3), paid("2", 3, 1)]))).not.toBe(a);
  });
  it("includes only applicable codes and the currency", () => {
    const items = [paid("1", 1, 1)];
    const codes = [{ code: "B", applicable: true }, { code: "A", applicable: true }, { code: "X", applicable: false }];
    const withCodes = cartFingerprint(cart(items, { discount_codes: codes } as Partial<CartData>));
    expect(withCodes).toContain("A,B");
    expect(withCodes).not.toContain("X");
    expect(cartFingerprint(cart(items, { currency: "EUR" }))).not.toBe(cartFingerprint(cart(items)));
  });
});

describe("cartFingerprint context", () => {
  it("changes with the login/market context so a login lifts a suppression", () => {
    const items = [paid("1", 1, 1)];
    expect(cartFingerprint(cart(items), "42,,")).not.toBe(cartFingerprint(cart(items), ",,"));
    expect(cartFingerprint(cart(items), "42,,")).toBe(cartFingerprint(cart(items), "42,,"));
  });
});

describe("suppression storage", () => {
  it("round-trips and caps the entries", () => {
    const m = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    saveUnfundedSuppressions(Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, "f"])));
    const loaded = loadUnfundedSuppressions();
    expect(Object.keys(loaded)).toHaveLength(200);
    expect(loaded["k249"]).toBe("f");
  });
  it("degrades gracefully when sessionStorage throws", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(() => saveUnfundedSuppressions({ a: "b" })).not.toThrow();
    expect(loadUnfundedSuppressions()).toEqual({});
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { giftRewardKey, loadDeclinedGiftRewards, saveDeclinedGiftRewards } from "./declined-gifts.js";

describe("declined-gifts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips through sessionStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });

    expect(loadDeclinedGiftRewards().size).toBe(0);

    const rewards = new Set([giftRewardKey("offer-1", "reward-1")]);
    saveDeclinedGiftRewards(rewards);

    expect([...loadDeclinedGiftRewards()]).toEqual(["offer-1:reward-1"]);
  });

  it("degrades gracefully with no sessionStorage available", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(loadDeclinedGiftRewards()).toEqual(new Set());
    expect(() => saveDeclinedGiftRewards(new Set(["a:b"]))).not.toThrow();
  });

  it("caps how many entries are retained", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });

    const many = new Set(Array.from({ length: 250 }, (_, i) => `offer-${i}:reward-${i}`));
    saveDeclinedGiftRewards(many);
    expect(loadDeclinedGiftRewards().size).toBe(200);
  });
});

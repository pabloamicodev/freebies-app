import { describe, expect, it } from "vitest";
import type { NormalizedCart } from "@promo/shared-types";
import { parseVolumeDiscountTiers, withVolumeDiscountTiers } from "./volume-discount-tiers.server.js";

const line = (productId: string, tiers?: { qty: number; percent: number }[]) =>
  ({ key: productId, productId, volumeDiscountTiers: tiers }) as unknown as NormalizedCart["lines"][number];
const cart = (lines: NormalizedCart["lines"]) => ({ lines }) as NormalizedCart;
const dbWith = (rows: { productGid: string; tiers: string | null }[]) =>
  ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as never;

describe("parseVolumeDiscountTiers", () => {
  it("accepts a JSON string and drops invalid tiers like the legacy Function", () => {
    expect(
      parseVolumeDiscountTiers(
        JSON.stringify([{ qty: 2, percent: 10 }, { qty: 0, percent: 5 }, { qty: 3, percent: -1 }, { qty: 1.5, percent: 5 }, null]),
      ),
    ).toEqual([{ qty: 2, percent: 10 }]);
    expect(parseVolumeDiscountTiers("not json")).toEqual([]);
    expect(parseVolumeDiscountTiers({ qty: 2 })).toEqual([]);
  });
});

describe("withVolumeDiscountTiers", () => {
  it("overwrites client-supplied tiers with the catalog's", async () => {
    const out = await withVolumeDiscountTiers(
      dbWith([{ productGid: "p1", tiers: JSON.stringify([{ qty: 2, percent: 10 }]) }]),
      "shop",
      cart([line("p1", [{ qty: 1, percent: 99 }]), line("p2", [{ qty: 1, percent: 99 }])]),
      true,
    );
    expect(out.lines[0]!.volumeDiscountTiers).toEqual([{ qty: 2, percent: 10 }]);
    expect(out.lines[1]!.volumeDiscountTiers).toBeUndefined();
  });

  it("only strips client tiers (no query) when no offer needs them", async () => {
    const db = { select: () => { throw new Error("must not query"); } } as never;
    const out = await withVolumeDiscountTiers(db, "shop", cart([line("p1", [{ qty: 1, percent: 99 }])]), false);
    expect(out.lines[0]!.volumeDiscountTiers).toBeUndefined();
  });
});

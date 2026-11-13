import { describe, expect, it } from "vitest";
import type { OfferReward } from "@promo/db";
import { planOrderToProductConversion } from "./order-to-product-discount.js";

const reward = (over: Partial<OfferReward>): OfferReward =>
  ({
    id: "r1",
    rewardType: "order_discount",
    discountType: "percentage",
    value: { amount: 15 },
    target: {},
    ...over,
  }) as OfferReward;

describe("planOrderToProductConversion", () => {
  it("turns a percentage order reward into a sitewide product reward with the same value", () => {
    const plan = planOrderToProductConversion([reward({})]);
    expect(plan).toEqual({
      ok: true,
      conversions: [
        expect.objectContaining({
          rewardId: "r1",
          after: {
            rewardType: "product_discount",
            discountType: "percentage",
            value: { amount: 15 },
            target: { scope: "cart", scopeMode: "sitewide", subscriptionMode: "any" },
          },
        }),
      ],
    });
  });

  it("keeps a subscription restriction", () => {
    const plan = planOrderToProductConversion([reward({ target: { subscriptionMode: "one_time_only" } })]);
    expect(plan.ok && plan.conversions[0]?.after.target).toMatchObject({ subscriptionMode: "one_time_only" });
  });

  it("leaves other reward types alone", () => {
    const plan = planOrderToProductConversion([reward({}), reward({ id: "g", rewardType: "product_gift" })]);
    expect(plan.ok && plan.conversions.map((c) => c.rewardId)).toEqual(["r1"]);
  });

  it.each([
    ["fixed amount", reward({ discountType: "fixed_amount" })],
    ["free", reward({ discountType: "free" })],
    ["no amount", reward({ value: {} })],
    ["over 100", reward({ value: { amount: 150 } })],
    ["tiers", reward({ value: { amount: 10, tiers: [{ discountType: "percentage", discountValue: 20, minimumQuantity: 2 }] } })],
  ])("refuses %s", (_name, row) => {
    expect(planOrderToProductConversion([row]).ok).toBe(false);
  });

  it("refuses an offer without order rewards", () => {
    expect(planOrderToProductConversion([reward({ rewardType: "product_gift" })]).ok).toBe(false);
  });
});

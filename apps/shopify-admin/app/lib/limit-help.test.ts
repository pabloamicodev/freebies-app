import { describe, expect, it } from "vitest";
import { MAX_LIMIT, hasWriteCustomersScope, limitHelp, parseLimit } from "./limit-help.js";

describe("limitHelp", () => {
  it("describes a gift set for gift offers", () => {
    const h = limitHelp("gift", ["product_gift"]);
    expect(h.showPerCart).toBe(true);
    expect(h.perCart).toMatch(/one gift set/);
  });
  it("describes a bundle for bundle rewards", () => {
    expect(limitHelp("bundle", ["bundle_discount"]).perCart).toMatch(/one bundle/);
  });
  it("describes a discounted unit for product discounts", () => {
    expect(limitHelp("discount", ["product_discount"]).perCart).toMatch(/one discounted unit/);
    expect(limitHelp("upsell", ["upsell_discount"]).perCart).toMatch(/one discounted unit/);
  });
  it("hides per cart for order and shipping only offers (DL5)", () => {
    for (const types of [["order_discount"], ["shipping_discount"], ["order_discount", "shipping_discount"]]) {
      const h = limitHelp("discount", types);
      expect(h.showPerCart).toBe(false);
      expect(h.perCart).toMatch(/once per order/);
    }
  });
  it("keeps per cart when an order reward is mixed with a product reward", () => {
    expect(limitHelp("discount", ["order_discount", "product_discount"]).showPerCart).toBe(true);
  });
  it("explains one customer application as one paid order", () => {
    expect(limitHelp("gift", ["product_gift"]).perCustomer).toMatch(/one paid order/);
  });
});

describe("parseLimit", () => {
  it("handles blank, valid and invalid", () => {
    expect(parseLimit(null)).toBeUndefined();
    expect(parseLimit("  ")).toBeUndefined();
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
    for (const bad of ["0", "-1", String(MAX_LIMIT + 1), "1.5", "1e3", "x"]) expect(parseLimit(bad)).toBeNull();
  });
});

describe("hasWriteCustomersScope", () => {
  it("matches the exact scope only", () => {
    expect(hasWriteCustomersScope("read_customers, write_customers")).toBe(true);
    expect(hasWriteCustomersScope("read_customers")).toBe(false);
    expect(hasWriteCustomersScope(null)).toBe(false);
  });
});

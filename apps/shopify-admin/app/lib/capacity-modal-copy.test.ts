import { describe, expect, it } from "vitest";
import { CAPACITY_MODAL_CODES, combinationOptOutWarning, describeCapacityModal, isCapacityModalCode, productDiscountsField, type CapacityModalData } from "./capacity-modal-copy.js";
import { limitsBanner, limitsLevel } from "./capacity-meter.js";

const offers = [{ id: "o1", name: "Spring gift" }, { id: "o2", name: "VIP shipping" }];
const data = (over: Partial<CapacityModalData>): CapacityModalData => ({ code: "SLOT_FULL", offers, numbers: {}, ...over });

describe("describeCapacityModal", () => {
  it("AUTOMATIC_DISCOUNT_LIMIT names the 25 limit, the counts and the review link", () => {
    const copy = describeCapacityModal(data({ code: "AUTOMATIC_DISCOUNT_LIMIT", numbers: { needed: 2, storeActive: 24, others: 20 }, discountsUrl: "https://x.myshopify.com/admin/discounts" }));
    expect(copy.title).toBe("Shopify's automatic discount limit is reached");
    expect(copy.limit).toContain("25 active automatic discounts");
    expect(copy.body).toContain("needs 2 more automatic discounts");
    expect(copy.body).toContain("24 of 25 active (20 from other apps or Shopify)");
    expect(copy.fix).toContain("Deactivate an automatic discount");
    expect(copy.actions).toEqual([{ kind: "external", label: "Review automatic discounts", href: "https://x.myshopify.com/admin/discounts" }]);
  });

  it("AUTOMATIC_DISCOUNT_LIMIT without a known count falls back to the unknown-count copy", () => {
    const copy = describeCapacityModal(data({ code: "AUTOMATIC_DISCOUNT_LIMIT", numbers: { needed: 1 } }));
    expect(copy.body).toContain("couldn't read how many automatic discounts");
    expect(copy.actions).toEqual([]);
  });

  it("OFFER_TOO_LARGE distinguishes size, cart attributes and customer tags", () => {
    const bytes = describeCapacityModal(data({ code: "OFFER_TOO_LARGE", offers: [offers[0]!], numbers: { bytes: 12000, slotBytes: 9500 } }));
    expect(bytes.title).toBe("This offer has too many items for one Shopify discount");
    expect(bytes.limit).toContain("9,500 bytes");
    expect(bytes.body).toContain('"Spring gift"');
    const keys = describeCapacityModal(data({ code: "OFFER_TOO_LARGE", offers: [offers[0]!], numbers: { keys: 5, maxKeys: 3 } }));
    expect(keys.title).toBe("This offer reads too many cart attributes");
    expect(keys.body).toContain("Remove 2 cart attribute conditions");
    const tags = describeCapacityModal(data({ code: "OFFER_TOO_LARGE", offers: [offers[0]!], numbers: { tags: 150, maxTags: 100 } }));
    expect(tags.title).toBe("This offer references too many customer tags");
    expect(tags.limit).toContain("100 customer tags");
  });

  it("SLOT0_GROUP_TOO_LARGE lists the offers and links each one (max 3)", () => {
    const many = ["a", "b", "c", "d"].map((id) => ({ id, name: `Offer ${id}` }));
    const copy = describeCapacityModal(data({ code: "SLOT0_GROUP_TOO_LARGE", offers: many, numbers: { groupUnits: 4 } }));
    expect(copy.title).toBe("Offers that stop lower-priority offers are too large together");
    expect(copy.body).toContain("4 offers");
    expect(copy.actions).toHaveLength(3);
    expect(copy.actions[0]).toEqual({ kind: "offer", label: "Open Offer a", to: "/app/offers/a" });
  });

  it("SLOT_FULL names the per-discount size limit", () => {
    const copy = describeCapacityModal(data({ code: "SLOT_FULL", numbers: { neededBytes: 11000, slotBytes: 9500 } }));
    expect(copy.limit).toContain("9,500 bytes");
    expect(copy.body).toContain("11000B");
    expect(copy.body).toContain('"Spring gift", "VIP shipping"');
  });

  it("COMBINATION_SINGLE_SHARD names the combination policy and links to the combination tab", () => {
    const copy = describeCapacityModal(data({ code: "COMBINATION_SINGLE_SHARD", numbers: { slotBytes: 9500, offersBlocking: 2 } }));
    expect(copy.title).toBe("Discount combinations limit how many offers can run");
    expect(copy.fix).toContain("combine with product discounts");
    expect(copy.actions[1]).toEqual({ kind: "offer", label: "Open VIP shipping", to: "/app/offers/o2/combination" });
  });

  it("every modal code renders copy for all four parts", () => {
    for (const code of CAPACITY_MODAL_CODES) {
      const copy = describeCapacityModal(data({ code, numbers: { needed: 1, storeActive: 25 } }));
      expect([copy.title, copy.limit, copy.body, copy.fix].every((part) => part.length > 10)).toBe(true);
    }
    expect(isCapacityModalCode("COMPILE_ERROR")).toBe(false);
  });
});

describe("productDiscountsField (wizard default)", () => {
  it("flag on: shown for every template and checked by default", () => {
    for (const template of ["volume", "cheapest_item", "cart"]) {
      expect(productDiscountsField(template, true)).toEqual({ visible: true, checked: true });
    }
  });
  it("flag off: today's behaviour, hidden (saves as not combining) except for cart discounts", () => {
    expect(productDiscountsField("volume", false)).toEqual({ visible: false, checked: false });
    expect(productDiscountsField("cheapest_item", false)).toEqual({ visible: false, checked: false });
    expect(productDiscountsField("cart", false)).toEqual({ visible: true, checked: true });
  });
  it("the opt-out note explains the single-discount consequence", () => {
    expect(combinationOptOutWarning).toContain("force all offers into one Shopify discount");
  });
});

describe("limits meter", () => {
  it("levels follow 80% and 100% of 25", () => {
    expect([null, 0, 19, 20, 24, 25].map(limitsLevel)).toEqual(["unknown", "ok", "ok", "warning", "warning", "critical"]);
  });
  it("only warning and critical show a banner", () => {
    expect(limitsBanner({ level: "ok", storeActive: 5, limit: 25 })).toBeNull();
    expect(limitsBanner({ level: "unknown", storeActive: null, limit: 25 })).toBeNull();
    expect(limitsBanner({ level: "warning", storeActive: 21, limit: 25 })?.title).toBe("Your store is close to Shopify's automatic discount limit");
    expect(limitsBanner({ level: "critical", storeActive: 25, limit: 25 })?.title).toBe("Shopify's automatic discount limit is reached");
  });
});

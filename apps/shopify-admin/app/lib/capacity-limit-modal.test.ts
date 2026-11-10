import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CapacityLimitModal } from "../components/CapacityLimitModal.js";
import { ShopifyLimitsBanner, ShopifyLimitsCard } from "../components/ShopifyLimits.js";
import { CAPACITY_MODAL_CODES, type CapacityModalData } from "./capacity-modal-copy.js";
import type { LimitsMeter } from "./capacity-meter.js";

const render = (data: CapacityModalData | null) =>
  renderToStaticMarkup(createElement(StaticRouter, { location: "/app" }, createElement(CapacityLimitModal, { data })));

const sample = (code: CapacityModalData["code"]): CapacityModalData => ({
  code,
  offers: [{ id: "o1", name: "Spring gift" }],
  numbers: { needed: 1, storeActive: 25, others: 22, slotBytes: 9500, bytes: 12000 },
  discountsUrl: "https://x.myshopify.com/admin/discounts",
});

describe("CapacityLimitModal", () => {
  it("renders nothing without data", () => {
    expect(render(null)).toBe("");
  });

  it.each(CAPACITY_MODAL_CODES)("%s renders an accessible dialog naming the limit, the offers and the fix", (code) => {
    const html = render(sample(code));
    expect(html).toMatch(/<dialog[^>]*aria-label="[^"]+"/);
    expect(html).toContain("Shopify limit");
    expect(html).toContain("What happened");
    expect(html).toContain("What to do");
    expect(html).toContain("Spring gift");
    expect(html).toContain('<h2 class="b-modal-title">');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("Got it");
  });

  it("the automatic-limit state links to Shopify's discounts page", () => {
    const html = render(sample("AUTOMATIC_DISCOUNT_LIMIT"));
    expect(html).toContain('href="https://x.myshopify.com/admin/discounts"');
    expect(html).toContain("Review automatic discounts");
    expect(html).toContain("25 active automatic discounts");
  });

  it("the combination state links to the offer's combination tab", () => {
    expect(render(sample("COMBINATION_SINGLE_SHARD"))).toContain('href="/app/offers/o1/combination"');
  });
});

const meter = (over: Partial<LimitsMeter>): LimitsMeter => ({ limit: 25, storeActive: 9, ours: 3, others: 6, slotsInUse: 3, maxCartSlots: 11, shardsEnabled: true, level: "ok", ...over });

describe("Shopify limits (Diagnostics card and offers banner)", () => {
  it("the Diagnostics card always renders the meter with the counts", () => {
    const html = renderToStaticMarkup(createElement(ShopifyLimitsCard, { meter: meter({}) }));
    expect(html).toContain("Automatic discounts: 9 of 25 used. Promo Engine uses 3, other apps and Shopify discounts use 6.");
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="9"');
    expect(html).toContain("3 of 11 Shopify discounts in use");
  });
  it("the card says so when the count is unavailable", () => {
    expect(renderToStaticMarkup(createElement(ShopifyLimitsCard, { meter: null }))).toContain("couldn&#x27;t read your automatic discount count");
  });
  it("the banner stays hidden below 80% and shows from 80%", () => {
    expect(renderToStaticMarkup(createElement(ShopifyLimitsBanner, { meter: meter({}) }))).toBe("");
    const warn = renderToStaticMarkup(createElement(ShopifyLimitsBanner, { meter: meter({ storeActive: 21, level: "warning", discountsUrl: "https://x.myshopify.com/admin/discounts" }) }));
    expect(warn).toContain("close to Shopify&#x27;s automatic discount limit");
    expect(warn).toContain('role="status"');
    const crit = renderToStaticMarkup(createElement(ShopifyLimitsBanner, { meter: meter({ storeActive: 25, level: "critical" }) }));
    expect(crit).toContain('role="alert"');
  });
});

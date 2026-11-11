import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CapacityLimitModal } from "../components/CapacityLimitModal.js";
import { ShopifyLimitsBanner, ShopifyLimitsCard } from "../components/ShopifyLimits.js";
import { CAPACITY_MODAL_CODES, type CapacityModalData } from "./capacity-modal-copy.js";
import { deriveCombinationGroups, type CombinationGroupsView, type CombinationOfferRow, type LimitsMeter } from "./capacity-meter.js";

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

const groups = (over: Partial<CombinationGroupsView> = {}): CombinationGroupsView => ({
  nonCombining: [{ id: "n1", name: "Free gift" }, { id: "n2", name: "VIP gift" }],
  forced: [],
  combining: 30,
  nodes: 3,
  nonCombiningNodes: 1,
  ...over,
});
const withGroups = (over: Partial<LimitsMeter>) => meter({ domainsEnabled: true, combinationGroups: groups(), ...over });
const card = (props: Parameters<typeof ShopifyLimitsCard>[0]) => renderToStaticMarkup(createElement(StaticRouter, { location: "/app/diagnostics" }, createElement(ShopifyLimitsCard, props)));

describe("Diagnostics: Combination groups", () => {
  it("is absent when no offer opts out of combining", () => {
    expect(card({ meter: meter({ domainsEnabled: true, combinationGroups: null }) })).not.toContain("Combination groups");
  });

  it("W2 when split: the offers, the discounts and the forced offers with their reasons", () => {
    const html = card({
      meter: withGroups({
        combinationGroups: groups({
          forced: [
            { id: "f1", name: "Order tier", reason: "order_reward" },
            { id: "f2", name: "Low priority", reason: "stop_lower_priority" },
          ],
        }),
      }),
    });
    expect(html).toContain("Combination groups");
    expect(html).toContain("2 offers that don&#x27;t combine run in 1 Shopify discount.");
    expect(html).toContain("They no longer stack with your other 30 offers");
    expect(html).toContain("has an order reward");
    expect(html).toContain("is below a &#x27;Stop lower-priority offers&#x27; offer");
    expect(html).toContain('href="/app/offers/f1"');
  });

  it("with everything in one discount it says nothing changed yet, and offers to keep one discount", () => {
    const html = card({ meter: withGroups({ combinationGroups: groups({ nodes: 1, nonCombiningNodes: 1 }) }), onSetDomains: () => undefined });
    expect(html).toContain("All offers still fit in one Shopify discount");
    expect(html).toContain("Keep one discount");
  });

  it("with the setting off it explains the limit and offers the confirmation", () => {
    const html = card({ meter: withGroups({ domainsEnabled: false }), onSetDomains: () => undefined });
    expect(html).toContain("force every offer into one Shopify discount");
    expect(html).toContain("Let them run separately…");
    expect(html).not.toContain('role="dialog"');
  });

  it("W3: the confirmation is an accessible dialog with Allow and Keep one discount", () => {
    const html = card({ meter: withGroups({ domainsEnabled: false }), onSetDomains: () => undefined, initialConfirmOpen: true });
    expect(html).toMatch(/<dialog[^>]*aria-label="Let offers that don&#x27;t combine run separately\?"/);
    expect(html).toContain("Let offers that don&#x27;t combine run separately?");
    expect(html).toContain(">Allow<");
    expect(html).toContain(">Keep one discount<");
  });

  it("is read-only without a handler", () => {
    const html = card({ meter: withGroups({ domainsEnabled: false }) });
    expect(html).not.toContain("Let them run separately…");
  });
});

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

const row = (id: string, over: Partial<CombinationOfferRow> = {}): CombinationOfferRow => ({
  id,
  name: `Offer ${id}`,
  priority: 100,
  combinesWithProduct: true,
  combinesWithOrder: true,
  combinesWithShipping: true,
  stopLowerPriority: false,
  hasOrderReward: false,
  ...over,
});

describe("deriveCombinationGroups", () => {
  it("is null when every offer combines", () => {
    expect(deriveCombinationGroups([row("a"), row("b")], new Map([["a", 0], ["b", 0]]))).toBeNull();
  });

  it("counts the nodes holding offers that don't combine and names the combining offers stuck with them", () => {
    const offers = [
      row("nc", { combinesWithProduct: false }),
      row("order", { hasOrderReward: true }),
      row("stop", { stopLowerPriority: true, priority: 5 }),
      row("tail", { priority: 50 }),
      row("free"),
    ];
    const slots = new Map([["nc", 0], ["order", 0], ["stop", 0], ["tail", 0], ["free", 1]]);
    const view = deriveCombinationGroups(offers, slots)!;
    expect(view.nonCombining).toEqual([{ id: "nc", name: "Offer nc" }]);
    expect(view.nodes).toBe(2);
    expect(view.nonCombiningNodes).toBe(1);
    expect(view.combining).toBe(4);
    expect(view.forced).toEqual([
      { id: "order", name: "Offer order", reason: "order_reward" },
      { id: "stop", name: "Offer stop", reason: "stop_lower_priority" },
      { id: "tail", name: "Offer tail", reason: "stop_lower_priority" },
    ]);
  });

  it("lists no forced offers while everything is in one node", () => {
    const view = deriveCombinationGroups([row("nc", { combinesWithOrder: false }), row("a")], new Map([["nc", 0], ["a", 0]]))!;
    expect(view.nodes).toBe(1);
    expect(view.forced).toEqual([]);
  });
});

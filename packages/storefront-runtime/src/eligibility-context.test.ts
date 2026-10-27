// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeProspective } from "@promo/shared-types/page-stamps";
import { contextKey, currentStampContext, encodeContext } from "./eligibility-context.js";
import { recordUtmLanding, withPromoMetadata } from "./metadata-bridge.js";

const T = "page.landing-nektar";
const EXP = "clx9k2abcdef";
const HERO = `${T}/hero`;

const win = window as unknown as {
  __promoEngineConfig?: unknown;
  __ml?: { experiments: Record<string, { variantKey: string; mode: string }> };
  Shopify?: unknown;
};

beforeEach(() => {
  (Element.prototype as unknown as { checkVisibility: unknown }).checkVisibility = function (this: Element) {
    for (let el: Element | null = this; el; el = el.parentElement) if (getComputedStyle(el).display === "none") return false;
    return true;
  };
  localStorage.clear();
  document.body.innerHTML = "";
  delete win.__ml;
  delete win.Shopify;
  win.__promoEngineConfig = { template: T, stampTargets: { s: [HERO], t: [T], e: [EXP] } };
  history.replaceState(null, "", "/products/x?utm_source=tiktok&email=a%40b.co");
});

afterEach(() => {
  vi.useRealTimers();
});

const sectionHtml = (display: string) =>
  `<div id="shopify-section-template--123__hero" style="display:${display}"><div>content</div></div>`;

/** What withPromoMetadata writes onto a new line, minus the line's own properties. */
function written(): Record<string, string> {
  return JSON.parse(withPromoMetadata({})["_promo_engine_metadata"] ?? "{}");
}

describe("currentStampContext is exactly what a new line is stamped with", () => {
  const templates = [true, false];
  const sections = ["shown", "hidden", "remembered"] as const;
  const experiments = ["none", "inline", "redirect", "original"] as const;
  const landings = [true, false];
  const consents = ["allowed", "denied"] as const;

  for (const template of templates)
    for (const section of sections)
      for (const experiment of experiments)
        for (const landing of landings)
          for (const consent of consents) {
            it(`template=${template} section=${section} exp=${experiment} landing=${landing} consent=${consent}`, () => {
              win.__promoEngineConfig = { template: template ? T : "other", stampTargets: { s: [HERO], t: [T], e: [EXP] } };
              document.body.innerHTML = sectionHtml(section === "shown" ? "block" : "none");
              if (section === "remembered") localStorage.setItem("promo_engine_seen", JSON.stringify({ [`s:${HERO}`]: Date.now() + 3_600_000 }));
              if (experiment !== "none") win.__ml = { experiments: { [EXP]: { variantKey: "variant_a", mode: experiment } } };
              if (landing) recordUtmLanding("/pages/lp?utm_source=tiktok");
              win.Shopify = { customerPrivacy: { analyticsProcessingAllowed: () => consent === "allowed" } };

              const context = currentStampContext();
              expect(Object.entries(context).sort()).toEqual(Object.entries(written()).sort());
              expect(currentStampContext()).toEqual(context);
              expect(contextKey(context)).toBe(contextKey(written()));

              expect(context["_promo_page_url"]).toBe("/products/x?utm_source=tiktok");
              expect(context["_promo_landing_url"] !== undefined).toBe(landing);
              const wantsExperiment = experiment === "inline" || experiment === "redirect";
              expect(context["_promo_exp"]).toBe(wantsExperiment && consent === "allowed" ? `@${EXP}:variant_a` : undefined);
            });
          }
});

describe("contextKey", () => {
  it("is order independent and changes with any stamp", () => {
    expect(contextKey({ a: "1", b: "2" })).toBe(contextKey({ b: "2", a: "1" }));
    expect(contextKey({ a: "1", b: "2" })).not.toBe(contextKey({ a: "1", b: "3" }));
    expect(contextKey({})).toBe("");
  });

  it("changes when the engine assigns a test group", () => {
    const before = contextKey();
    win.__ml = { experiments: { [EXP]: { variantKey: "variant_a", mode: "inline" } } };
    expect(contextKey()).not.toBe(before);
  });
});

describe("encodeContext", () => {
  it("round-trips through the server whitelist", () => {
    const context = { _promo_page_url: "/pages/vip?code=ü&x=1+2", _promo_exp: `@${EXP}:variant_a` };
    const decoded = JSON.parse(Buffer.from(encodeContext(context), "base64url").toString("utf8"));
    expect(sanitizeProspective(decoded)).toEqual(context);
  });
});

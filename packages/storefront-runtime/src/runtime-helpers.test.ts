import { afterEach, describe, expect, it, vi } from "vitest";
import { expectedGiftKeys, hasOwnMarker, parseRetryAfter } from "./runtime-helpers.js";
import { OWN_REQUEST_HEADER } from "./cart-adapter.js";
import { escapeHtml } from "./html.js";
import { formatMoney, storefrontLocale } from "./format.js";
import { t } from "./i18n.js";
import { publishAnalytics } from "./event-bus.js";
import { isEditingWithin, isTextEntry } from "./dom-preserve.js";
import { trapTarget } from "./widgets/today-offer.js";

afterEach(() => vi.unstubAllGlobals());

describe("parseRetryAfter", () => {
  it("reads seconds and clamps to 1-30 s", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(1000);
    expect(parseRetryAfter("600")).toBe(30_000);
  });
  it("reads an HTTP date", () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    expect(parseRetryAfter("Fri, 02 Oct 2026 10:00:05 GMT", now)).toBe(5000);
  });
  it("returns null for missing or garbage values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("hasOwnMarker (per-request guard)", () => {
  it("detects the marker in plain, tuple and Headers init and in a Request", () => {
    expect(hasOwnMarker("/cart/add.js", { headers: { [OWN_REQUEST_HEADER.toLowerCase()]: "1" } })).toBe(true);
    expect(hasOwnMarker("/cart/add.js", { headers: [[OWN_REQUEST_HEADER, "1"]] })).toBe(true);
    expect(hasOwnMarker("/cart/add.js", { headers: new Headers({ [OWN_REQUEST_HEADER]: "1" }) })).toBe(true);
    expect(hasOwnMarker(new Request("https://s.example/cart/add.js", { headers: { [OWN_REQUEST_HEADER]: "1" } }))).toBe(true);
  });
  it("is false for a theme request, even while we are mid-flight", () => {
    expect(hasOwnMarker("/cart/add.js", { headers: { "Content-Type": "application/json" } })).toBe(false);
    expect(hasOwnMarker("/cart/add.js")).toBe(false);
  });
});

describe("expectedGiftKeys (declined-gift false positive)", () => {
  it("does not expect a gift whose add never succeeded", () => {
    expect([...expectedGiftKeys([], { added: new Set(), removed: new Set() })]).toEqual([]);
  });
  it("expects succeeded adds and drops succeeded removals", () => {
    const keys = expectedGiftKeys(["a:1", "b:2"], { added: new Set(["c:3"]), removed: new Set(["a:1"]) });
    expect([...keys].sort()).toEqual(["b:2", "c:3"]);
  });
});

describe("escapeHtml", () => {
  it("escapes quotes so attribute values cannot be broken out of", () => {
    expect(escapeHtml(`" onmouseover="alert(1)`)).toBe("&quot; onmouseover=&quot;alert(1)");
    expect(escapeHtml(`'><script>`)).toBe("&#39;&gt;&lt;script&gt;");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("formatMoney / storefrontLocale", () => {
  it("uses Shopify.locale, not the browser language", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("window", { Shopify: { locale: "de-DE" } });
    expect(storefrontLocale()).toBe("de-DE");
    expect(formatMoney(123456, "EUR")).toMatch(/1\.234,56\s?€/);
  });
  it("falls back to document lang, then navigator", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { documentElement: { lang: "fr-FR" } });
    expect(storefrontLocale()).toBe("fr-FR");
    vi.stubGlobal("document", { documentElement: { lang: "" } });
    expect(storefrontLocale()).toBe("en-US");
  });
  it("uses the active presentment currency when none is given, and survives bad input", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("window", { Shopify: { locale: "not a locale!!", currency: { active: "JPY", rate: "1" } } });
    expect(formatMoney(100)).toContain("¥1");
    expect(formatMoney(100, "ZZZZZ")).toBe("1.00 ZZZZZ");
  });
});

describe("t (widget strings)", () => {
  it("returns English defaults and interpolates", () => {
    vi.stubGlobal("window", {});
    expect(t("progress", { percent: 40 })).toBe("Progress: 40%");
    expect(t("bundleAdd", { title: "Mug" })).toBe("Add Mug");
  });
  it("uses the theme locale strings from the runtime config", () => {
    vi.stubGlobal("window", {
      __promoEngineConfig: { i18n: { progress: "Progreso: {{ percent }}%", close: "Cerrar" } },
    });
    expect(t("progress", { percent: 40 })).toBe("Progreso: 40%");
    expect(t("close")).toBe("Cerrar");
    expect(t("giftOffer")).toBe("View free gift offer");
  });
});

describe("publishAnalytics + Customer Privacy API", () => {
  it("does not publish when the shopper declined analytics", () => {
    const publish = vi.fn();
    vi.stubGlobal("window", { Shopify: { analytics: { publish }, customerPrivacy: { analyticsProcessingAllowed: () => false } } });
    publishAnalytics("promo_engine:x", {});
    expect(publish).not.toHaveBeenCalled();
  });
  it("publishes when allowed, or when the API is not present (Shopify's pixel gate applies)", () => {
    const publish = vi.fn();
    vi.stubGlobal("window", { Shopify: { analytics: { publish }, customerPrivacy: { analyticsProcessingAllowed: () => true } } });
    publishAnalytics("promo_engine:x", { a: 1 });
    vi.stubGlobal("window", { Shopify: { analytics: { publish } } });
    publishAnalytics("promo_engine:y", {});
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it("fails closed if the consent API throws", () => {
    const publish = vi.fn();
    vi.stubGlobal("window", {
      Shopify: {
        analytics: { publish },
        customerPrivacy: {
          analyticsProcessingAllowed: () => {
            throw new Error("boom");
          },
        },
      },
    });
    publishAnalytics("promo_engine:x", {});
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("isTextEntry / isEditingWithin", () => {
  const input = (type: string) => ({ tagName: "INPUT", type }) as unknown as Element;
  it("treats text-like fields as editing, buttons and checkboxes as not", () => {
    expect(isTextEntry(input("text"))).toBe(true);
    expect(isTextEntry(input("number"))).toBe(true);
    expect(isTextEntry({ tagName: "TEXTAREA" } as unknown as Element)).toBe(true);
    expect(isTextEntry(input("checkbox"))).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" } as unknown as Element)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
  it("only counts a field inside the section being replaced", () => {
    const active = input("text");
    expect(isEditingWithin({ contains: () => true } as unknown as Element, active)).toBe(true);
    expect(isEditingWithin({ contains: () => false } as unknown as Element, active)).toBe(false);
  });
});

describe("trapTarget (today-offer dialog focus trap)", () => {
  const a = { id: "a" } as unknown as HTMLElement;
  const b = { id: "b" } as unknown as HTMLElement;
  const panel = { querySelectorAll: () => [a, b] } as unknown as ParentNode;
  it("wraps forward from the last and backward from the first", () => {
    expect(trapTarget(panel, b, false)).toBe(a);
    expect(trapTarget(panel, a, true)).toBe(b);
  });
  it("pulls stray focus back inside and leaves in-between moves to the browser", () => {
    expect(trapTarget(panel, null, false)).toBe(a);
    expect(trapTarget(panel, {} as Element, true)).toBe(b);
    expect(trapTarget(panel, a, false)).toBeNull();
    expect(trapTarget({ querySelectorAll: () => [] } as unknown as ParentNode, null, false)).toBeNull();
  });
});

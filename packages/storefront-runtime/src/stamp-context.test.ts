// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPromoMetadata } from "./metadata-bridge.js";
import { browserStampContext } from "./stamp-context.js";

const T = "page.landing-nektar";
const EXP = "clx9k2abcdef";
const EXP2 = "clw1zzzzzzzz";
const HOUR = 3_600_000;

type Config = { template?: string; stampTargets?: { s?: string[]; t?: string[]; e?: string[] } | null };
const win = window as unknown as {
  __promoEngineConfig?: Config;
  __ml?: { experiments: Record<string, { variantKey: string | null; mode: string }> };
  Shopify?: unknown;
};

function configure(config: Config) {
  win.__promoEngineConfig = { template: T, ...config };
}

function section(key: string, inner: string, attrs = "") {
  return `<div id="shopify-section-template--123__${key}" class="shopify-section" ${attrs}>${inner}</div>`;
}

function mount(html: string) {
  document.body.innerHTML = html;
}

/** The engine writes window.__ml.experiments, then fires the event. */
function assign(experimentId: string, variantKey: string | null, mode = "inline") {
  win.__ml = win.__ml ?? { experiments: {} };
  win.__ml.experiments[experimentId] = { variantKey, mode };
  document.dispatchEvent(new CustomEvent("ml:experiment:assigned", { detail: { experimentId, variantKey, mode } }));
}

const memory = (): Record<string, number> => JSON.parse(localStorage.getItem("promo_engine_seen") ?? "{}");

function stamp() {
  return browserStampContext();
}

/** jsdom has no checkVisibility: model the spec for display, the hidden attribute and visibility. */
function fakeCheckVisibility(this: Element) {
  for (let el: Element | null = this; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.display === "none") return false;
  }
  return !["hidden", "collapse"].includes(getComputedStyle(this).visibility);
}

beforeEach(() => {
  vi.stubGlobal("requestIdleCallback", undefined);
  (Element.prototype as unknown as { checkVisibility: unknown }).checkVisibility = fakeCheckVisibility;
  localStorage.clear();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete win.__ml;
  delete win.Shopify;
  win.__promoEngineConfig = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (Element.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
});

describe("section visibility", () => {
  const ref = `${T}/hero_abc`;
  const stampedSections = () => stamp()?._promo_sections;
  beforeEach(() => configure({ stampTargets: { s: [ref] } }));

  it("stamps a section whose wrapper and a real child render", () => {
    mount(section("hero_abc", "<div>hero</div>"));
    expect(stampedSections()).toBe(`@${ref}`);
  });

  it("is hidden when the wrapper is display none", () => {
    mount(section("hero_abc", "<div>hero</div>", 'style="display:none"'));
    expect(stampedSections()).toBeUndefined();
  });

  it("is hidden when an ancestor is display none", () => {
    mount(`<div style="display:none">${section("hero_abc", "<div>hero</div>")}</div>`);
    expect(stampedSections()).toBeUndefined();
  });

  it("is hidden when the wrapper has the hidden attribute", () => {
    mount(section("hero_abc", "<div>hero</div>", "hidden"));
    expect(stampedSections()).toBeUndefined();
  });

  it("is hidden when the wrapper is visibility hidden", () => {
    mount(section("hero_abc", "<div>hero</div>", 'style="visibility:hidden"'));
    expect(stampedSections()).toBeUndefined();
  });

  it("is hidden when the only child is inside a template", () => {
    mount(section("hero_abc", "<template><div>hero</div></template>"));
    expect(stampedSections()).toBeUndefined();
  });

  it("ignores script, style, link, noscript and meta children", () => {
    mount(section("hero_abc", "<script></script><style></style><link rel='x'><noscript></noscript><meta name='x'>"));
    expect(stampedSections()).toBeUndefined();
  });

  it("Margin Labs inline swap: the inert arm is hidden, the arm placed before its template is shown", () => {
    const hidden = `${T}/hero_mlswap_v`;
    configure({ stampTargets: { s: [ref, hidden] } });
    mount(
      section("hero_abc", "<script>__mlOpen()</script><template data-ml-off><div>control</div></template>") +
        section("hero_mlswap_v", "<template data-ml-swap data-ml-arm><div>variant</div></template><script>__mlSwap()</script>"),
    );
    expect(stampedSections()).toBeUndefined();

    localStorage.clear();
    mount(
      section("hero_abc", "<script>__mlOpen()</script><template data-ml-off><div>control</div></template>") +
        section("hero_mlswap_v", "<div>variant</div><template data-ml-swap data-ml-arm></template><script>__mlSwap()</script>"),
    );
    expect(stampedSections()).toBe(`@${hidden}`);
  });

  it("Intelligems-style CSS hidden root child is hidden, an opacity 0 body is not", () => {
    mount(section("hero_abc", '<div class="ig-hidden">hero</div>'));
    document.head.innerHTML = "<style>.ig-hidden{display:none !important}</style>";
    expect(stampedSections()).toBeUndefined();

    localStorage.clear();
    document.head.innerHTML = "<style>body{opacity:0}</style>";
    expect(stampedSections()).toBe(`@${ref}`);
  });

  it("keeps a section shown when one child is hidden but another renders", () => {
    mount(section("hero_abc", '<div style="display:none">a</div><div>b</div>'));
    expect(stampedSections()).toBe(`@${ref}`);
  });

  it("falls back to getClientRects plus visibility when checkVisibility is missing", () => {
    delete (Element.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
    const rects = vi.spyOn(Element.prototype, "getClientRects");
    mount(section("hero_abc", "<div>hero</div>"));
    rects.mockReturnValue([{}] as unknown as DOMRectList);
    expect(stampedSections()).toBe(`@${ref}`);

    localStorage.clear();
    mount(section("hero_abc", '<div>hero</div>', 'style="visibility:hidden"'));
    expect(stampedSections()).toBeUndefined();

    mount(section("hero_abc", "<div>hero</div>"));
    rects.mockReturnValue([] as unknown as DOMRectList);
    expect(stampedSections()).toBeUndefined();
    rects.mockRestore();
  });

  it("derives the key from the DOM id and ignores other ids", () => {
    mount('<div id="shopify-section-header"><div>x</div></div>' + section("hero_abc", "<div>hero</div>"));
    expect(stampedSections()).toBe(`@${ref}`);
  });
});

describe("stamp targets", () => {
  it("stamps nothing when stampTargets is empty or absent", () => {
    mount(section("hero_abc", "<div>hero</div>"));
    configure({ stampTargets: { s: [], t: [], e: [] } });
    win.__ml = { experiments: { [EXP]: { variantKey: "variant_a", mode: "inline" } } };
    expect(stamp()).toBeNull();
    expect(withPromoMetadata({}, "/p", null)).toEqual({ _promo_page_url: "/p", _promo_engine_metadata: '{"_promo_page_url":"/p"}' });
    configure({ stampTargets: null });
    expect(stamp()).toBeNull();
    expect(localStorage.getItem("promo_engine_seen")).toBeNull();
  });

  it("stamps only listed targets", () => {
    configure({ stampTargets: { s: [`${T}/hero_abc`], t: ["product"], e: [EXP] } });
    mount(section("hero_abc", "<div>a</div>") + section("other", "<div>b</div>"));
    win.__ml = {
      experiments: {
        [EXP]: { variantKey: "variant_a", mode: "inline" },
        [EXP2]: { variantKey: "control", mode: "inline" },
      },
    };
    expect(stamp()).toEqual({ _promo_sections: `@${T}/hero_abc`, _promo_exp: `@${EXP}:variant_a` });
  });

  it("stamps the template when listed and skips it when not", () => {
    configure({ stampTargets: { t: [T] } });
    expect(stamp()).toEqual({ _promo_template: `@${T}` });
    configure({ stampTargets: { t: ["product"] } });
    expect(stamp()).toBeNull();
  });

  it("drops entries that break the experiment charsets", () => {
    configure({ stampTargets: { e: [EXP, "SHORT"] } });
    win.__ml = {
      experiments: {
        [EXP]: { variantKey: "bad key!", mode: "inline" },
        SHORT: { variantKey: "control", mode: "inline" },
      },
    };
    expect(stamp()).toBeNull();
  });
});

describe("withPromoMetadata", () => {
  it("writes the stamps flat and inside _promo_engine_metadata, next to the page URL", () => {
    configure({ stampTargets: { t: [T], s: [`${T}/hero_abc`] } });
    mount(section("hero_abc", "<div>hero</div>"));
    const props = withPromoMetadata({}, "/pages/nektar");
    expect(props).toMatchObject({
      _promo_page_url: "/pages/nektar",
      _promo_template: `@${T}`,
      _promo_sections: `@${T}/hero_abc`,
    });
    expect(JSON.parse(props._promo_engine_metadata!)).toEqual({
      _promo_page_url: "/pages/nektar",
      _promo_template: `@${T}`,
      _promo_sections: `@${T}/hero_abc`,
    });
  });

  it("never re-stamps existing lines (null context) and keeps keys already on the line", () => {
    configure({ stampTargets: { t: [T] } });
    expect(withPromoMetadata({ a: "1" }, null, null, null)).toEqual({
      a: "1",
      _promo_engine_metadata: '{"a":"1"}',
    });
    const packed = JSON.stringify({ _promo_template: "product" });
    const kept = withPromoMetadata({ _promo_engine_metadata: packed }, null, null);
    expect(JSON.parse(kept._promo_engine_metadata!)._promo_template).toBe("product");
    expect(withPromoMetadata({ _promo_template: "cart" }, null, null)._promo_template).toBe("cart");
  });
});

describe("caps", () => {
  it("keeps at most 8 sections, current page first, overflow dropped from the tail", () => {
    const refs = Array.from({ length: 12 }, (_, i) => `${T}/s${i}`);
    configure({ stampTargets: { s: refs } });
    mount(refs.map((r) => section(r.split("/")[1]!, "<div>x</div>")).join(""));
    const value = stamp()!._promo_sections!.split(",");
    expect(value).toHaveLength(8);
    expect(value).toEqual(refs.slice(0, 8).map((r) => `@${r}`));
  });

  it("caps the char length at 512 for sections", () => {
    const long = (i: number) => `${T}/${"k".repeat(95)}${i}`;
    const refs = Array.from({ length: 8 }, (_, i) => long(i));
    configure({ stampTargets: { s: refs } });
    mount(refs.map((r) => section(r.split("/")[1]!, "<div>x</div>")).join(""));
    const value = stamp()!._promo_sections!;
    expect(value.length).toBeLessThanOrEqual(512);
    expect(value.split(",").length).toBeLessThan(8);
  });

  it("caps experiments at 4 entries", () => {
    const ids = Array.from({ length: 6 }, (_, i) => `exp${i}abcdefgh`);
    configure({ stampTargets: { e: ids } });
    win.__ml = { experiments: Object.fromEntries(ids.map((id) => [id, { variantKey: "control", mode: "inline" }])) };
    expect(stamp()!._promo_exp!.split(",")).toHaveLength(4);
  });
});

describe("@ prefix versus session memory", () => {
  const hero = `${T}/hero_abc`;
  const other = "page.other/promo_1";

  it("remembers refs seen earlier without the @ prefix, current page first", () => {
    configure({ template: "page.other", stampTargets: { s: [hero, other], t: [T, "page.other"] } });
    mount(section("promo_1", "<div>x</div>"));
    expect(stamp()).toEqual({ _promo_template: "@page.other", _promo_sections: `@${other}` });

    configure({ stampTargets: { s: [hero, other], t: [T, "page.other"] } });
    mount(section("hero_abc", "<div>x</div>"));
    expect(stamp()).toEqual({
      _promo_template: `@${T},page.other`,
      _promo_sections: `@${hero},${other}`,
    });
  });

  it("does not duplicate a ref that is both current and remembered", () => {
    configure({ stampTargets: { t: [T] } });
    stamp();
    expect(stamp()).toEqual({ _promo_template: `@${T}` });
  });

  it("drops remembered refs that no live offer targets any more", () => {
    configure({ stampTargets: { t: ["product", T] } });
    stamp();
    configure({ template: "index", stampTargets: { t: [T] } });
    expect(stamp()).toEqual({ _promo_template: T });
  });

  it("snapshots on pagehide so a section seen on the previous page is inherited", () => {
    configure({ stampTargets: { s: [hero] } });
    mount(section("hero_abc", "<div>x</div>"));
    window.dispatchEvent(new Event("pagehide"));
    expect(memory()[`s:${hero}`]).toBeGreaterThan(Date.now());
    configure({ template: "cart", stampTargets: { s: [hero] } });
    mount("");
    expect(stamp()).toEqual({ _promo_sections: hero });
  });

  it("still stamps the current page when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    configure({ stampTargets: { t: [T] } });
    expect(stamp()).toEqual({ _promo_template: `@${T}` });
  });
});

describe("TTL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
  });

  it("slides 24 h from the last sighting", () => {
    configure({ stampTargets: { t: [T, "index"] } });
    stamp();
    configure({ template: "index", stampTargets: { t: [T, "index"] } });
    vi.advanceTimersByTime(20 * HOUR);
    expect(stamp()).toEqual({ _promo_template: `@index,${T}` });

    configure({ stampTargets: { t: [T, "index"] } });
    stamp();
    configure({ template: "index", stampTargets: { t: [T, "index"] } });
    vi.advanceTimersByTime(20 * HOUR);
    expect(stamp()).toEqual({ _promo_template: `@index,${T}` });
  });

  it("drops an entry once 24 h pass without a new sighting", () => {
    configure({ stampTargets: { t: [T] } });
    stamp();
    configure({ template: "index", stampTargets: { t: [T] } });
    vi.advanceTimersByTime(24 * HOUR + 1);
    expect(stamp()).toBeNull();
    expect(memory()).toEqual({});
  });
});

describe("experiments", () => {
  it("reads the assignment that happened before the runtime loaded (window.__ml)", () => {
    configure({ stampTargets: { e: [EXP] } });
    win.__ml = { experiments: { [EXP]: { variantKey: "variant_a", mode: "inline" } } };
    expect(stamp()).toEqual({ _promo_exp: `@${EXP}:variant_a` });
  });

  it("picks up the ml:experiment:assigned event fired after load (before DOMContentLoaded)", () => {
    configure({ stampTargets: { e: [EXP] } });
    expect(document.readyState).not.toBe("");
    expect(stamp()).toBeNull();
    assign(EXP, "variant_b", "redirect");
    expect(stamp()).toEqual({ _promo_exp: `@${EXP}:variant_b` });
  });

  it("ignores original mode and unlisted experiments", () => {
    configure({ stampTargets: { e: [EXP] } });
    assign(EXP, "control", "original");
    assign(EXP2, "control", "inline");
    expect(stamp()).toBeNull();
  });

  it("remembers the arm and replaces it when the same experiment lands on a new key", () => {
    configure({ stampTargets: { e: [EXP] } });
    assign(EXP, "variant_a");
    stamp();
    configure({ template: "cart", stampTargets: { e: [EXP] } });
    assign(EXP, null, "original");
    expect(stamp()).toBeNull();

    assign(EXP, "variant_a");
    configure({ template: "cart", stampTargets: { e: [EXP] } });
    assign(EXP, "variant_b");
    expect(stamp()).toEqual({ _promo_exp: `@${EXP}:variant_b` });
    expect(Object.keys(memory())).toEqual([`e:${EXP}:variant_b`]);
  });

  it("inherits an arm from an earlier page without the @ prefix when not re-announced", () => {
    const fresh = "fresh0abcdef";
    configure({ stampTargets: { e: [fresh] } });
    localStorage.setItem("promo_engine_seen", JSON.stringify({ [`e:${fresh}:variant_a`]: Date.now() + HOUR }));
    expect(stamp()).toEqual({ _promo_exp: `${fresh}:variant_a` });
  });
});

describe("consent purge", () => {
  beforeEach(() => {
    configure({ stampTargets: { e: [EXP], t: [T] } });
    localStorage.setItem("promo_engine_seen", JSON.stringify({ [`e:${EXP}:variant_a`]: Date.now() + HOUR }));
    win.__ml = { experiments: { [EXP]: { variantKey: "variant_a", mode: "inline" } } };
  });

  it("writes no _promo_exp and clears remembered arms when analytics processing is denied", () => {
    win.Shopify = { customerPrivacy: { analyticsProcessingAllowed: () => false } };
    expect(stamp()).toEqual({ _promo_template: `@${T}` });
    expect(Object.keys(memory()).filter((key) => key.startsWith("e:"))).toEqual([]);
  });

  it("purges on visitorConsentCollected with analytics withdrawn, keeping template memory", () => {
    stamp();
    expect(Object.keys(memory()).some((key) => key.startsWith("e:"))).toBe(true);
    document.dispatchEvent(new CustomEvent("visitorConsentCollected", { detail: { analyticsAllowed: false } }));
    expect(Object.keys(memory()).filter((key) => key.startsWith("e:"))).toEqual([]);
    expect(memory()[`t:${T}`]).toBeGreaterThan(Date.now());
    expect(stamp()).toEqual({ _promo_template: `@${T}` });
    document.dispatchEvent(new CustomEvent("visitorConsentCollected", { detail: { analyticsAllowed: true } }));
    expect(stamp()).toEqual({ _promo_template: `@${T}`, _promo_exp: `@${EXP}:variant_a` });
  });

  it("stamps the arm when analytics is allowed", () => {
    win.Shopify = { customerPrivacy: { analyticsProcessingAllowed: () => true } };
    expect(stamp()?._promo_exp).toBe(`@${EXP}:variant_a`);
  });
});

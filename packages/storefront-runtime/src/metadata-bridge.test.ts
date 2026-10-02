import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPromoMetadataBridge,
  needsPromoMetadataPacking,
  packCartAddRequest,
  packXhrBody,
  recordUtmLanding,
  rememberSpecificLinkParams,
  sanitizePageUrl,
  withPromoMetadata,
} from "./metadata-bridge.js";

describe("withPromoMetadata", () => {
  it("stamps and packs the originating storefront URL for checkout enforcement", () => {
    const properties = withPromoMetadata({}, "/pages/vip?utm_source=tt&email=a%40b.co");
    expect(properties._promo_page_url).toBe("/pages/vip?utm_source=tt");
    expect(JSON.parse(properties._promo_engine_metadata!)).toMatchObject({
      _promo_page_url: "/pages/vip?utm_source=tt",
    });
  });

  it("packs legacy and current promotion properties into one Function field", () => {
    const properties = withPromoMetadata({
      _promo_engine_line_type: "gift",
      _promo_engine_offer_id: "offer-1",
      __landing_source: "protein-lp",
      unrelated: "preserved",
    });

    expect(JSON.parse(properties._promo_engine_metadata!)).toEqual({
      _promo_engine_line_type: "gift",
      _promo_engine_offer_id: "offer-1",
      __landing_source: "protein-lp",
      unrelated: "preserved",
    });
    expect(properties.unrelated).toBe("preserved");
  });

  it("merges existing metadata and refreshes direct values", () => {
    const properties = withPromoMetadata({
      _promo_engine_metadata: JSON.stringify({ _quiz_bundle_id: "old", custom: "keep" }),
      _quiz_bundle_id: "new",
    });

    expect(JSON.parse(properties._promo_engine_metadata!)).toEqual({
      _quiz_bundle_id: "new",
      custom: "keep",
    });
  });

  it("packs custom properties so Function conditions are not limited by query slots", () => {
    const properties = withPromoMetadata({ engraving: "Ada" });
    expect(JSON.parse(properties._promo_engine_metadata!)).toEqual({ engraving: "Ada" });
  });

  it("detects legacy promotional properties that still need packing", () => {
    expect(
      needsPromoMetadataPacking({
        _promo_engine_offer_id: "offer-legacy",
        _promo_engine_reward_id: "reward-legacy",
      }),
    ).toBe(true);
    expect(
      needsPromoMetadataPacking(
        withPromoMetadata({
          _promo_engine_offer_id: "offer-current",
        }),
      ),
    ).toBe(false);
    expect(needsPromoMetadataPacking({ engraving: "Ada" })).toBe(true);
  });
});

describe("packCartAddRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stamps URL metadata on ordinary JSON cart lines that have no properties", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://store.example", pathname: "/pages/vip", search: "?code=summer" },
    });
    const [input, init] = await packCartAddRequest("/cart/add.js", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ id: 123, quantity: 1 }] }),
    });

    expect(input).toBe("/cart/add.js");
    const payload = JSON.parse(String(init?.body)) as {
      items: Array<{ properties: Record<string, string> }>;
    };
    expect(payload.items[0]!.properties._promo_page_url).toBe("/pages/vip");
    expect(JSON.parse(payload.items[0]!.properties._promo_engine_metadata!)).toMatchObject({
      _promo_page_url: "/pages/vip",
    });
  });

  it("packs metadata from a Request body when fetch has no init argument", async () => {
    const request = new Request("https://store.example/cart/add.js", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            id: 123,
            quantity: 1,
            properties: { _promo_engine_offer_id: "offer-request" },
          },
        ],
      }),
    });

    const [packed] = await packCartAddRequest(request);
    expect(packed).toBeInstanceOf(Request);
    const payload = (await (packed as Request).json()) as {
      items: Array<{ properties: Record<string, string> }>;
    };
    expect(JSON.parse(payload.items[0]!.properties._promo_engine_metadata!)).toEqual({
      _promo_engine_offer_id: "offer-request",
    });
  });

  it("leaves non-cart requests untouched", async () => {
    const request = new Request("https://store.example/products.json");
    const [packed, init] = await packCartAddRequest(request);
    expect(packed).toBe(request);
    expect(init).toBeUndefined();
  });
});

describe("installPromoMetadataBridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to the original request if metadata packing throws", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("window", {
      fetch: nativeFetch,
      location: { origin: "https://store.example", pathname: "/", search: "" },
    });
    vi.stubGlobal("document", { addEventListener: vi.fn() });

    installPromoMetadataBridge();

    // Content-type says multipart but the body isn't — formData() parsing rejects,
    // which used to propagate out of window.fetch instead of falling back.
    const badRequest = new Request("https://store.example/cart/add.js", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "not actually multipart",
    });

    const response = await window.fetch(badRequest);
    expect(response).toBeInstanceOf(Response);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledWith(badRequest, undefined);
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const LANDING_KEY = "promo_engine_utm_landing";
const landing = (storage: Storage) => (JSON.parse(storage.getItem(LANDING_KEY)!) as { u: string; e: number }).u;

describe("sanitizePageUrl (D4: path + utm_* + specific-link param names only)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops emails, click ids and every other param", () => {
    expect(
      sanitizePageUrl("/products/x?email=a%40b.co&_kx=zzz&gclid=1&fbclid=2&utm_source=Amazon&UTM_Medium=cpc&color=red"),
    ).toBe("/products/x?utm_source=Amazon&UTM_Medium=cpc");
  });

  it("keeps the default freegifts_code link param and drops the query entirely when nothing is kept", () => {
    expect(sanitizePageUrl("/?freegifts_code=VIP&x=1")).toBe("/?freegifts_code=VIP");
    expect(sanitizePageUrl("/pages/a?x=1#frag")).toBe("/pages/a");
  });

  it("uses the link param names from the runtime config", () => {
    vi.stubGlobal("window", { __promoEngineConfig: { specificLinkParams: ["Promo_Key"] } });
    expect(sanitizePageUrl("/p?promo_key=abc&freegifts_code=nope&utm_x=1")).toBe("/p?promo_key=abc&utm_x=1");
  });

  it("falls back to the list cached from the last evaluate response", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    rememberSpecificLinkParams(["ref_code"]);
    expect(sanitizePageUrl("/p?ref_code=1&freegifts_code=2")).toBe("/p?ref_code=1");
  });

  it("strips scheme and host from absolute URLs and matches encoded param names", () => {
    expect(sanitizePageUrl("https://shop.example/en-fr/p?utm%5Fsource=a&k=1")).toBe("/en-fr/p?utm%5Fsource=a");
  });
});

describe("updates and migrations never stamp a page (D4)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("null source/landing leaves an existing line's page metadata alone", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      location: { origin: "https://s.example", pathname: "/cart", search: "?utm_source=x" },
    });
    recordUtmLanding("/lp?utm_source=x", storage);
    const props = withPromoMetadata({ engraving: "Ada" }, null, null);
    expect(props._promo_page_url).toBeUndefined();
    expect(props._promo_landing_url).toBeUndefined();
    expect(JSON.parse(props._promo_engine_metadata!)).toEqual({ engraving: "Ada" });
  });
});

describe("UTM landing URL (visit-scoped UTM conditions)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records only page views with a utm_* param, keeping the last UTM touch", () => {
    const storage = memoryStorage();
    recordUtmLanding("/pages/lp?utm_source=amazon", storage);
    recordUtmLanding("/collections/all", storage);
    recordUtmLanding("/products/x?ref=home", storage);
    expect(landing(storage)).toBe("/pages/lp?utm_source=amazon");
    recordUtmLanding("/?foo=1&utm_campaign=fall&email=a%40b.co", storage);
    expect(landing(storage)).toBe("/?utm_campaign=fall");
  });

  it("stamps the recorded landing URL into every cart add within 24 h", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    recordUtmLanding("/pages/lp?utm_source=amazon", storage);

    const properties = withPromoMetadata({}, "/products/x");
    expect(properties._promo_landing_url).toBe("/pages/lp?utm_source=amazon");
    expect(JSON.parse(properties._promo_engine_metadata!)).toEqual({
      _promo_page_url: "/products/x",
      _promo_landing_url: "/pages/lp?utm_source=amazon",
    });
  });

  it("expires after 24 h and clears the stale entry", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    recordUtmLanding("/pages/lp?utm_source=amazon", storage, Date.now() - 25 * 60 * 60 * 1000);
    expect(withPromoMetadata({}, "/products/x")._promo_landing_url).toBeUndefined();
    expect(storage.getItem(LANDING_KEY)).toBeNull();
  });

  it("omits the landing URL when the visitor never saw a UTM page", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const properties = withPromoMetadata({}, "/products/x");
    expect(properties._promo_landing_url).toBeUndefined();
    expect(JSON.parse(properties._promo_engine_metadata!)).toEqual({ _promo_page_url: "/products/x" });
  });

  it("survives storage that throws", () => {
    const throwing = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => recordUtmLanding("/?utm_source=x", throwing)).not.toThrow();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(withPromoMetadata({}, "/")._promo_landing_url).toBeUndefined();
  });

  it("records the landing page when the bridge installs", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      fetch: vi.fn(),
      location: { origin: "https://store.example", pathname: "/pages/lp", search: "?utm_source=tiktok" },
    });
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    installPromoMetadataBridge();
    expect(landing(storage)).toBe("/pages/lp?utm_source=tiktok");
  });
});

describe("XMLHttpRequest cart add stamping (jQuery / raw XHR)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function install() {
    const sent: unknown[] = [];
    class FakeXhr {
      open(_method: string, _url: string) {}
      send(body?: unknown) {
        sent.push(body);
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("window", {
      fetch: vi.fn(),
      location: { origin: "https://s.example", pathname: "/products/x", search: "?utm_source=a&email=q%40q.co" },
    });
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    installPromoMetadataBridge();
    return { sent, xhr: new FakeXhr() };
  }

  it("stamps a urlencoded string body (jQuery.ajax default)", () => {
    const { sent, xhr } = install();
    xhr.open("POST", "/cart/add.js");
    xhr.send("id=123&quantity=1&properties%5Bengraving%5D=Ada");
    const params = new URLSearchParams(String(sent[0]));
    const packed = JSON.parse(params.get("properties[_promo_engine_metadata]")!);
    expect(packed).toMatchObject({ engraving: "Ada", _promo_page_url: "/products/x?utm_source=a" });
  });

  it("stamps a JSON string body", () => {
    const { sent, xhr } = install();
    xhr.open("post", "/cart/add");
    xhr.send(JSON.stringify({ id: 1, quantity: 1 }));
    const payload = JSON.parse(String(sent[0])) as { properties: Record<string, string> };
    expect(payload.properties._promo_page_url).toBe("/products/x?utm_source=a");
  });

  it("stamps FormData and URLSearchParams bodies", () => {
    const { sent, xhr } = install();
    xhr.open("POST", "/cart/add.js");
    const fd = new FormData();
    fd.append("id", "1");
    xhr.send(fd);
    expect(JSON.parse(String((sent[0] as FormData).get("properties[_promo_engine_metadata]")))).toMatchObject({
      _promo_page_url: "/products/x?utm_source=a",
    });
    xhr.open("POST", "/cart/add.js");
    xhr.send(new URLSearchParams({ id: "1" }));
    expect((sent[1] as URLSearchParams).get("properties[_promo_engine_metadata]")).toContain("_promo_page_url");
  });

  it("leaves other XHR requests and bodies untouched", () => {
    const { sent, xhr } = install();
    xhr.open("POST", "/cart/change.js");
    xhr.send("id=1&quantity=0");
    xhr.open("GET", "/cart/add.js");
    xhr.send(null);
    xhr.open("POST", "/cart/add.js");
    const blob = new Blob(["x"]);
    xhr.send(blob);
    expect(sent).toEqual(["id=1&quantity=0", null, blob]);
  });

  it("packXhrBody passes unknown body types through", () => {
    expect(packXhrBody(undefined)).toBeUndefined();
    expect(packXhrBody(null)).toBeNull();
  });
});

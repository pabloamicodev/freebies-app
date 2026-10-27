import { beforeEach, describe, expect, it, vi } from "vitest";

const gql = vi.hoisted(() => ({ handler: null as null | ((args: { query: string; variables: Record<string, unknown> }) => unknown), calls: [] as Array<{ query: string; variables: Record<string, unknown> }> }));
const redis = vi.hoisted(() => ({ store: new Map<string, string>(), fail: false, sets: [] as Array<[string, number]> }));

vi.mock("./shopify-fetch.server.js", () => ({
  shopifyGraphQL: async (args: { query: string; variables: Record<string, unknown> }) => {
    gql.calls.push(args);
    return gql.handler!(args);
  },
}));
vi.mock("./redis.server.js", () => ({
  redisGetString: async (k: string) => {
    if (redis.fail) throw new Error("down");
    return redis.store.get(k) ?? null;
  },
  redisSetString: async (k: string, v: string, ttl: number) => {
    if (redis.fail) throw new Error("down");
    redis.store.set(k, v);
    redis.sets.push([k, ttl]);
  },
}));

import {
  buildThemeCatalog,
  findStaleRefs,
  getThemeCatalog,
  normalizeSectionRef,
  schemaName,
  templateRefFromFilename,
  type ThemeCatalog,
} from "./theme-catalog.server.js";

const auth = { shopDomain: "s.myshopify.com", accessToken: "t" };
const file = (filename: string, content: string) => ({ filename, body: { content } });
const page = (nodes: unknown[], next: string | null = null) => ({
  themes: { nodes: [{ id: "gid://shopify/OnlineStoreTheme/1", name: "Dawn", updatedAt: "u1", files: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } }] },
});

const landing = `/* auto-generated */\n${JSON.stringify({
  sections: {
    hero: { type: "hero-banner" },
    custom1: { type: "hero-banner", name: "My Hero" },
    off: { type: "image-banner", disabled: true },
    bad: { type: "broken" },
  },
  order: ["hero", "custom1", "off", "bad"],
})}`;
const locale = JSON.stringify({ sections: { hero: { name: "Hero banner" } } });
const sectionFiles = [
  file("sections/hero-banner.liquid", `<div></div>{% schema %}{"name":"t:sections.hero.name"}{% endschema %}`),
  file("sections/image-banner.liquid", `{% schema %}{"name":"Image banner"}{% endschema %}`),
  file("sections/broken.liquid", `{% schema %}{not json{% endschema %}`),
];

function theme(opts: { templatePages?: unknown[][] } = {}) {
  const pages = opts.templatePages ?? [[
    file("templates/page.landing-nektar.json", landing),
    file("templates/customers/account.json", JSON.stringify({ sections: {}, order: [] })),
    file("templates/product.liquid", "{{ x }}"),
    file("locales/en.default.schema.json", locale),
  ]];
  return (args: { query: string; variables: Record<string, unknown> }) => {
    if (args.query.includes("PromoEngineThemeHead")) return { themes: { nodes: [{ id: "gid://shopify/OnlineStoreTheme/1", name: "Dawn", updatedAt: "u1" }] } };
    if (args.query.includes("PromoEngineThemeTemplates")) {
      const i = args.variables.after ? Number(String(args.variables.after).slice(1)) : 0;
      return page(pages[i]!, i + 1 < pages.length ? `c${i + 1}` : null);
    }
    return page(sectionFiles);
  };
}

beforeEach(() => {
  gql.calls = [];
  gql.handler = theme();
  redis.store.clear();
  redis.sets = [];
  redis.fail = false;
});

describe("parsing", () => {
  it("derives template refs", () => {
    expect(templateRefFromFilename("templates/page.landing-nektar.json")).toBe("page.landing-nektar");
    expect(templateRefFromFilename("templates/customers/account.json")).toBe("customers/account");
    expect(templateRefFromFilename("templates/gift_card.liquid")).toBe("gift_card");
    expect(templateRefFromFilename("sections/x.liquid")).toBeNull();
  });
  it("resolves schema names, t: keys and failures", () => {
    const l = { sections: { hero: { name: "Hero banner" } } };
    expect(schemaName(`{% schema %}{"name":"Plain"}{% endschema %}`, l)).toBe("Plain");
    expect(schemaName(`{%- schema -%}{"name":"t:sections.hero.name"}{%- endschema -%}`, l)).toBe("Hero banner");
    expect(schemaName(`{% schema %}{"name":"t:sections.nope.name"}{% endschema %}`, l)).toBe("");
    expect(schemaName(`{% schema %}{bad{% endschema %}`, l)).toBe("");
    expect(schemaName("no schema", l)).toBe("");
  });
});

describe("buildThemeCatalog", () => {
  it("builds templates, labels and name fallbacks", async () => {
    const c = (await buildThemeCatalog(auth)) as Exclude<ThemeCatalog, { unavailable: true }>;
    expect(c.templates.map((t) => t.ref)).toEqual(["customers/account", "page.landing-nektar", "product"]);
    expect(c.templates.find((t) => t.ref === "page.landing-nektar")?.pageType).toBe("Page");
    expect(c.templates.find((t) => t.ref === "customers/account")?.pageType).toContain("Customer account");
    const by = Object.fromEntries(c.sections.map((s) => [s.ref, s]));
    expect(by["page.landing-nektar/hero"]!.label).toBe("Hero banner (page.landing-nektar)");
    expect(by["page.landing-nektar/custom1"]!.label).toBe("My Hero (page.landing-nektar)");
    expect(by["page.landing-nektar/off"]!.label).toBe("Image banner (page.landing-nektar)");
    expect(by["page.landing-nektar/off"]!.disabled).toBe(true);
    expect(by["page.landing-nektar/bad"]!.label).toBe("broken (page.landing-nektar)");
  });

  it("paginates templates and schemas", async () => {
    gql.handler = theme({ templatePages: [[file("templates/page.a.json", landing)], [file("templates/page.b.json", landing), file("locales/en.default.schema.json", locale)]] });
    const c = (await buildThemeCatalog(auth)) as Exclude<ThemeCatalog, { unavailable: true }>;
    expect(c.templates.map((t) => t.ref)).toEqual(["page.a", "page.b"]);
    expect(c.sections.find((s) => s.ref === "page.b/hero")!.label).toBe("Hero banner (page.b)");
    const t = gql.calls.filter((x) => x.query.includes("PromoEngineThemeTemplates"));
    expect(t.map((x) => x.variables.after)).toEqual([null, "c1"]);
    expect(gql.calls.filter((x) => x.query.includes("PromoEngineSectionSchemas"))).toHaveLength(1);
  });

  it("reports unavailable when there is no main theme", async () => {
    gql.handler = () => ({ themes: { nodes: [] } });
    expect(await buildThemeCatalog(auth)).toEqual({ unavailable: true });
  });
});

describe("getThemeCatalog cache", () => {
  it("misses, stores for 10 min, then hits", async () => {
    await getThemeCatalog(auth);
    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0]![1]).toBe(600);
    expect(redis.sets[0]![0]).toContain("s.myshopify.com");
    expect(redis.sets[0]![0]).toContain("OnlineStoreTheme/1");
    const callsAfterMiss = gql.calls.length;
    const hit = await getThemeCatalog(auth);
    expect(gql.calls.length).toBe(callsAfterMiss + 1);
    expect((hit as { templates: unknown[] }).templates.length).toBe(3);
  });

  it("degrades when redis is down", async () => {
    redis.fail = true;
    const c = await getThemeCatalog(auth);
    expect((c as { templates: unknown[] }).templates.length).toBe(3);
  });

  it("returns unavailable when the API fails", async () => {
    gql.handler = () => {
      throw new Error("missing scope");
    };
    expect(await getThemeCatalog(auth)).toEqual({ unavailable: true });
  });
});

describe("normalizer and stale check", () => {
  let c: ThemeCatalog;
  beforeEach(async () => {
    c = await buildThemeCatalog(auth);
  });
  it("normalizes pasted DOM ids", () => {
    expect(normalizeSectionRef("shopify-section-template--123__hero", c)).toBe("page.landing-nektar/hero");
    expect(normalizeSectionRef("template--999__custom1", c)).toBe("page.landing-nektar/custom1");
    expect(normalizeSectionRef("page.landing-nektar/hero", c)).toBe("page.landing-nektar/hero");
    expect(normalizeSectionRef("template--1__missing", c)).toBeNull();
    expect(normalizeSectionRef("sections--1__header", c)).toBeNull();
  });
  it("refuses ambiguous keys unless a template hint disambiguates", async () => {
    gql.handler = theme({ templatePages: [[file("templates/page.a.json", landing), file("templates/page.b.json", landing)]] });
    const two = await buildThemeCatalog(auth);
    expect(normalizeSectionRef("template--1__hero", two)).toBeNull();
    expect(normalizeSectionRef("template--1__hero", two, "page.b")).toBe("page.b/hero");
  });
  it("flags refs missing from the theme", () => {
    expect(findStaleRefs(["page.landing-nektar", "page.landing-nektar/hero", "page.gone", "page.landing-nektar/nope"], c)).toEqual(["page.gone", "page.landing-nektar/nope"]);
    expect(findStaleRefs(["x"], { unavailable: true })).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bundleDefinitions, bundleSteps, offerConditions, offerRewards, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));

vi.mock("./proxy-shop.server.js", () => ({
  getSignedShopCached: async () => ({ id: ctx.shopId, db: ctx.db, currencyCode: "USD", loggedInCustomerId: null }),
}));
vi.mock("./proxy-rate-limit.server.js", () => ({ proxyRateLimitResponse: async () => null }));

const bundleRoute = await import("../routes/apps.promo-engine.bundle.js");
const customizationsRoute = await import("../routes/apps.promo-engine.product-customizations.js");

const VARIANT = "gid://shopify/ProductVariant/1";
const EXP = "clx9k2abcdef";

let db: Db;
let close: () => Promise<void>;
let bundleOffer = "";
let tierOffer = "";

const ctxParam = (map: Record<string, string>) => Buffer.from(JSON.stringify(map)).toString("base64url");

// One condition per page condition type, each paired with a context that passes and one that fails.
const CASES: Array<{ type: string; value: unknown; pass: Record<string, string>; fail: Record<string, string> }> = [
  {
    type: "page_url",
    value: { patterns: ["/pages/vip"], matchMode: "exact", caseSensitive: false },
    pass: { _promo_page_url: "/pages/vip" },
    fail: { _promo_page_url: "/pages/other" },
  },
  {
    type: "specific_link",
    value: { requiredUrl: "/pages/vip", paramName: "code", paramValue: "summer" },
    pass: { _promo_page_url: "/pages/vip?code=summer" },
    fail: { _promo_page_url: "/pages/vip?code=winter" },
  },
  {
    type: "utm_parameters",
    value: { utmSource: "tiktok", scope: "page" },
    pass: { _promo_page_url: "/p?utm_source=tiktok" },
    fail: { _promo_page_url: "/p?utm_source=meta" },
  },
  {
    type: "page_types",
    value: { pageTypes: ["product"] },
    pass: { _promo_page_url: "/products/x" },
    fail: { _promo_page_url: "/collections/x" },
  },
  {
    type: "template",
    value: { templates: ["product"] },
    pass: { _promo_page_url: "/products/x", _promo_template: "@product" },
    fail: { _promo_page_url: "/products/x", _promo_template: "@collection" },
  },
  {
    type: "section_shown",
    value: { sections: [{ template: "product", key: "hero" }] },
    pass: { _promo_page_url: "/products/x", _promo_sections: "@product/hero" },
    fail: { _promo_page_url: "/products/x", _promo_sections: "@product/footer" },
  },
  {
    type: "experiment",
    value: { experimentId: EXP, variantKeys: ["variant_a"] },
    pass: { _promo_page_url: "/products/x", _promo_exp: `@${EXP}:variant_a` },
    fail: { _promo_page_url: "/products/x", _promo_exp: `@${EXP}:control` },
  },
];

async function setCondition(offerId: string, conditionType: string, value: unknown) {
  await db.delete(offerConditions);
  await db.insert(offerConditions).values({
    shopId: ctx.shopId, offerId, scope: "main", conditionType, operator: "eq", value, sortOrder: 0, isEnabled: true,
  });
}

async function bundle(query: Record<string, string>) {
  const url = new URL("https://app.test/apps/promo-engine/bundle");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await bundleRoute.loader({ request: new Request(url), params: {}, context: {} } as never);
  return (await response.json()) as { bundleBuilder?: unknown };
}

async function volume(query: Record<string, string>) {
  const url = new URL("https://app.test/apps/promo-engine/product-customizations");
  url.searchParams.set("offer_id", tierOffer);
  url.searchParams.set("variant_id", VARIANT);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await customizationsRoute.loader({ request: new Request(url), params: {}, context: {} } as never);
  return (await response.json()) as { volumeDiscount?: unknown };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  ctx.shopId = await seedShop(db);
  bundleOffer = await seedOffer(db, ctx.shopId, { type: "bundle" });
  const [definition] = await db
    .insert(bundleDefinitions)
    .values({ shopId: ctx.shopId, offerId: bundleOffer, bundleType: "classic", title: "B", bundleProductGid: "gid://shopify/Product/1" })
    .returning({ id: bundleDefinitions.id });
  await db.insert(bundleSteps).values({ shopId: ctx.shopId, bundleId: definition!.id, title: "S", sourceType: "products", sourceConfig: {} });
  tierOffer = await seedOffer(db, ctx.shopId, { type: "discount" });
  await db.insert(offerRewards).values({
    shopId: ctx.shopId,
    offerId: tierOffer,
    rewardType: "product_discount",
    discountType: "percentage",
    value: { tiers: [{ minimumQuantity: 2, discountType: "percentage", discountValue: 10 }] },
    target: { scope: "cart" },
  });
}, 60_000);

afterAll(async () => {
  await close();
});

describe("/bundle and /product-customizations share one page gate", () => {
  it("shows an offer without page conditions whatever the context", async () => {
    await db.delete(offerConditions);
    expect((await bundle({})).bundleBuilder).toBeDefined();
    expect((await volume({})).volumeDiscount).toBeDefined();
  });

  for (const { type, value, pass, fail } of CASES) {
    it(`gates ${type} through ctx`, async () => {
      await setCondition(bundleOffer, type, value);
      expect((await bundle({ ctx: ctxParam(pass) })).bundleBuilder).toBeDefined();
      expect((await bundle({ ctx: ctxParam(fail) })).bundleBuilder).toBeUndefined();
      expect((await bundle({})).bundleBuilder).toBeUndefined();

      await setCondition(tierOffer, type, value);
      expect((await volume({ ctx: ctxParam(pass) })).volumeDiscount).toBeDefined();
      expect((await volume({ ctx: ctxParam(fail) })).volumeDiscount).toBeUndefined();
      expect((await volume({})).volumeDiscount).toBeUndefined();
    });
  }

  it("keeps an older block that only sends page_url working for URL conditions and failing closed for the new ones", async () => {
    await setCondition(bundleOffer, "page_url", CASES[0]!.value);
    expect((await bundle({ page_url: "https://shop.example/pages/vip" })).bundleBuilder).toBeDefined();
    expect((await bundle({ page_url: "https://shop.example/pages/other" })).bundleBuilder).toBeUndefined();
    await setCondition(bundleOffer, "template", { templates: ["product"] });
    expect((await bundle({ page_url: "https://shop.example/products/x" })).bundleBuilder).toBeUndefined();
  });

  it("enforces utm_parameters and page_types, which the old bundle gate let through", async () => {
    await setCondition(bundleOffer, "utm_parameters", CASES[2]!.value);
    expect((await bundle({ page_url: "https://shop.example/p?utm_source=meta" })).bundleBuilder).toBeUndefined();
    expect((await bundle({ page_url: "https://shop.example/p?utm_source=tiktok" })).bundleBuilder).toBeDefined();
  });

  it("ignores keys outside the stamp whitelist and malformed ctx (fails closed)", async () => {
    await setCondition(bundleOffer, "page_url", CASES[0]!.value);
    expect((await bundle({ ctx: ctxParam({ _promo_page_url: "/pages/other", other: "x" }) })).bundleBuilder).toBeUndefined();
    expect((await bundle({ ctx: "%%%not-base64-json" })).bundleBuilder).toBeUndefined();
    expect((await bundle({ ctx: ctxParam({ _promo_page_url: `/pages/vip${"a".repeat(3_000)}` }) })).bundleBuilder).toBeUndefined();
  });

  it("ignores a disabled page condition", async () => {
    await setCondition(tierOffer, "template", { templates: ["product"] });
    await db.update(offerConditions).set({ isEnabled: false });
    expect((await volume({})).volumeDiscount).toBeDefined();
  });
});

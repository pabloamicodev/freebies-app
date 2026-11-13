import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { appSettings, auditLogs, mcpOperators, offerConditions, offerRewards, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerI18nTools } from "./register-i18n.server.js";

vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const USD = "i18n-usd.myshopify.com";
const JPY = "i18n-jpy.myshopify.com";

type Body = { code?: string; message?: string; summary: string; data: Record<string, any>; meta: { dryRun?: boolean } };
const body = (r: unknown) => (r as CallToolResult).structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let usdId = "";
let jpyId = "";
let operator: Operator;
let publish = vi.fn<ShopPublishFn>(async () => null);

async function connect() {
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: async () => ({ ok: true as const }), publish };
  const server = new McpServer({ name: "promo-engine-test", version: "0.0.0" });
  registerI18nTools(server, ctx);
  const client = new Client({ name: "vitest-client", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, stop: async () => { await client.close(); await server.close(); } };
}
async function call(tool: string, args: Record<string, unknown>) {
  const { client, stop } = await connect();
  try {
    return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  } finally {
    await stop();
  }
}

async function activeOffer(shopId: string, status: "active" | "draft", cartValue: Record<string, unknown> = { thresholdCents: 5000, currencyCode: "USD" }) {
  const id = await seedOffer(db, shopId, { internalName: `[i18n] ${Math.random().toString(36).slice(2, 8)}`, status });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: cartValue, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
    target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
  });
  return id;
}
const condValue = async (offerId: string) =>
  (await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, offerId), eq(offerConditions.conditionType, "cart_value"))))[0]!.value as Record<string, any>;
const setting = async (shopId: string, key: string) =>
  (await db.select().from(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, key))))[0];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  usdId = await seedShop(db, USD);
  jpyId = await seedShop(db, JPY);
  await db.update(shops).set({ currencyCode: "JPY" }).where(eq(shops.id, jpyId));
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publish = vi.fn<ShopPublishFn>(async () => null);
  resetMemoryRateLimits();
});

describe("translations_get / translations_set", () => {
  it("lists every key with label, hint and allowed vars, then round-trips a partial patch", async () => {
    const first = body(await call("translations_get", { shop: USD, locale: "es" }));
    const keys = first.data["keys"] as Array<Record<string, any>>;
    const before = keys.find((k) => k["key"] === "progress.before_goal")!;
    expect(before).toMatchObject({ label: expect.anything(), hint: expect.anything(), allowedVars: expect.arrayContaining(["remaining_amount"]), value: null });
    expect(keys.length).toBe(16);

    const set = await call("translations_set", { shop: USD, locale: "es", strings: { "progress.before_goal": "Gasta {{remaining_amount}} mas", "fbt.title": "Comprados juntos" } });
    expect(set.isError).toBeFalsy();
    await call("translations_set", { shop: USD, locale: "es", strings: { "upsell.no_thanks": "No, gracias" } });
    const after = body(await call("translations_get", { shop: USD, locale: "es" }));
    const byKey = Object.fromEntries((after.data["keys"] as Array<Record<string, any>>).map((k) => [k["key"], k["value"]]));
    expect(byKey).toMatchObject({ "progress.before_goal": "Gasta {{remaining_amount}} mas", "fbt.title": "Comprados juntos", "upsell.no_thanks": "No, gracias" });

    await call("translations_set", { shop: USD, locale: "es", strings: { "fbt.title": null } });
    const removed = body(await call("translations_get", { shop: USD, locale: "es" }));
    expect((removed.data["keys"] as Array<Record<string, any>>).find((k) => k["key"] === "fbt.title")!["value"]).toBeNull();
    expect((removed.data["keys"] as Array<Record<string, any>>).find((k) => k["key"] === "upsell.no_thanks")!["value"]).toBe("No, gracias");
  });

  it("rejects an unknown placeholder and stores nothing", async () => {
    const res = await call("translations_set", { shop: USD, locale: "fr", strings: { "progress.after_goal": "Merci {{name}}" } });
    expect(res.isError).toBe(true);
    expect(body(res).code).toBe("VALIDATION");
    expect(body(res).message).toContain("{{name}}");
    const read = body(await call("translations_get", { shop: USD, locale: "fr" }));
    expect((read.data["keys"] as Array<Record<string, any>>).every((k) => k["value"] === null)).toBe(true);
  });

  it("rejects a malformed placeholder, a long string and an unknown key", async () => {
    const bad = await call("translations_set", { shop: USD, locale: "fr", strings: { "progress.before_goal": "Il manque {{ remaining_amount }}" } });
    expect(body(bad).code).toBe("VALIDATION");
    const long = await call("translations_set", { shop: USD, locale: "fr", strings: { "fbt.title": "x".repeat(301) } });
    expect(body(long).code).toBe("VALIDATION");
    const unknown = await call("translations_set", { shop: USD, locale: "fr", strings: { "nope.key": "x" } });
    expect(body(unknown).code).toBe("VALIDATION");
  });

  it("dryRun previews without writing; replace drops the other keys", async () => {
    const dry = await call("translations_set", { shop: USD, locale: "de", strings: { "fbt.title": "Zusammen gekauft" }, dryRun: true });
    expect(body(dry).meta.dryRun).toBe(true);
    expect(body(dry).data["changedKeys"]).toEqual(["fbt.title"]);
    const stored = await setting(usdId, "translations.strings");
    expect(JSON.parse(stored!.value as string)["de"]).toBeUndefined();

    await call("translations_set", { shop: USD, locale: "de", strings: { "fbt.title": "A", "upsell.no_thanks": "B" } });
    await call("translations_set", { shop: USD, locale: "de", strings: { "fbt.title": "C" }, mode: "replace" });
    expect(JSON.parse((await setting(usdId, "translations.strings"))!.value as string)["de"]).toEqual({ locale: "de", "fbt.title": "C" });
  });
});

describe("customize_get / customize_set", () => {
  it("round-trips a patch over the defaults, then replace", async () => {
    const initial = body(await call("customize_get", { shop: USD }));
    expect(initial.data["theme"].primaryColor).toBe("#111111");
    expect(initial.data["customizedKeys"]).toEqual([]);

    const set = await call("customize_set", { shop: USD, values: { primaryColor: "#0a7d3b" } });
    expect(set.isError).toBeFalsy();
    await call("customize_set", { shop: USD, values: { buttonColor: "#222222" } });
    const read = body(await call("customize_get", { shop: USD }));
    expect(read.data["theme"]).toMatchObject({ primaryColor: "#0a7d3b", buttonColor: "#222222", accentColor: "#059669" });
    expect(read.data["customizedKeys"].sort()).toEqual(["buttonColor", "primaryColor"]);

    await call("customize_set", { shop: USD, values: { accentColor: "#ff0000" }, mode: "replace" });
    const replaced = body(await call("customize_get", { shop: USD }));
    expect(replaced.data["theme"]).toMatchObject({ accentColor: "#ff0000", primaryColor: "#111111" });
  });

  it("uses the same app_settings key as the admin page and audits the write", async () => {
    await call("customize_set", { shop: USD, values: { fontFamily: "Georgia" } });
    expect(JSON.parse((await setting(usdId, "widget.global_theme"))!.value as string)).toMatchObject({ fontFamily: "Georgia" });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, usdId), eq(auditLogs.action, "customize_update")));
    expect(audit.length).toBeGreaterThan(0);
  });

  it("rejects unknown theme keys and dryRun writes nothing", async () => {
    const res = await call("customize_set", { shop: JPY, values: { notAKey: "x" } });
    expect(res.isError).toBe(true);
    await call("customize_set", { shop: JPY, values: { primaryColor: "#123456" }, dryRun: true });
    expect(await setting(jpyId, "widget.global_theme")).toBeUndefined();
  });
});

describe("promo_multicurrency_get / promo_set_multicurrency", () => {
  it("on an active offer saves the overrides, republishes once and reads them back in major units", async () => {
    const id = await activeOffer(usdId, "active");
    const res = await call("promo_set_multicurrency", { ref: id, shop: USD, overrides: [{ currency: "eur", threshold: 25.5, fixed: 5 }, { currency: "GBP", threshold: 20 }] });
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    const value = await condValue(id);
    expect(value["thresholdCents"]).toBe(5000);
    expect(value["currencyOverrides"]).toEqual({ EUR: 2550, GBP: 2000 });
    expect(value["fixedAmountOverrides"]).toEqual({ EUR: 500 });
    expect(value["maxCurrencyOverrides"]).toEqual({});

    const read = body(await call("promo_multicurrency_get", { ref: id, shop: USD }));
    expect(read.data["major"]).toEqual({ EUR: { threshold: 25.5, fixed: 5 }, GBP: { threshold: 20 } });
  });

  it("patch keeps untouched currencies and null removes one; replace overwrites everything", async () => {
    const id = await activeOffer(usdId, "draft");
    await call("promo_set_multicurrency", { ref: id, shop: USD, overrides: [{ currency: "EUR", threshold: 10, fixed: 2 }, { currency: "GBP", threshold: 9 }] });
    await call("promo_set_multicurrency", { ref: id, shop: USD, overrides: [{ currency: "EUR", threshold: null }, { currency: "CAD", threshold: 30 }] });
    expect((await condValue(id))["currencyOverrides"]).toEqual({ GBP: 900, CAD: 3000 });
    expect((await condValue(id))["fixedAmountOverrides"]).toEqual({ EUR: 200 });
    await call("promo_set_multicurrency", { ref: id, shop: USD, overrides: [{ currency: "AUD", threshold: 40 }], mode: "replace" });
    const value = await condValue(id);
    expect(value["currencyOverrides"]).toEqual({ AUD: 4000 });
    expect(value["fixedAmountOverrides"]).toEqual({});
  });

  it("a draft offer is saved without publishing; dryRun neither writes nor publishes", async () => {
    const id = await activeOffer(usdId, "draft");
    await call("promo_set_multicurrency", { ref: id, shop: USD, overrides: [{ currency: "EUR", threshold: 10 }] });
    expect(publish).not.toHaveBeenCalled();
    const live = await activeOffer(usdId, "active");
    const dry = await call("promo_set_multicurrency", { ref: live, shop: USD, overrides: [{ currency: "EUR", threshold: 10 }], dryRun: true });
    expect(body(dry).meta.dryRun).toBe(true);
    expect(body(dry).data["currencyOverrides"]).toEqual({ EUR: 1000 });
    expect(publish).not.toHaveBeenCalled();
    expect((await condValue(live))["currencyOverrides"]).toBeUndefined();
  });

  it("zero-decimal shop stores JPY in whole yen (no x100); a USD shop keeps x100", async () => {
    const id = await activeOffer(jpyId, "draft", { thresholdCents: 5000, currencyCode: "JPY" });
    await call("promo_set_multicurrency", { ref: id, shop: JPY, overrides: [{ currency: "JPY", threshold: 3000, fixed: 500 }, { currency: "USD", fixed: 5.25 }] });
    const value = await condValue(id);
    expect(value["currencyOverrides"]).toEqual({ JPY: 3000 });
    expect(value["fixedAmountOverrides"]).toEqual({ JPY: 500, USD: 525 });
    const read = body(await call("promo_multicurrency_get", { ref: id, shop: JPY }));
    expect(read.data["major"]).toEqual({ JPY: { threshold: 3000, fixed: 500 }, USD: { fixed: 5.25 } });

    const usd = await activeOffer(usdId, "draft");
    await call("promo_set_multicurrency", { ref: usd, shop: USD, overrides: [{ currency: "JPY", threshold: 5000 }] });
    expect((await condValue(usd))["currencyOverrides"]).toEqual({ JPY: 500000 });
  });

  it("validates max >= threshold and the presence of a Cart Value condition", async () => {
    const id = await activeOffer(usdId, "draft");
    const bad = await call("promo_set_multicurrency", { ref: id, shop: USD, overrides: [{ currency: "EUR", threshold: 50, max: 10 }] });
    expect(body(bad).code).toBe("VALIDATION");
    expect(body(bad).message).toContain("EUR maximum");

    const bare = await seedOffer(db, usdId, { internalName: "[i18n] bare", status: "draft" });
    const none = await call("promo_set_multicurrency", { ref: bare, shop: USD, overrides: [{ currency: "EUR", threshold: 5 }] });
    expect(body(none).code).toBe("VALIDATION");
    expect(body(none).message).toContain("Cart Value");
    const read = body(await call("promo_multicurrency_get", { ref: bare, shop: USD }));
    expect(read.data["hasCartValueCondition"]).toBe(false);
  });

  it("reports a failed publish as PUBLISH_FAILED", async () => {
    const id = await activeOffer(usdId, "active");
    publish = vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
    const res = await call("promo_set_multicurrency", { ref: id, shop: USD, overrides: [{ currency: "EUR", threshold: 10 }] });
    expect(body(res).code).toBe("PUBLISH_FAILED");
  });
});

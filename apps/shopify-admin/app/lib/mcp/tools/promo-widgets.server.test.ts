import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { appSettings, auditLogs, mcpOperators, offerConditions, offerRewards, widgetPlacements, widgets, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerPromoWidgetsTools } from "./register-promo-widgets.server.js";

vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const SHOP_A = "widgets-a.myshopify.com";
const SHOP_B = "widgets-b.myshopify.com";
const REF_A = (id: string) => `promo:widgets-a:${id}`;
const MARKET = "gid://shopify/Market/111";

type Body = { code?: string; message?: string; summary: string; data: Record<string, any>; meta: { dryRun?: boolean }; warnings: { code: string }[] };
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let operator: Operator;
const shopIds: Record<string, string> = {};
let publish = vi.fn<ShopPublishFn>(async () => null);
let client: Client;
let stop: () => Promise<void>;

async function connect() {
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: async () => ({ ok: true as const }), publish };
  const server = new McpServer({ name: "promo-engine", version: "0.0.0" });
  registerPromoWidgetsTools(server, ctx);
  const c = new Client({ name: "vitest-client", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), c.connect(b)]);
  client = c;
  stop = async () => {
    await c.close();
    await server.close();
  };
}
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;

/** An active offer with a condition and reward, so the real publish validation lets a republish through. */
async function activeOffer(shopId: string) {
  const id = await seedOffer(db, shopId, { internalName: `[widgets] ${Math.random().toString(36).slice(2, 8)}`, status: "active" });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
    target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
  });
  return id;
}
const draftOffer = (shopId: string, extra: Partial<Parameters<typeof seedOffer>[2]> = {}) => seedOffer(db, shopId, { status: "draft", ...extra });
const widgetRows = (offerId: string) => db.select().from(widgets).where(eq(widgets.offerId, offerId));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopIds["a"] = await seedShop(db, SHOP_A);
  shopIds["b"] = await seedShop(db, SHOP_B);
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  publish = vi.fn<ShopPublishFn>(async () => null);
  resetMemoryRateLimits();
  await connect();
  return async () => stop();
});

describe("widget add / toggle / delete round trip", () => {
  it("adds a widget with its placement, lists it, toggles it, deletes it, and audits each step as mcp:<operator>", async () => {
    const offerId = await draftOffer(shopIds["a"]!);
    const add = await call("promo_widget_upsert", {
      ref: REF_A(offerId), widgetType: "gift_slider", title: "Pick a gift", buttonText: "Take it", maxSelectable: 2, showPrice: true,
      primaryColor: "#0a7d3b", placementType: "cart_drawer", pageType: "cart",
    });
    expect(add.isError, JSON.stringify(add.structuredContent)).toBeFalsy();
    const widgetId = body(add).data["widgetId"] as string;

    const [row] = await widgetRows(offerId);
    expect(row).toMatchObject({ id: widgetId, type: "gift_slider", title: "Pick a gift", isEnabled: true, internalName: `gift_slider-${offerId.slice(0, 8)}` });
    expect(row!.config).toEqual({ buttonText: "Take it", maxSelectableCount: 2, layout: "popup", showPrice: true, showOutOfStock: false });
    expect(row!.theme).toEqual({ primaryColor: "#0a7d3b", buttonColor: "#0a7d3b", textColor: "#ffffff", backgroundColor: "#ffffff" });
    const placements = await db.select().from(widgetPlacements).where(eq(widgetPlacements.widgetId, widgetId));
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ placementType: "cart_drawer", pageRule: { pageType: "cart" }, isEnabled: true });

    const listed = body(await call("promo_widgets_list", { ref: REF_A(offerId) }));
    expect(listed.data["widgets"]).toEqual([expect.objectContaining({ widgetId, type: "gift_slider", isEnabled: true, placements: [expect.objectContaining({ placementType: "cart_drawer" })] })]);

    const off = await call("promo_widget_set_enabled", { ref: REF_A(offerId), widgetId, enabled: false });
    expect(off.isError).toBeFalsy();
    expect(body(off).data).toMatchObject({ enabledBefore: true, enabled: false });
    expect((await widgetRows(offerId))[0]!.isEnabled).toBe(false);

    const del = await call("promo_widget_delete", { ref: REF_A(offerId), widgetId });
    expect(del.isError).toBeFalsy();
    expect(await widgetRows(offerId)).toHaveLength(0);
    expect(await db.select().from(widgetPlacements).where(eq(widgetPlacements.widgetId, widgetId))).toHaveLength(0);

    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopIds["a"]!), eq(auditLogs.entityId, widgetId)));
    expect(audits.map((a) => a.action).sort()).toEqual(["widget_add", "widget_delete", "widget_toggle"]);
    for (const a of audits) {
      expect(a.performedBy).toBe(`mcp:${operator.id}`);
      expect((a.after as { _mcp?: { tool?: string } })._mcp?.tool).toMatch(/^promo_widget_/);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("dryRun previews without writing, auditing or publishing", async () => {
    const offerId = await activeOffer(shopIds["a"]!);
    const dry = await call("promo_widget_upsert", { ref: REF_A(offerId), widgetType: "progress_bar", placementType: "global", dryRun: true });
    expect(dry.isError).toBeFalsy();
    expect(body(dry).meta.dryRun).toBe(true);
    expect(body(dry).data).toMatchObject({ type: "progress_bar", widgetId: null, offerStatus: "active" });
    expect(await widgetRows(offerId)).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("every widget type the schema knows can be added", async () => {
    const offerId = await draftOffer(shopIds["a"]!);
    const types = ["gift_slider", "gift_popup", "cart_message", "today_offer_widget", "today_offer_block", "progress_bar", "gift_icon", "gift_thumbnail", "classic_bundle", "mix_match_bundle", "bundle_page", "checkout_upsell", "fbt", "thank_you_upsell", "volume_discount"];
    for (const widgetType of types) {
      const r = await call("promo_widget_upsert", { ref: REF_A(offerId), widgetType, placementType: "product_page" });
      expect(r.isError, `${widgetType}: ${JSON.stringify(r.structuredContent)}`).toBeFalsy();
    }
    expect((await widgetRows(offerId)).map((w) => w.type).sort()).toEqual([...types].sort());
  });

  it("a live offer is republished through the injected publish; a failed publish keeps the widget and reports PUBLISH_FAILED", async () => {
    const offerId = await activeOffer(shopIds["a"]!);
    const ok = await call("promo_widget_upsert", { ref: REF_A(offerId), widgetType: "gift_popup", placementType: "cart_page" });
    expect(ok.isError, JSON.stringify(ok.structuredContent)).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(shopIds["a"], SHOP_A);

    publish = vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
    await stop();
    await connect();
    const failed = await call("promo_widget_upsert", { ref: REF_A(offerId), widgetType: "gift_icon", placementType: "global" });
    expect(failed.isError).toBe(true);
    expect(body(failed).code).toBe("PUBLISH_FAILED");
    expect(await widgetRows(offerId)).toHaveLength(2);
  });

  it("rejects bad input without writing: unknown type, invalid hex, unknown placement; invalid hex also fails the service rule", async () => {
    const offerId = await draftOffer(shopIds["a"]!);
    for (const bad of [{ widgetType: "carousel" }, { widgetType: "fbt", primaryColor: "red" }, { widgetType: "fbt", placementType: "footer" }]) {
      const r = await call("promo_widget_upsert", { ref: REF_A(offerId), ...bad });
      expect(r.isError).toBe(true);
    }
    expect(await widgetRows(offerId)).toHaveLength(0);
  });

  it("answers NOT_FOUND for an unknown widget and for an offer that belongs to another shop", async () => {
    const offerId = await draftOffer(shopIds["a"]!);
    const missing = await call("promo_widget_delete", { ref: REF_A(offerId), widgetId: "00000000-0000-4000-8000-000000000000" });
    expect(body(missing).code).toBe("NOT_FOUND");

    const other = await draftOffer(shopIds["b"]!);
    const wrongShop = await call("promo_widget_upsert", { ref: REF_A(other), widgetType: "fbt" });
    expect(body(wrongShop).code).toBe("NOT_FOUND");
    expect(await widgetRows(other)).toHaveLength(0);
  });

  it("cannot toggle or delete a widget through another offer's ref", async () => {
    const a = await draftOffer(shopIds["a"]!);
    const b = await draftOffer(shopIds["a"]!);
    const widgetId = body(await call("promo_widget_upsert", { ref: REF_A(a), widgetType: "fbt" })).data["widgetId"] as string;
    expect(body(await call("promo_widget_set_enabled", { ref: REF_A(b), widgetId, enabled: false })).code).toBe("NOT_FOUND");
    expect(body(await call("promo_widget_delete", { ref: REF_A(b), widgetId })).code).toBe("NOT_FOUND");
    expect(await widgetRows(a)).toHaveLength(1);
  });

  it("replays an executed call with the same idempotencyKey instead of adding a second widget", async () => {
    const offerId = await draftOffer(shopIds["a"]!);
    const args = { ref: REF_A(offerId), widgetType: "cart_message", idempotencyKey: "widgets-idem-0001" };
    await call("promo_widget_upsert", args);
    const replay = await call("promo_widget_upsert", args);
    expect(body(replay).warnings.map((w) => w.code)).toContain("IDEMPOTENT_REPLAY");
    expect(await widgetRows(offerId)).toHaveLength(1);
  });
});

describe("market overrides", () => {
  const stored = async (offerId: string) =>
    (await db.select({ v: appSettings.value }).from(appSettings).where(and(eq(appSettings.shopId, shopIds["a"]!), eq(appSettings.key, `widget.market_overrides.${offerId}`))))[0]?.v;

  it("saves, normalizes, lists and replaces the whole list; [] clears; nothing is published", async () => {
    const offerId = await activeOffer(shopIds["a"]!);
    const save = await call("promo_widget_set_market_overrides", {
      ref: REF_A(offerId),
      overrides: [{ marketId: MARKET, thresholdCents: 7500, widgetTitle: "  Free gift over 75  " }, { marketId: "gid://shopify/Market/222", enabled: false }],
    });
    expect(save.isError, JSON.stringify(save.structuredContent)).toBeFalsy();
    expect(body(save).data["savedCount"]).toBe(2);
    expect(JSON.parse((await stored(offerId))!)).toEqual([
      { marketId: MARKET, thresholdCents: 7500, widgetTitle: "Free gift over 75", enabled: true },
      { marketId: "gid://shopify/Market/222", thresholdCents: null, widgetTitle: null, enabled: false },
    ]);
    expect(body(await call("promo_widgets_list", { ref: REF_A(offerId) })).data["marketOverrides"]).toHaveLength(2);

    await call("promo_widget_set_market_overrides", { ref: REF_A(offerId), overrides: [{ marketId: MARKET }] });
    expect(JSON.parse((await stored(offerId))!)).toEqual([{ marketId: MARKET, thresholdCents: null, widgetTitle: null, enabled: true }]);

    await call("promo_widget_set_market_overrides", { ref: REF_A(offerId), overrides: [] });
    expect(JSON.parse((await stored(offerId))!)).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("validates: duplicate market, unknown key, negative or fractional threshold, missing marketId", async () => {
    const offerId = await draftOffer(shopIds["a"]!);
    const dup = await call("promo_widget_set_market_overrides", { ref: REF_A(offerId), overrides: [{ marketId: MARKET }, { marketId: MARKET, enabled: false }] });
    expect(body(dup).code).toBe("VALIDATION");
    for (const bad of [{ marketId: MARKET, color: "red" }, { marketId: MARKET, thresholdCents: -5 }, { marketId: MARKET, thresholdCents: 1.5 }, { thresholdCents: 100 }]) {
      const r = await call("promo_widget_set_market_overrides", { ref: REF_A(offerId), overrides: [bad] });
      expect(r.isError).toBe(true);
    }
    expect(await stored(offerId)).toBeUndefined();
  });

  it("dryRun does not save", async () => {
    const offerId = await draftOffer(shopIds["a"]!);
    const dry = await call("promo_widget_set_market_overrides", { ref: REF_A(offerId), overrides: [{ marketId: MARKET, thresholdCents: 100 }], dryRun: true });
    expect(body(dry).data["savedCount"]).toBe(1);
    expect(await stored(offerId)).toBeUndefined();
  });
});

describe("boosters", () => {
  it("lists booster offers and booster widgets only, toggles one, and refuses non-booster and foreign-shop widgets", async () => {
    const boosterOffer = await seedOffer(db, shopIds["a"]!, { type: "booster", status: "active", internalName: "Booster A" });
    const [booster, gift, foreign] = await Promise.all([
      db.insert(widgets).values({ shopId: shopIds["a"]!, offerId: boosterOffer, type: "today_offer_widget", internalName: "today-a", isEnabled: true }).returning(),
      db.insert(widgets).values({ shopId: shopIds["a"]!, offerId: boosterOffer, type: "gift_slider", internalName: "gift-a", isEnabled: true }).returning(),
      db.insert(widgets).values({ shopId: shopIds["b"]!, type: "progress_bar", internalName: "bar-b", isEnabled: true }).returning(),
    ]);

    const list = body(await call("boosters_list", { shops: [SHOP_A] }));
    const shopA = (list.data["shops"] as { shop: string; offers: { name: string }[]; widgets: { widgetId: string }[] }[])[0]!;
    expect(shopA.offers.map((o) => o.name)).toContain("Booster A");
    expect(shopA.widgets.map((w) => w.widgetId)).toContain(booster[0]!.id);
    expect(shopA.widgets.map((w) => w.widgetId)).not.toContain(gift[0]!.id);

    const off = await call("boosters_set", { shop: SHOP_A, widgetId: booster[0]!.id, enabled: false });
    expect(off.isError, JSON.stringify(off.structuredContent)).toBeFalsy();
    expect(body(off).data).toMatchObject({ enabledBefore: true, enabled: false });
    expect((await db.select().from(widgets).where(eq(widgets.id, booster[0]!.id)))[0]!.isEnabled).toBe(false);
    expect(publish).not.toHaveBeenCalled();

    expect(body(await call("boosters_set", { shop: SHOP_A, widgetId: gift[0]!.id, enabled: false })).code).toBe("VALIDATION");
    expect(body(await call("boosters_set", { shop: SHOP_A, widgetId: foreign[0]!.id, enabled: false })).code).toBe("NOT_FOUND");
    expect((await db.select().from(widgets).where(eq(widgets.id, foreign[0]!.id)))[0]!.isEnabled).toBe(true);

    const dry = await call("boosters_set", { shop: SHOP_A, widgetId: booster[0]!.id, enabled: true, dryRun: true });
    expect(body(dry).meta.dryRun).toBe(true);
    expect((await db.select().from(widgets).where(eq(widgets.id, booster[0]!.id)))[0]!.isEnabled).toBe(false);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appSettings, widgetPlacements, widgets, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import type * as PublishFlow from "./offer-publish-flow.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "", republish: null as unknown as ReturnType<typeof vi.fn> }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "widgets-route.myshopify.com" },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: "widgets-route.myshopify.com" } }) },
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => ctx.db,
}));
vi.mock("./offer-publish-flow.server.js", async (importOriginal) => {
  ctx.republish = vi.fn(async () => null as string | null);
  return { ...(await importOriginal<typeof PublishFlow>()), republishIfActive: ctx.republish };
});
vi.mock("./audit-log.server.js", () => ({ insertAuditLog: async () => undefined }));

const widgetRoute = await import("../routes/app.offers.$id.widget.js");
const marketRoute = await import("../routes/app.offers.$id.widget.market.js");
const boostersRoute = await import("../routes/app.boosters.js");

let db: Db;
let close: () => Promise<void>;
let draftId: string;
let activeId: string;

const post = (fields: Record<string, string>) => new Request("http://localhost/x", { method: "POST", body: new URLSearchParams(fields) });
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<Record<string, unknown> | null | undefined>)({ request, params, context: {} });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  ctx.shopId = await seedShop(db, "widgets-route.myshopify.com");
  draftId = await seedOffer(db, ctx.shopId, { status: "draft" });
  activeId = await seedOffer(db, ctx.shopId, { status: "active" });
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  ctx.republish.mockClear();
  ctx.republish.mockResolvedValue(null);
});

const widgetsOf = (offerId: string) => db.select().from(widgets).where(eq(widgets.offerId, offerId));

describe("widget editor route (adapter over offer-widgets.server)", () => {
  it("add_widget stores the widget + placement exactly as before and republishes with the offer's liveness", async () => {
    const result = await run(
      widgetRoute.action,
      post({
        intent: "add_widget", widgetType: "gift_slider", widgetTitle: "Gifts", widgetSubtitle: "", primaryColor: "#112233", buttonText: "",
        maxSelectable: "3", layout: "", showPrice: "on", placementType: "cart_drawer", cssSelector: ".drawer", pageType: "", urlPattern: "",
      }),
      { id: activeId },
    );
    expect(result).toEqual({ success: true, intent: "add_widget" });
    const [w] = await widgetsOf(activeId);
    expect(w).toMatchObject({ type: "gift_slider", title: "Gifts", subtitle: null, isEnabled: true });
    expect(w!.config).toEqual({ buttonText: "Add to Cart", maxSelectableCount: 3, layout: "popup", showPrice: true, showOutOfStock: false });
    expect(w!.theme).toEqual({ primaryColor: "#112233", buttonColor: "#112233", textColor: "#ffffff", backgroundColor: "#ffffff" });
    const [p] = await db.select().from(widgetPlacements).where(eq(widgetPlacements.widgetId, w!.id));
    expect(p).toMatchObject({ placementType: "cart_drawer", selector: ".drawer", pageRule: { pageType: "all" }, sortOrder: 0 });
    expect(ctx.republish).toHaveBeenCalledTimes(1);
    expect(ctx.republish.mock.calls[0]!.slice(1, 5)).toEqual([ctx.shopId, "widgets-route.myshopify.com", activeId, true]);
  });

  it("keeps the admin validation messages and writes nothing on failure", async () => {
    const before = (await widgetsOf(draftId)).length;
    expect(await run(widgetRoute.action, post({ intent: "add_widget", widgetType: "nope" }), { id: draftId })).toEqual({ error: "Invalid widget type: nope" });
    expect(await run(widgetRoute.action, post({ intent: "add_widget", widgetType: "fbt", placementType: "footer" }), { id: draftId })).toEqual({ error: "Invalid placement type: footer" });
    expect(await run(widgetRoute.action, post({ intent: "add_widget", widgetType: "fbt", textColor: "blue" }), { id: draftId })).toEqual({ error: "textColor must be a valid hex color (e.g. #ff0000)." });
    expect(await run(widgetRoute.action, post({ intent: "delete_widget", widgetId: "" }), { id: draftId })).toEqual({ error: "Widget ID missing." });
    expect(await run(widgetRoute.action, post({ intent: "wat" }), { id: draftId })).toEqual({ error: "Unknown intent." });
    expect((await widgetsOf(draftId)).length).toBe(before);
    expect(ctx.republish).not.toHaveBeenCalled();
  });

  it("toggle_widget flips the submitted state, delete_widget removes it, a publish error is returned as {error}", async () => {
    await run(widgetRoute.action, post({ intent: "add_widget", widgetType: "fbt", placementType: "global" }), { id: draftId });
    const [w] = await widgetsOf(draftId);
    expect(await run(widgetRoute.action, post({ intent: "toggle_widget", widgetId: w!.id, isEnabled: "true" }), { id: draftId })).toEqual({ success: true, intent: "toggle_widget" });
    expect((await widgetsOf(draftId))[0]!.isEnabled).toBe(false);
    expect(ctx.republish.mock.calls.at(-1)![4]).toBe(false);

    ctx.republish.mockResolvedValue("Shopify said no");
    expect(await run(widgetRoute.action, post({ intent: "delete_widget", widgetId: w!.id }), { id: draftId })).toEqual({ error: "Shopify said no" });
    expect(await widgetsOf(draftId)).toHaveLength(0);
  });
});

describe("market overrides route", () => {
  const key = (id: string) => and(eq(appSettings.shopId, ctx.shopId), eq(appSettings.key, `widget.market_overrides.${id}`));

  it("saves the normalized list, replaces it on the next save, rejects bad JSON, and never publishes", async () => {
    const overrides = [{ marketId: "gid://shopify/Market/1", thresholdCents: 5000, widgetTitle: " Hi ", enabled: false }, { nope: true }, { marketId: "gid://shopify/Market/2" }];
    const saved = await run(marketRoute.action, post({ overrides: JSON.stringify(overrides) }), { id: draftId });
    expect(saved).toEqual({ success: true, savedCount: 2 });
    const [row] = await db.select().from(appSettings).where(key(draftId));
    expect(JSON.parse(row!.value)).toEqual([
      { marketId: "gid://shopify/Market/1", thresholdCents: 5000, widgetTitle: "Hi", enabled: false },
      { marketId: "gid://shopify/Market/2", thresholdCents: null, widgetTitle: null, enabled: true },
    ]);

    expect(await run(marketRoute.action, post({}), { id: draftId })).toEqual({ success: true, savedCount: 0 });
    expect(await run(marketRoute.action, post({ overrides: "{" }), { id: draftId })).toEqual({ error: "overrides contains invalid JSON." });
    expect(await run(marketRoute.action, post({ overrides: "{}" }), { id: draftId })).toEqual({ error: "overrides must be a JSON array." });
    expect(JSON.parse((await db.select().from(appSettings).where(key(draftId)))[0]!.value)).toEqual([]);
    expect(ctx.republish).not.toHaveBeenCalled();
  });
});

describe("boosters route", () => {
  it("toggle_widget sets the flag for any widget of the shop, does not publish, and returns null", async () => {
    const [w] = await db.insert(widgets).values({ shopId: ctx.shopId, type: "progress_bar", internalName: "bar", isEnabled: true }).returning();
    expect(await run(boostersRoute.action, post({ intent: "toggle_widget", widgetId: w!.id, enabled: "false" }))).toBeNull();
    expect((await db.select().from(widgets).where(eq(widgets.id, w!.id)))[0]!.isEnabled).toBe(false);
    expect(await run(boostersRoute.action, post({ intent: "toggle_widget", widgetId: w!.id, enabled: "true" }))).toBeNull();
    expect((await db.select().from(widgets).where(eq(widgets.id, w!.id)))[0]!.isEnabled).toBe(true);
    expect(ctx.republish).not.toHaveBeenCalled();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { analyticsEvents, auditLogs, cartMutationLogs, discountCodes, offers, shops, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createOperatorWithPat, type Operator } from "../auth.server.js";
import { instrumentReadTools } from "../call-log.server.js";
import { clearFanOutCache } from "../multi-shop.server.js";
import type { McpContext } from "../server.server.js";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { setOfferPublishErrors } from "../../offer-publish-errors.server.js";
import { recordUninstallArchive } from "../../restore-archived-offers.server.js";
import { getDashboardWarnings, invalidateDashboardWarningsCache } from "../../dashboard-warnings.server.js";
import { checkPublishedThemeEmbed, listThemeEmbedStatus } from "../../theme-installation.server.js";
import { registerReadsTools } from "./register-reads.server.js";
import type { ThemeFetcher } from "./reads.server.js";

const world = vi.hoisted(() => ({ db: null as unknown, shopId: "", shopDomain: "alpha.myshopify.com" }));

vi.mock("../../shop-context.server.js", () => ({
  getShopContext: async () => ({ db: world.db, shopId: world.shopId, shopDomain: world.shopDomain, timezone: "UTC", currencyCode: "USD", session: { shop: world.shopDomain } }),
}));
vi.mock("../../../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: world.shopDomain } }) },
}));
vi.mock("@promo/db", async (importOriginal) => ({ ...(await importOriginal<typeof PromoDb>()), getDb: () => world.db }));
vi.mock("../../offer-publish-flow.server.js", () => ({
  publishShopConfig: async () => null,
  tryPublishShop: async () => null,
  getPublishWarnings: async () => [] as string[],
  republishIfActive: async () => null,
}));

const analyticsRoute = await import("../../../routes/app.analytics._index.js");
const offerAnalyticsRoute = await import("../../../routes/app.analytics.offer.$id.js");
const logsRoute = await import("../../../routes/app.logs.js");
const debugRoute = await import("../../../routes/app.offers.$id.debug.js");

const ENV = { SENTRY_AUTH_TOKEN: "t", SENTRY_ORG: "o", SENTRY_PROJECT: "p" } as unknown as NodeJS.ProcessEnv;
let operator: Operator;
const unlimited = async () => ({ ok: true as const });

type Body = { summary: string; data: any; warnings: { code: string; message: string }[]; meta: { page?: { hasMore: boolean; cursor?: string }; dryRun?: boolean }; perShop?: { status: string }[] };

let db: Db;
let close: () => Promise<void>;
let alpha: string;
let yen: string;
let alphaOffer: string;
let otherOffer: string;
let yenOffer: string;

const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function event(shopId: string, offerId: string | null, name: string, at: Date, extra: Partial<typeof analyticsEvents.$inferInsert> = {}) {
  await db.insert(analyticsEvents).values({ shopId, offerId, eventName: name, occurredAt: at, ...extra });
}

async function connect(deps: Parameters<typeof registerReadsTools>[2] = {}) {
  const ctx: McpContext = { db, env: ENV, operator, now: () => new Date(), rateLimit: unlimited };
  const server = new McpServer({ name: "t", version: "1" });
  instrumentReadTools(server, ctx);
  registerReadsTools(server, ctx, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}
async function callTool(name: string, args: Record<string, unknown> = {}, deps?: Parameters<typeof registerReadsTools>[2]) {
  const client = await connect(deps);
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: result.structuredContent as unknown as Body };
}

const run = (fn: unknown, params: Record<string, string> = {}, url = "http://localhost/x") =>
  (fn as (a: unknown) => Promise<any>)({ request: new Request(url), params, context: {} });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  world.db = db;
  const created = await createOperatorWithPat(db, { email: "viewer@example.com", name: "Viewer", role: "viewer", shopAllowList: ["*"] }, { MCP_TOKEN_PEPPER: "test-pepper-0123456789" } as unknown as NodeJS.ProcessEnv);
  operator = { id: created.operatorId, email: "viewer@example.com", name: "Viewer", role: "viewer", shopAllowList: ["*"] };
  alpha = await seedShop(db, "alpha.myshopify.com");
  world.shopId = alpha;
  yen = await seedShop(db, "yen.myshopify.com");
  await db.update(shops).set({ currencyCode: "JPY" }).where(eq(shops.id, yen));
  alphaOffer = await seedOffer(db, alpha, { internalName: "Alpha gift", compiledConfig: { rewards: [{ code: "SAVE1234", amount: 5 }], discountCodes: ["WELCOME10"] }, functionMetafieldGid: "gid://shopify/Metafield/1" });
  otherOffer = await seedOffer(db, alpha, { internalName: "Other gift" });
  yenOffer = await seedOffer(db, yen, { internalName: "Yen gift" });

  // 3 distinct attributed orders (one delivered twice) for alpha, plus funnel events for alphaOffer.
  for (let i = 0; i < 3; i++) {
    await event(alpha, alphaOffer, "order_placed_attributed", ago(2 * HOUR + i * HOUR), { orderId: `gid://shopify/Order/${100 + i}`, properties: { subtotalCents: 5000 } });
  }
  await event(alpha, alphaOffer, "order_placed_attributed", ago(30 * 60_000), { orderId: "gid://shopify/Order/100", properties: { subtotalCents: 5000 } });
  await event(alpha, alphaOffer, "order_placed_attributed", ago(20 * DAY), { orderId: "gid://shopify/Order/999", properties: { subtotalCents: 7000 } });
  for (let i = 0; i < 10; i++) await event(alpha, alphaOffer, "promo_engine:widget_viewed", ago(3 * HOUR));
  for (let i = 0; i < 4; i++) await event(alpha, alphaOffer, "promo_engine:gift_auto_added", ago(3 * HOUR));
  for (let i = 0; i < 2; i++) await event(alpha, alphaOffer, "promo_engine:cart_mutation_error", ago(HOUR), { sessionId: "sess-secret", properties: { code: "SECRETCODE99", note: "x" } });
  await event(alpha, alphaOffer, "widget_viewed", ago(HOUR));
  await event(alpha, alphaOffer, "gift_auto_added", ago(HOUR));
  await event(alpha, otherOffer, "promo_engine:cart_mutation_error", ago(HOUR));
  // Zero-decimal shop: 3000 yen stored as 300000.
  for (let i = 0; i < 2; i++) {
    await event(yen, yenOffer, "order_placed_attributed", ago(HOUR + i * HOUR), { orderId: `gid://shopify/Order/y${i}`, properties: { subtotalCents: 300000 } });
  }
  await db.insert(cartMutationLogs).values([
    { shopId: alpha, offerId: alphaOffer, mutationType: "add_gift", source: "ajax_cart", status: "error", errorMessage: "Variant sold out for code SAVE1234" },
    { shopId: alpha, offerId: alphaOffer, mutationType: "add_gift", source: "ajax_cart", status: "success" },
    { shopId: alpha, offerId: otherOffer, mutationType: "add_gift", source: "ajax_cart", status: "error", errorMessage: "other" },
  ]);
  await db.insert(discountCodes).values({ shopId: alpha, offerId: alphaOffer, code: "SAVE1234" });
  await setOfferPublishErrors(alpha, { [alphaOffer]: "Config too large" }, db);
}, 60_000);

afterAll(async () => {
  await close();
});
beforeEach(() => {
  clearFanOutCache();
  invalidateDashboardWarningsCache(alpha);
  world.shopId = alpha;
  world.shopDomain = "alpha.myshopify.com";
});

describe("analytics_overview", () => {
  it("returns the numbers the Analytics loader computes, order ids never", async () => {
    const loader = await run(analyticsRoute.loader, {}, "http://localhost/app/analytics?days=7");
    const { isError, body } = await callTool("analytics_overview", { shops: ["alpha"], days: 7 });
    expect(JSON.stringify(body), "analytics").toBeTruthy();
    expect(isError).toBe(false);
    const shop = body.data.shops[0];
    expect(loader.orderCount).toBe(3);
    expect(shop).toMatchObject({
      orderCount: loader.orderCount,
      totalSalesCents: loader.totalSalesCents,
      avgOrderCents: loader.avgOrderCents,
      salesChartData: loader.salesChartData,
      ordersChartData: loader.ordersChartData,
    });
    expect(shop.totalSales).toEqual({ amount: "150.00", currency: "USD" });
    expect(shop.recentOrders).toHaveLength(loader.orders.length);
    expect(shop.recentOrders.map((o: { subtotal: unknown }) => o.subtotal)).toEqual(loader.orders.map((o: { totalCents: number }) => ({ amount: (o.totalCents / 100).toFixed(2), currency: "USD" })));
    expect(JSON.stringify(body)).not.toContain("gid://shopify/Order");
  });

  it("a 30 day window picks up the older order, like the loader", async () => {
    const loader = await run(analyticsRoute.loader, {}, "http://localhost/app/analytics?days=30");
    const { body } = await callTool("analytics_overview", { shops: ["alpha"], days: 30 });
    expect(loader.orderCount).toBe(4);
    expect(body.data.shops[0].totalSalesCents).toBe(loader.totalSalesCents);
    expect(body.data.shops[0].totalSalesCents).toBe(22000);
  });

  it("keeps zero-decimal currency semantics (stored x100)", async () => {
    world.shopId = yen;
    const loader = await run(analyticsRoute.loader, {}, "http://localhost/app/analytics?days=7");
    const { body } = await callTool("analytics_overview", { shops: ["yen"], days: 7 });
    const shop = body.data.shops[0];
    expect(shop.totalSalesCents).toBe(loader.totalSalesCents);
    expect(shop.totalSales).toEqual({ amount: "6000", currency: "JPY" });
    expect(shop.avgOrderValue).toEqual({ amount: "3000", currency: "JPY" });
  });

  it("covers every visible shop when none is given", async () => {
    const { body } = await callTool("analytics_overview", {});
    expect(body.data.shops.map((s: { shopDomain: string }) => s.shopDomain).sort()).toEqual(["alpha.myshopify.com", "yen.myshopify.com"]);
    expect(body.data.days).toBe(7);
  });
});

describe("analytics_offer", () => {
  it("matches the per-offer loader", async () => {
    const loader = await run(offerAnalyticsRoute.loader, { id: alphaOffer });
    const { body } = await callTool("analytics_offer", { ref: `promo:alpha:${alphaOffer}` });
    expect(body.data).toMatchObject({
      offer: loader.offer,
      funnelData: loader.funnelData,
      errorRate: loader.errorRate,
      totalEvents: loader.totalEvents,
      impressions: loader.impressions,
      giftAdds: loader.giftAdds,
      addRate: loader.addRate,
      recentEvents: loader.recentEvents,
    });
    expect(loader.impressions).toBe(10);
    expect(loader.giftAdds).toBe(4);
    expect(loader.addRate).toBe("40.0");
  });

  it("answers NOT_FOUND for an offer of another shop, as the loader 404s", async () => {
    const { isError, body } = await callTool("analytics_offer", { ref: `promo:alpha:${yenOffer}` });
    expect(isError).toBe(true);
    expect((body as unknown as { code: string }).code).toBe("NOT_FOUND");
    await expect(run(offerAnalyticsRoute.loader, { id: yenOffer })).rejects.toMatchObject({ status: 404 });
  });
});

describe("logs_query", () => {
  const issues = [
    { id: "1", shortId: "P-1", title: "Publish failed for SAVE1234 (owner@example.com)", level: "error", count: "5", userCount: 1, lastSeen: "2026-11-12T10:00:00Z", firstSeen: "2026-11-01T10:00:00Z", status: "unresolved", permalink: "https://sentry.io/1", metadata: { value: 'body {"code":"WELCOME10"}' } },
    { id: "2", shortId: "P-2", title: "Slow webhook", level: "warning", count: "2", userCount: 0, lastSeen: "2026-11-13T10:00:00Z", firstSeen: "2026-11-10T10:00:00Z", status: "unresolved", permalink: "https://sentry.io/2", metadata: {} },
  ];
  const fetchImpl = (async () => new Response(JSON.stringify(issues), { status: 200 })) as unknown as typeof fetch;

  it("returns what the Error Logs loader returns, masked, newest first", async () => {
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubEnv("SENTRY_AUTH_TOKEN", "t");
    vi.stubEnv("SENTRY_ORG", "o");
    vi.stubEnv("SENTRY_PROJECT", "p");
    const loaderData = await run(logsRoute.loader);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    const { body } = await callTool("logs_query", { shops: ["alpha"] }, { fetchImpl });
    expect(loaderData.issues).toHaveLength(2);
    expect(body.data.issues.map((i: { shortId: string }) => i.shortId)).toEqual(["P-2", "P-1"]);
    expect(body.data.totals).toEqual({ all: 2, errors: 1, warnings: 1 });
    const text = JSON.stringify(body);
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("WELCOME10");
    expect(body.data.issues.find((i: { shortId: string }) => i.shortId === "P-1").message).toContain("WE••••10");
  });

  it("filters by level and text, and paginates", async () => {
    const byLevel = await callTool("logs_query", { shops: ["alpha"], level: "warning" }, { fetchImpl });
    expect(byLevel.body.data.issues.map((i: { shortId: string }) => i.shortId)).toEqual(["P-2"]);
    const bySearch = await callTool("logs_query", { shops: ["alpha"], search: "publish failed" }, { fetchImpl });
    expect(bySearch.body.data.issues.every((i: { shortId: string }) => i.shortId === "P-1")).toBe(true);
    const page1 = await callTool("logs_query", { shops: ["alpha"], limit: 1 }, { fetchImpl });
    expect(page1.body.data.issues).toHaveLength(1);
    expect(page1.body.meta.page?.hasMore).toBe(true);
    const page2 = await callTool("logs_query", { shops: ["alpha"], limit: 1, cursor: page1.body.meta.page!.cursor }, { fetchImpl });
    expect(page2.body.data.issues.map((i: { shortId: string }) => i.shortId)).toEqual(["P-1"]);
    expect(page2.body.meta.page?.hasMore).toBe(false);
  });

  it("says so when Sentry is not configured", async () => {
    const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: unlimited };
    const server = new McpServer({ name: "t", version: "1" });
    registerReadsTools(server, ctx);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "vitest", version: "1.0.0" });
    await client.connect(c);
    const result = await client.callTool({ name: "logs_query", arguments: { shops: ["alpha"] } });
    const body = result.structuredContent as unknown as Body;
    expect(body.data.configured).toBe(false);
    expect(body.warnings.map((w) => w.code)).toContain("SENTRY_NOT_CONFIGURED");
  });
});

describe("dashboard_warnings", () => {
  it("returns the dashboard's warnings and the restorable count", async () => {
    await db.update(offers).set({ status: "archived" }).where(eq(offers.id, otherOffer));
    await recordUninstallArchive(db, alpha, [otherOffer]);
    invalidateDashboardWarningsCache(alpha);
    const direct = await getDashboardWarnings(alpha, "alpha.myshopify.com", db);
    invalidateDashboardWarningsCache(alpha);
    const { body } = await callTool("dashboard_warnings", { shops: ["alpha"] });
    expect(direct.map((w) => w.code)).toContain("app_embed_not_verified");
    expect(body.data.shops[0].warnings).toEqual(direct);
    expect(body.data.shops[0].restorableOffers).toBe(1);
    await db.update(offers).set({ status: "active" }).where(eq(offers.id, otherOffer));
  });
});

describe("promo_debug", () => {
  it("matches the debug loader and adds the publish error, codes masked", async () => {
    const loader = await run(debugRoute.loader, { id: alphaOffer });
    const { body } = await callTool("promo_debug", { ref: `promo:alpha:${alphaOffer}` });
    expect(body.data.offer).toMatchObject({ id: alphaOffer, metafieldStatus: loader.offer.metafieldStatus, configSize: loader.offer.configSize, hasCompiledConfig: true });
    expect(body.data.eventStats).toEqual(loader.eventStats);
    expect(loader.eventStats).toEqual({ widgetViewed: 1, giftAutoAdded: 1, errors: 2 });
    expect(body.data.recentErrors).toHaveLength(loader.recentErrors.length);
    expect(body.data.mutationErrors).toHaveLength(loader.mutationErrors.length);
    expect(body.data.publishError).toBe("Config too large");
    expect(body.warnings.map((w) => w.code)).toContain("PUBLISH_ERROR");
    const text = JSON.stringify(body);
    for (const secret of ["SAVE1234", "WELCOME10", "SECRETCODE99", "sess-secret"]) expect(text).not.toContain(secret);
    expect(body.data.compiledConfig.rewards[0].code).toBe("SA••••34");
  });

  it("can skip the compiled config", async () => {
    const { body } = await callTool("promo_debug", { ref: `promo:alpha:${alphaOffer}`, includeCompiledConfig: false });
    expect(body.data.compiledConfig).toBeNull();
  });
});

describe("promo_debug_clear_logs", () => {
  it("dryRun counts without deleting, then the write clears only that offer's error rows and audits it", async () => {
    const ref = `promo:alpha:${alphaOffer}`;
    const dry = await callTool("promo_debug_clear_logs", { ref, dryRun: true });
    expect(dry.body.meta.dryRun).toBe(true);
    expect(dry.body.data.wouldDelete).toEqual({ cartMutationErrors: 1, errorEvents: 2 });
    const before = await run(debugRoute.loader, { id: alphaOffer });
    expect(before.eventStats.errors).toBe(2);

    const done = await callTool("promo_debug_clear_logs", { ref });
    expect(done.isError).toBe(false);
    expect(done.body.data.deleted).toEqual({ cartMutationErrors: 1, errorEvents: 2 });

    const after = await run(debugRoute.loader, { id: alphaOffer });
    expect(after.recentErrors).toEqual([]);
    expect(after.mutationErrors).toEqual([]);
    expect(after.eventStats.errors).toBe(0);
    // Other offer's errors and the offer's successful mutation survive.
    const other = await db.select().from(cartMutationLogs).where(eq(cartMutationLogs.offerId, otherOffer));
    expect(other).toHaveLength(1);
    const kept = await db.select().from(cartMutationLogs).where(and(eq(cartMutationLogs.offerId, alphaOffer), eq(cartMutationLogs.status, "success")));
    expect(kept).toHaveLength(1);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, alphaOffer), eq(auditLogs.action, "debug_logs_cleared")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.performedBy).toBe(`mcp:${operator.id}`);
  });

  it("the route action clears the same rows (clear_logs intent)", async () => {
    await event(alpha, otherOffer, "promo_engine:cart_mutation_error", ago(HOUR));
    const request = new Request("http://localhost/x", { method: "POST", body: new URLSearchParams({ intent: "clear_logs" }) });
    const res = await (debugRoute.action as unknown as (a: unknown) => Promise<{ ok: boolean }>)({ request, params: { id: otherOffer }, context: {} });
    expect(res.ok).toBe(true);
    const left = await db.select().from(analyticsEvents).where(and(eq(analyticsEvents.offerId, otherOffer), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error")));
    expect(left).toHaveLength(0);
  });

  it("is NOT_FOUND for an offer of another shop and writes nothing", async () => {
    const { isError, body } = await callTool("promo_debug_clear_logs", { ref: `promo:alpha:${yenOffer}` });
    expect(isError).toBe(true);
    expect((body as unknown as { code: string }).code).toBe("NOT_FOUND");
  });
});

describe("theme_installation_status", () => {
  const settings = (disabled: boolean) => `/* comment */\n${JSON.stringify({ current: { blocks: { a: { type: "shopify://apps/promo-engine-hpn/blocks/app_embed/abc", disabled } } } })}`;
  const node = (id: string, name: string, role: string, content?: string) => ({ id, name, role, files: { nodes: content ? [{ body: { content } }] : [] } });

  it("reports enabled, disabled and unknown per theme through the injected fetcher", async () => {
    const fetchThemes: ThemeFetcher = async (shop, roles) => {
      expect(shop.myshopifyDomain).toBe("alpha.myshopify.com");
      expect(roles).toEqual(["MAIN", "UNPUBLISHED"]);
      return listThemeEmbedStatus(async () => ({
        data: { themes: { nodes: [node("gid://shopify/OnlineStoreTheme/1", "Live", "MAIN", settings(false)), node("gid://shopify/OnlineStoreTheme/2", "Draft", "UNPUBLISHED", settings(true)), node("gid://shopify/OnlineStoreTheme/3", "Empty", "UNPUBLISHED")] } },
      }), roles);
    };
    const { body } = await callTool("theme_installation_status", { shops: ["alpha"], roles: ["MAIN", "UNPUBLISHED"] }, { fetchThemes });
    const themes = body.data.shops[0].themes;
    expect(themes.map((t: { name: string; status: string }) => [t.name, t.status])).toEqual([["Live", "enabled"], ["Draft", "disabled"], ["Empty", "unknown"]]);
    expect(body.warnings.map((w) => w.code)).toContain("EMBED_NOT_ENABLED");
  });

  it("one shop failing does not hide the others", async () => {
    const fetchThemes: ThemeFetcher = async (shop) => {
      if (shop.myshopifyDomain === "yen.myshopify.com") throw new Error("boom");
      return [{ themeId: "1", name: "Live", role: "MAIN", status: "enabled", detail: "ok" }];
    };
    const { body } = await callTool("theme_installation_status", {}, { fetchThemes });
    expect(body.data.shops).toHaveLength(1);
    expect(body.perShop!.map((p) => p.status).sort()).toEqual(["error", "ok"]);
    expect(body.warnings.map((w) => w.code)).toContain("SHOP_FAILED");
  });

  it("the Installation page check keeps its verdicts and sentences", async () => {
    const run = (content?: string) => checkPublishedThemeEmbed(async () => ({ data: { themes: { nodes: [node("gid://shopify/OnlineStoreTheme/9", "Live", "MAIN", content)] } } }), "alpha.myshopify.com");
    expect(await run(settings(false))).toEqual({ appEmbedStatus: "enabled", activeThemeId: "gid://shopify/OnlineStoreTheme/9", statusDetail: "The published theme settings were read successfully." });
    expect((await run(settings(true))).statusDetail).toBe("The published theme settings confirm that the Promo Engine app embed is not active.");
    expect(await run(undefined)).toMatchObject({ appEmbedStatus: "unknown", statusDetail: "The published theme settings file was unavailable." });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = await checkPublishedThemeEmbed(async () => ({ errors: [{ message: "denied" }] }), "alpha.myshopify.com");
    expect(failed).toEqual({ appEmbedStatus: "unknown", activeThemeId: "", statusDetail: "Shopify did not return a verifiable app embed status." });
    warn.mockRestore();
  });
});

describe("registration", () => {
  it("lists the seven tools; the six reads are read-only and clear_logs is not", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["analytics_overview", "analytics_offer", "logs_query", "dashboard_warnings", "promo_debug", "theme_installation_status"]) {
      expect(by[name]?.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(by["promo_debug_clear_logs"]?.annotations?.readOnlyHint).toBe(false);
  });
});

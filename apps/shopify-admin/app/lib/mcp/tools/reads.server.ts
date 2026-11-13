/**
 * MCP read tools for the admin's analytics, logs, dashboard, debug and theme-installation pages (FIX-mcpfa-17).
 * Every query lives in a shared service (analytics-queries, logs-queries, offer-debug, dashboard-warnings,
 * theme-installation) that the route loaders call too, so the UI and the MCP always report the same numbers.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { discountCodes, shops, type Db } from "@promo/db";
import { insertAuditLog } from "../../audit-log.server.js";
import { loadAnalyticsOverview, loadOfferAnalytics } from "../../analytics-queries.server.js";
import { getDashboardWarnings } from "../../dashboard-warnings.server.js";
import { fetchShopSentryIssues, type SentryIssue } from "../../logs-queries.server.js";
import { clearOfferDebugLogs, countOfferDebugLogs, loadOfferDebug } from "../../offer-debug.server.js";
import { getOfferPublishErrors } from "../../offer-publish-errors.server.js";
import { getRestorableOffers } from "../../restore-archived-offers.contract.server.js";
import { shopifyGraphQL } from "../../shopify-fetch.server.js";
import { listThemeEmbedStatus, type ThemeEmbedStatus, type ThemeQueryResult } from "../../theme-installation.server.js";
import { decryptToken } from "../../token-crypto.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { fanOut, type ShopRef } from "../multi-shop.server.js";
import { ToolError, buildResult, moneyFromMinor, promoRef, shopHandle, type Money, type PerShop, type ToolResult, type Warning } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type CallInfo } from "../write-runner.server.js";
import { adminLink, maskCode, paginate, pagingInput, resolvePromoRef, shopsInput } from "./catalog-shared.server.js";
import { sanitizeAuditJson } from "./promo-audit-log.server.js";

const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};

export const analyticsOverviewInput = {
  shops: shopsInput,
  days: z.number().int().min(1).max(365).optional().describe("Window in days ending now, 1-365 (default 7), as the Analytics page's ?days=."),
};
export const analyticsOfferInput = { ...refFields };
export const logsQueryInput = {
  shops: shopsInput,
  level: z.enum(["fatal", "error", "warning", "info", "debug"]).optional().describe("Only issues of this Sentry level."),
  search: z.string().trim().max(200).optional().describe("Case-insensitive text that must appear in the issue title or message."),
  ...pagingInput,
};
export const dashboardWarningsInput = { shops: shopsInput };
export const promoDebugInput = {
  ...refFields,
  includeCompiledConfig: z.boolean().optional().describe("Include the compiled Function config JSON (default true; it can be several KB)."),
};
export const promoDebugClearLogsInput = {
  ...refFields,
  dryRun: z.boolean().optional().describe("Optional preview (default false): counts the rows that would be deleted, nothing is written."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
export const THEME_ROLES = ["MAIN", "UNPUBLISHED", "DEMO", "DEVELOPMENT"] as const;
export const themeInstallationStatusInput = {
  shops: shopsInput,
  roles: z.array(z.enum(THEME_ROLES)).min(1).max(4).optional().describe("Theme roles to check (default [MAIN], the published theme). Each theme costs one settings file read."),
};

const iso = (d: Date) => d.toISOString();
const noTimeout = { concurrency: 3, timeoutMs: 30_000 } as const;

function perShopRows(perShop: PerShop[]): Warning[] {
  return perShop
    .filter((p) => p.status === "error")
    .map((p) => ({ code: "SHOP_FAILED", severity: "warn" as const, message: `${p.shopHandle}: ${p.reason ?? "error"}; its rows are missing from this result.` }));
}

export type OverviewShop = {
  shopDomain: string;
  currency: string;
  days: number;
  orderCount: number;
  totalSalesCents: number;
  avgOrderCents: number;
  totalSales: Money;
  avgOrderValue: Money;
  salesChartData: { x: string; y: number }[];
  ordersChartData: { x: string; y: number }[];
  recentOrders: { id: string; date: string; offerName: string; subtotal: Money }[];
};

/** What the Analytics index shows, per shop. Order ids are never returned (same rule as promo_performance). */
export async function analyticsOverview(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; days?: number },
  now: () => Date,
): Promise<ToolResult<{ days: number; shops: OverviewShop[] }>> {
  const days = args.days ?? 7;
  const selected = selectShops(visible, args.shops);
  const { perShop, results } = await fanOut(
    selected,
    async (shop): Promise<OverviewShop> => {
      const o = await loadAnalyticsOverview(db, shop.id, days, now);
      return {
        shopDomain: shop.myshopifyDomain,
        currency: shop.currencyCode,
        days: o.days,
        orderCount: o.orderCount,
        totalSalesCents: o.totalSalesCents,
        avgOrderCents: o.avgOrderCents,
        totalSales: moneyFromMinor(o.totalSalesCents, shop.currencyCode),
        avgOrderValue: moneyFromMinor(o.avgOrderCents, shop.currencyCode),
        salesChartData: o.salesChartData,
        ordersChartData: o.ordersChartData,
        recentOrders: o.orders.map((r) => ({ id: r.id, date: r.date, offerName: r.giftName, subtotal: moneyFromMinor(r.totalCents, shop.currencyCode) })),
      };
    },
    noTimeout,
  );
  const rows = results.map((r) => r.value);
  return buildResult(
    {
      summary: [
        `Analytics for the last ${days} day(s) across ${rows.length} shop(s).`,
        ...rows.map((r) => `- ${shopHandle(r.shopDomain)}: ${r.orderCount} attributed order(s), ${r.totalSales.amount} ${r.totalSales.currency} sales, AOV ${r.avgOrderValue.amount}.`),
      ].join("\n"),
      data: { days, shops: rows },
      perShop,
      warnings: perShopRows(perShop),
      nextActions: [{ mcp: "promo-engine", tool: "promo_performance", args: { lastDays: Math.min(days, 90), groupBy: "offer" }, why: "Break these numbers down by offer.", risk: "read" }],
      meta: { window: { start: iso(new Date(now().getTime() - days * 86_400_000)), end: iso(now()) } },
    },
    now,
  );
}

/** The per-offer analytics page: 30-day funnel, error rate and the last 10 events. */
export async function analyticsOffer(
  db: Db,
  visible: VisibleShop[],
  args: { ref?: string; shop?: string },
  now: () => Date,
) {
  const { shop, offerId } = resolvePromoRef(visible, args);
  const analytics = await loadOfferAnalytics(db, shop.id, offerId, now);
  if (!analytics) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
  const ref = promoRef(shop.myshopifyDomain, offerId);
  const { offer, ...rest } = analytics;
  return buildResult(
    {
      summary: `"${offer.internalName.replace(/\s+/g, " ").slice(0, 80)}" (${ref}, ${offer.status}): ${analytics.impressions} view(s), ${analytics.giftAdds} gift add(s) (${analytics.addRate}%), error rate ${analytics.errorRate}% over ${analytics.totalEvents} event(s), last 30 days.`,
      data: { promoRef: ref, offer, ...rest, window: "last 30 days" },
      links: [adminLink(shopHandle(shop.myshopifyDomain))],
      nextActions: [
        { mcp: "promo-engine", tool: "promo_debug", args: { ref }, why: "Inspect the compiled config and recent errors.", risk: "read" },
      ],
    },
    now,
  );
}

export type LogRow = Omit<SentryIssue, "title" | "metadata"> & { shopDomain: string; title: string; message: string | null };

/** Issue text can echo a discount code or an email: masked exactly like promo_audit_log does. */
function maskText(value: string | undefined): string | null {
  return typeof value === "string" ? (sanitizeAuditJson(value) as string) : null;
}

/** The Error Logs page (the shop's unresolved Sentry issues), filtered and paginated. */
export async function logsQuery(
  visible: VisibleShop[],
  args: { shops?: string[]; level?: SentryIssue["level"]; search?: string; cursor?: string; limit?: number },
  env: NodeJS.ProcessEnv,
  now: () => Date,
  fetchImpl?: typeof fetch,
) {
  const selected = selectShops(visible, args.shops);
  const { perShop, results } = await fanOut(selected, async (shop) => ({ shop, logs: await fetchShopSentryIssues(shop.myshopifyDomain, env, fetchImpl) }), noTimeout);
  const warnings: Warning[] = perShopRows(perShop);
  const rows: LogRow[] = [];
  let configured = true;
  for (const { value } of results) {
    if (!value.logs.configured) {
      configured = false;
      continue;
    }
    if (value.logs.error) warnings.push({ code: "SENTRY_ERROR", severity: "warn", message: `${shopHandle(value.shop.myshopifyDomain)}: ${maskText(value.logs.error)}` });
    for (const issue of value.logs.issues) {
      const { title, metadata, ...rest } = issue;
      rows.push({ ...rest, shopDomain: value.shop.myshopifyDomain, title: maskText(title) ?? "", message: maskText(metadata?.value) });
    }
  }
  if (!configured) {
    warnings.push({ code: "SENTRY_NOT_CONFIGURED", severity: "info", message: "SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are not all set on the server, so there are no logs to read." });
  }
  const needle = args.search?.toLowerCase();
  const filtered = rows
    .filter((r) => (args.level ? r.level === args.level : true))
    .filter((r) => (needle ? `${r.title} ${r.message ?? ""}`.toLowerCase().includes(needle) : true))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const { page, hasMore, cursor } = paginate(filtered, args);
  const count = (levels: string[]) => filtered.filter((r) => levels.includes(r.level)).length;
  return buildResult(
    {
      summary: [
        `${filtered.length} unresolved issue(s) (${count(["error", "fatal"])} error, ${count(["warning"])} warning); showing ${page.length}.`,
        ...page.slice(0, 8).map((r) => `- [${r.level}] ${shopHandle(r.shopDomain)} ${r.shortId}: ${r.title.slice(0, 100)} (x${r.count}, last ${r.lastSeen.slice(0, 16)})`),
        hasMore ? "More issues are available with the cursor." : "",
      ].filter(Boolean).join("\n"),
      data: { issues: page, totals: { all: filtered.length, errors: count(["error", "fatal"]), warnings: count(["warning"]) }, configured },
      perShop,
      warnings,
      meta: { page: { hasMore, ...(cursor ? { cursor } : {}) } },
    },
    now,
  );
}

/** The dashboard's warnings plus the "restore offers archived at uninstall" banner count, per shop. */
export async function dashboardWarnings(db: Db, visible: VisibleShop[], args: { shops?: string[] }, now: () => Date) {
  const selected = selectShops(visible, args.shops);
  const { perShop, results } = await fanOut(
    selected,
    async (shop) => {
      const [warnings, restorable] = await Promise.all([
        getDashboardWarnings(shop.id, shop.myshopifyDomain, db),
        getRestorableOffers(db, shop.id),
      ]);
      return { shopDomain: shop.myshopifyDomain, warnings, restorableOffers: restorable.count };
    },
    noTimeout,
  );
  const rows = results.map((r) => r.value);
  const total = rows.reduce((n, r) => n + r.warnings.length, 0);
  return buildResult(
    {
      summary: [
        `${total} dashboard warning(s) across ${rows.length} shop(s).`,
        ...rows.map((r) => `- ${shopHandle(r.shopDomain)}: ${r.warnings.length ? r.warnings.map((w) => `${w.severity}:${w.code}`).join(", ") : "none"}${r.restorableOffers ? `; ${r.restorableOffers} archived offer(s) can be restored (Restore offers page)` : ""}`),
      ].join("\n"),
      data: { shops: rows },
      perShop,
      warnings: perShopRows(perShop),
      nextActions: [{ mcp: "promo-engine", tool: "promo_health", args: {}, why: "Prioritized offer-level problems.", risk: "read" }],
    },
    now,
  );
}

/** Code-looking values (keys code, codes, discountCode(s), requestedCode) become AB••••12 inside any JSON. */
export function maskCodesDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskCodesDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(code|codes|discount[_-]?codes?|requested[_-]?code)$/i.test(key)) {
        out[key] = typeof v === "string" ? maskCode(v) : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? maskCode(x) : maskCodesDeep(x))) : maskCodesDeep(v);
      } else out[key] = maskCodesDeep(v);
    }
    return out;
  }
  return value;
}

/** The debug page: compiled Function config, publish error, recent evaluation errors and 7-day event counts. */
export async function promoDebug(
  db: Db,
  visible: VisibleShop[],
  args: { ref?: string; shop?: string; includeCompiledConfig?: boolean },
  now: () => Date,
) {
  const { shop, offerId } = resolvePromoRef(visible, args);
  const debug = await loadOfferDebug(db, shop.id, offerId, now);
  if (!debug) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
  const publishError = (await getOfferPublishErrors(shop.id, db))[offerId] ?? null;
  // Error text can quote a plain code ("Discount code X is not valid"): mask this offer's own codes everywhere.
  const ownCodes = (
    await db.select({ code: discountCodes.code, requested: discountCodes.requestedCode }).from(discountCodes)
      .where(and(eq(discountCodes.shopId, shop.id), eq(discountCodes.offerId, offerId))).limit(1000)
  ).flatMap((r) => [r.code, r.requested]).filter((c): c is string => !!c && c.length >= 3);
  const maskOwn = (text: string | null): string | null =>
    text === null ? null : ownCodes.reduce((acc, code) => acc.split(code).join(maskCode(code)), text);
  const maskDebug = (text: string | undefined): string | null => maskOwn(maskText(text));
  const ref = promoRef(shop.myshopifyDomain, offerId);
  const { compiledConfigJson, ...offer } = debug.offer;
  const includeConfig = args.includeCompiledConfig !== false;
  const warnings: Warning[] = [];
  if (publishError) warnings.push({ code: "PUBLISH_ERROR", severity: "warn", message: maskDebug(publishError) ?? "" });
  if (offer.metafieldStatus === "error") warnings.push({ code: "NO_METAFIELD", severity: "warn", message: "The offer has no Function metafield yet (never published or the publish failed)." });
  return buildResult(
    {
      summary: `Debug for "${offer.internalName.replace(/\s+/g, " ").slice(0, 80)}" (${ref}, ${offer.status}): metafield ${offer.metafieldStatus}, config ${offer.configSize} chars, ${debug.eventStats.errors} error event(s) in 7 days${publishError ? "; has a publish error" : ""}.`,
      data: {
        promoRef: ref,
        offer,
        publishError: maskDebug(publishError ?? undefined),
        compiledConfig: includeConfig && compiledConfigJson ? maskCodesDeep(JSON.parse(compiledConfigJson)) : null,
        recentErrors: debug.recentErrors.map((e) => ({ occurred: e.occurred, eventName: e.eventName, properties: maskDebug(e.properties) })),
        mutationErrors: debug.mutationErrors.map((e) => ({ created: e.created, type: e.type, error: maskDebug(e.error), source: e.source })),
        eventStats: debug.eventStats,
      },
      links: [adminLink(shopHandle(shop.myshopifyDomain))],
      warnings,
      nextActions: [
        { mcp: "promo-engine", tool: "promo_debug_clear_logs", args: { ref }, why: "Clear this offer's error logs after fixing the cause.", risk: "write" },
        { mcp: "promo-engine", tool: "promos_republish_shop", args: { shop: shop.myshopifyDomain }, why: "Republish the shop's config to Shopify.", risk: "write" },
      ],
    },
    now,
  );
}

/** Write tool: deletes the offer's error logs (the debug page's "Clear logs"). dryRun:true counts them. */
export async function promoDebugClearLogs(
  ctx: McpContext,
  call: CallInfo,
  args: { ref?: string; shop?: string; dryRun?: boolean; idempotencyKey?: string },
): Promise<CallToolResult> {
  const started = performance.now();
  let target: { shop: VisibleShop; offerId: string; name: string };
  try {
    const { shop, offerId } = resolvePromoRef(await visibleShops(ctx.db, ctx.operator), args);
    const debug = await loadOfferDebug(ctx.db, shop.id, offerId, ctx.now);
    if (!debug) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
    target = { shop, offerId, name: debug.offer.internalName };
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool: "promo_debug_clear_logs", shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
  const { shop, offerId, name } = target;
  const ref = promoRef(shop.myshopifyDomain, offerId);
  const label = name.replace(/\s+/g, " ").slice(0, 80);
  return runWrite(ctx, call, {
    tool: "promo_debug_clear_logs",
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: [shop],
    preview: async () => {
      const counts = await countOfferDebugLogs(ctx.db, shop.id, offerId);
      return {
        summary: `Would delete ${counts.cartMutationErrors} cart mutation error log(s) and ${counts.errorEvents} error event(s) of "${label}" (${ref}).`,
        data: { promoRef: ref, wouldDelete: counts },
        links: [adminLink(shopHandle(shop.myshopifyDomain))],
        offerUpdatedAt: null,
      };
    },
    apply: async (a) => {
      const deleted = await clearOfferDebugLogs(ctx.db, shop.id, offerId);
      await insertAuditLog(ctx.db, {
        shopId: shop.id,
        entityType: "offer",
        entityId: offerId,
        action: "debug_logs_cleared",
        before: null,
        after: { ...deleted, ...a.auditExtra },
        performedBy: a.performedBy,
      });
      return {
        summary: `Cleared ${deleted.cartMutationErrors} cart mutation error log(s) and ${deleted.errorEvents} error event(s) of "${label}" (${ref}).`,
        data: { promoRef: ref, deleted },
        nextActions: [{ mcp: "promo-engine", tool: "promo_debug", args: { ref }, why: "Confirm the logs are gone.", risk: "read" }],
      };
    },
  });
}

export type ThemeFetcher = (shop: ShopRef, roles: readonly string[]) => Promise<ThemeEmbedStatus[]>;

/** Reads the themes' settings through the shop's offline token (the same query the Installation page runs). */
export function themeFetcherFor(db: Db): ThemeFetcher {
  return async (shop, roles) => {
    const [row] = await db.select({ token: shops.accessTokenEncrypted }).from(shops).where(eq(shops.id, shop.id)).limit(1);
    if (!row) throw new Error("shop not found");
    const accessToken = await decryptToken(row.token);
    return listThemeEmbedStatus(
      async (query) => ({ data: await shopifyGraphQL<NonNullable<ThemeQueryResult["data"]>>({ shopDomain: shop.myshopifyDomain, accessToken, query }) }),
      roles,
    );
  };
}

/** Is the Promo Engine app embed on in each theme (default: the published one)? */
export async function themeInstallationStatus(
  visible: VisibleShop[],
  args: { shops?: string[]; roles?: (typeof THEME_ROLES)[number][] },
  fetchThemes: ThemeFetcher,
  now: () => Date,
) {
  const roles = args.roles ?? ["MAIN"];
  const selected = selectShops(visible, args.shops);
  const { perShop, results } = await fanOut(
    selected,
    async (shop) => ({ shopDomain: shop.myshopifyDomain, themes: await fetchThemes(shop, roles), themeEditorUrl: `https://admin.shopify.com/store/${shopHandle(shop.myshopifyDomain)}/themes` }),
    noTimeout,
  );
  const rows = results.map((r) => r.value);
  const off = rows.flatMap((r) => r.themes.filter((t) => t.status !== "enabled").map((t) => `${shopHandle(r.shopDomain)}/${t.name}`));
  return buildResult(
    {
      summary: [
        `App embed status for ${rows.length} shop(s), roles ${roles.join(", ")}.`,
        ...rows.flatMap((r) => r.themes.length ? r.themes.map((t) => `- ${shopHandle(r.shopDomain)} / ${t.name} (${t.role ?? "?"}): ${t.status}`) : [`- ${shopHandle(r.shopDomain)}: no theme with those roles`]),
      ].join("\n"),
      data: { shops: rows },
      perShop,
      warnings: [
        ...perShopRows(perShop),
        ...(off.length ? [{ code: "EMBED_NOT_ENABLED", severity: "warn" as const, message: `The app embed is not confirmed enabled in: ${off.join(", ")}. Widgets and gifts do not show until a merchant enables it in the theme editor (App embeds).` }] : []),
      ],
    },
    now,
  );
}

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool, type McpContext } from "../server.server.js";
import { visibleShops } from "../shops.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  analyticsOffer,
  analyticsOfferInput,
  analyticsOverview,
  analyticsOverviewInput,
  dashboardWarnings,
  dashboardWarningsInput,
  logsQuery,
  logsQueryInput,
  promoDebug,
  promoDebugClearLogs,
  promoDebugClearLogsInput,
  promoDebugInput,
  themeFetcherFor,
  themeInstallationStatus,
  themeInstallationStatusInput,
  type ThemeFetcher,
} from "./reads.server.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

/** Analytics, logs, dashboard, debug and theme-installation reads (+ clearing an offer's debug logs). */
export function registerReadsTools(
  server: McpServer,
  ctx: McpContext,
  deps: { fetchThemes?: ThemeFetcher; fetchImpl?: typeof fetch } = {},
): void {
  const visible = () => visibleShops(ctx.db, ctx.operator);
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "analytics_overview",
    {
      title: "Analytics overview",
      description:
        "What the admin Analytics page shows, per shop: attributed orders, total sales and average order value in the shop currency, a per-day sales and orders series over the window, and the 50 latest attributed orders (offer name, date, subtotal; order ids are never returned). days is 1-365, default 7. Example: {\"days\": 30}. For a per-offer breakdown use promo_performance.",
      inputSchema: analyticsOverviewInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => analyticsOverview(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "analytics_offer",
    {
      title: "Offer analytics",
      description:
        "The per-offer analytics page: 30-day funnel (widget viewed, qualified, gift added, checkout started, order placed), error rate, gift add rate and the 10 latest events. Example: {\"ref\": \"promo:hpn:<offerId>\"}.",
      inputSchema: analyticsOfferInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => analyticsOffer(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "logs_query",
    {
      title: "Error logs",
      description:
        "The admin Error Logs page: each shop's unresolved Sentry issues (level, count, users, first/last seen, link), newest first, with optional level and text filters and a cursor. Issue text is masked like promo_audit_log (codes, emails). Says so when Sentry is not configured on the server. Example: {\"level\": \"error\", \"search\": \"publish\", \"limit\": 20}.",
      inputSchema: logsQueryInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runTool(async () => logsQuery(await visible(), args, ctx.env, ctx.now, deps.fetchImpl)),
  );

  server.registerTool(
    "dashboard_warnings",
    {
      title: "Dashboard warnings",
      description:
        "The warnings the admin dashboard shows per shop (app embed not verified, out-of-stock gifts, incompatible combinations, stale caches, ...) with severity and the page that fixes each, plus how many offers archived at uninstall can be restored.",
      inputSchema: dashboardWarningsInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => dashboardWarnings(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "promo_debug",
    {
      title: "Offer debug",
      description:
        "The offer's debug page: Function metafield status, compiled config (JSON; discount codes masked), the offer's publish error, recent evaluation errors (analytics + cart mutation logs) and 7-day event counts. Set includeCompiledConfig:false to skip the config. Example: {\"ref\": \"promo:hpn:<offerId>\"}. Republish with promos_republish_shop.",
      inputSchema: promoDebugInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => promoDebug(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "promo_debug_clear_logs",
    {
      title: "Clear offer debug logs",
      description:
        "Deletes the offer's error logs (failed cart mutations and their cart_mutation_error analytics events), like the debug page's Clear logs. Offer and Shopify config are untouched. dryRun:true counts the rows without deleting. Example: {\"ref\": \"promo:hpn:<offerId>\"}.",
      inputSchema: promoDebugClearLogsInput,
      annotations: WRITE,
    },
    (args, extra) => promoDebugClearLogs(ctx, call(extra), args),
  );

  server.registerTool(
    "theme_installation_status",
    {
      title: "Theme installation status",
      description:
        "Is the Promo Engine app embed enabled in each theme (the Installation page's check)? Reads config/settings_data.json of the themes with the given roles (default [MAIN] = published) through the shop's Admin API: one small query per shop. Status is enabled, disabled or unknown (file unreadable). Example: {\"roles\": [\"MAIN\", \"UNPUBLISHED\"]}.",
      inputSchema: themeInstallationStatusInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runTool(async () => themeInstallationStatus(await visible(), args, deps.fetchThemes ?? themeFetcherFor(ctx.db), ctx.now)),
  );
}

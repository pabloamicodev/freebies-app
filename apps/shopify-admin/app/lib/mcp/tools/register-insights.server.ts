import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool, type McpContext } from "../server.server.js";
import { visibleShops } from "../shops.server.js";
import { mcpWhoami, mcpWhoamiInput } from "./mcp-whoami.server.js";
import { promoAuditLog, promoAuditLogInput } from "./promo-audit-log.server.js";
import { promoHealth, promoHealthInput } from "./promo-health.server.js";
import { promoPerformance, promoPerformanceInput } from "./promo-performance.server.js";
import { suggestPromoTests, suggestPromoTestsInput } from "./suggest-promo-tests.server.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Phase 1 insight tools (1.3 and 1.5): performance, audit log, health, whoami and test suggestions. */
export function registerInsightsTools(server: McpServer, ctx: McpContext): void {
  const visible = () => visibleShops(ctx.db, ctx.operator);

  server.registerTool(
    "mcp_whoami",
    {
      title: "Who am I",
      description: "Your operator, role, the shops you can see and each shop's writeMode (read_only | write).",
      inputSchema: mcpWhoamiInput,
      annotations: READ_ONLY,
    },
    () => runTool(async () => mcpWhoami(ctx.db, ctx.operator, await visible(), ctx.env, ctx.now)),
  );

  server.registerTool(
    "promo_performance",
    {
      title: "Promo performance",
      description:
        "Aggregated funnel for offers over a window of up to 90 days (start/end ISO or lastDays), grouped by offer, day or type: views, adds, checkouts, attributed orders, revenue, discount given and AOV per currency (never converted). Rates are recomputed from summed counts and are null when the denominator is 0. dataQuality lists which events are missing.",
      inputSchema: promoPerformanceInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => promoPerformance(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "promo_audit_log",
    {
      title: "Promo audit log",
      description:
        "Who changed which offer and when (merchant, system and MCP actors), newest first, with readable before/after and changed fields. Secrets and PII keys are stripped. Defaults to the last 30 days.",
      inputSchema: promoAuditLogInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => promoAuditLog(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "promo_health",
    {
      title: "Promo health",
      description:
        "Prioritized problems: offers with publish errors, offers the system paused, publishes waiting to retry, drift (missing discount nodes, uncompiled or mis-scheduled offers). Each finding links to the next read tool.",
      inputSchema: promoHealthInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => promoHealth(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "suggest_promo_tests",
    {
      title: "Suggest promo tests",
      description:
        "Promo-side context to design tests with the Experiment Engine MCP: active promos with performance, gaps (gift without limit, bundle without tiers, gift threshold near AOV), the shop's experiment directory, offers already bound to a test group, and candidates in the shared TestIdea shape with nextActions (mcp: experiment-engine). Does not call the Experiment Engine; join by shopDomain.",
      inputSchema: suggestPromoTestsInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => suggestPromoTests(ctx.db, await visible(), args, ctx.now)),
  );
}

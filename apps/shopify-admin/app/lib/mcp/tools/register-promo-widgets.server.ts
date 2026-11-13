import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import { runTool } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  WIDGET_TOOL_DOCS,
  boostersList,
  boostersListInput,
  boostersSet,
  boostersSetInput,
  promoWidgetDelete,
  promoWidgetDeleteInput,
  promoWidgetSetEnabled,
  promoWidgetSetEnabledInput,
  promoWidgetSetMarketOverrides,
  promoWidgetSetMarketOverridesInput,
  promoWidgetUpsert,
  promoWidgetUpsertInput,
  promoWidgetsList,
  promoWidgetsListInput,
} from "./promo-widgets.server.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** Widgets, per-market widget overrides and boosters (admin: widget editor, Markets page, Boosters page). */
export function registerPromoWidgetsTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_widgets_list",
    { title: "List an offer's widgets", description: WIDGET_TOOL_DOCS.list, inputSchema: promoWidgetsListInput, annotations: READ_ONLY },
    (args) => runTool(() => promoWidgetsList(ctx, args)),
  );
  server.registerTool(
    "promo_widget_upsert",
    { title: "Add a widget to an offer", description: `${WIDGET_TOOL_DOCS.upsert} dryRun:true previews the outcome without writing anything.`, inputSchema: promoWidgetUpsertInput, annotations: WRITE },
    (args, extra) => promoWidgetUpsert(ctx, call(extra), args),
  );
  server.registerTool(
    "promo_widget_set_enabled",
    { title: "Enable or disable a widget", description: `${WIDGET_TOOL_DOCS.setEnabled} dryRun:true previews the outcome without writing anything.`, inputSchema: promoWidgetSetEnabledInput, annotations: WRITE },
    (args, extra) => promoWidgetSetEnabled(ctx, call(extra), args),
  );
  server.registerTool(
    "promo_widget_delete",
    { title: "Delete a widget", description: `${WIDGET_TOOL_DOCS.delete} dryRun:true previews the outcome without writing anything.`, inputSchema: promoWidgetDeleteInput, annotations: DESTRUCTIVE },
    (args, extra) => promoWidgetDelete(ctx, call(extra), args),
  );
  server.registerTool(
    "promo_widget_set_market_overrides",
    { title: "Set per-market widget overrides", description: `${WIDGET_TOOL_DOCS.setMarketOverrides} dryRun:true previews the outcome without writing anything.`, inputSchema: promoWidgetSetMarketOverridesInput, annotations: WRITE },
    (args, extra) => promoWidgetSetMarketOverrides(ctx, call(extra), args),
  );
  server.registerTool(
    "boosters_list",
    { title: "List boosters", description: WIDGET_TOOL_DOCS.boostersList, inputSchema: boostersListInput, annotations: READ_ONLY },
    (args) => runTool(() => boostersList(ctx, args)),
  );
  server.registerTool(
    "boosters_set",
    { title: "Enable or disable a booster widget", description: `${WIDGET_TOOL_DOCS.boostersSet} dryRun:true previews the outcome without writing anything.`, inputSchema: boostersSetInput, annotations: WRITE },
    (args, extra) => boostersSet(ctx, call(extra), args),
  );
}

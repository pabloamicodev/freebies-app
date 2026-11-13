import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool, type McpContext } from "../server.server.js";
import { visibleShops } from "../shops.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  capacityIncidentApplyInput,
  capacityIncidentApplyTool,
  capacityIncidentDismissInput,
  capacityIncidentDismissTool,
  capacityIncidentSnoozeInput,
  capacityIncidentSnoozeTool,
  capacityIncidentUndoInput,
  capacityIncidentUndoTool,
  capacityIncidentsList,
  capacityIncidentsListInput,
  type CapacityToolDeps,
} from "./capacity-incidents.server.js";
import { diagnosticsGet, diagnosticsGetInput, type DiagnosticsDeps } from "./diagnostics.server.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DRY = " dryRun:true previews what the call would change and writes nothing; default false executes.";
const LIMIT =
  "Shopify limits behind these incidents: 10 KB per function_config metafield (a node), 25 active automatic discounts per store, 100 ids per list, and the function instruction budget.";

/**
 * Capacity incidents (the admin's capacity dialog) and the Diagnostics page as MCP tools. `deps` lets tests replace
 * the Shopify reads (automatic discount budget, discount list) and the product sync; production passes none.
 */
export function registerCapacityTools(server: McpServer, ctx: McpContext, deps: CapacityToolDeps & DiagnosticsDeps = {}): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });
  const visible = () => visibleShops(ctx.db, ctx.operator);

  server.registerTool(
    "capacity_incidents_list",
    {
      title: "Capacity incidents",
      description: `Lists the shop's capacity incidents (a publish that Shopify's limits blocked) the way the admin capacity dialog shows them: the limit that was hit in plain language, the numbers, the affected offers and every proposed workaround with its workaroundId, what it does and "what changes for customers", whether it needs confirm, and the selection you must make (pause_offers: which offers; deactivate_discounts: which native discounts, with includeDiscountCandidates:true). status: open (default), snoozed, dismissed, resolved (7 days). Also lists actions still undoable (24 h). ${LIMIT} Example: {"shop":"onesolsupps","status":"open"}.`,
      inputSchema: capacityIncidentsListInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => capacityIncidentsList(ctx, await visible(), args, deps)),
  );

  server.registerTool(
    "capacity_incident_apply",
    {
      title: "Apply a capacity workaround",
      description: `Applies one proposed workaround of an incident, exactly as the admin dialog's Apply: it recomputes the proposal server-side, edits the offers in one transaction, re-checks the fit, publishes to Shopify and rolls everything back if the publish fails (PUBLISH_FAILED), or CAPACITY_LIMIT when it still does not fit. Offers the block was holding go live with the fix. Reversible for 24 h with capacity_incident_undo. Selections are explicit: pause_offers needs selected offer ids; deactivate_discounts needs selected NATIVE automatic discount ids (other apps' discounts are refused); reduce_gift_options keeps the number the proposal states; use confirm:true when the proposal says requiresConfirm. Pass expectedVersions (the proposal's offerVersions) to refuse if offers changed since you listed. ${LIMIT}${DRY} Example: {"shop":"onesolsupps","incidentId":"<uuid>","workaround":"reduce_gift_options","confirm":true}.`,
      inputSchema: capacityIncidentApplyInput,
      annotations: WRITE,
    },
    (args, extra) => capacityIncidentApplyTool(ctx, call(extra), args, deps),
  );

  server.registerTool(
    "capacity_incident_undo",
    {
      title: "Undo a capacity workaround",
      description: `Reverts an applied workaround (actionId from capacity_incident_apply or the incident's recentActions) and reopens the incident. Allowed for 24 h after the apply and only while every offer it touched is unchanged since; otherwise INVALID_STATE. The original definition comes back byte for byte; offers that no longer fit come back paused. Reactivates any discounts the fix switched off. Publishes to Shopify.${DRY} Example: {"shop":"onesolsupps","actionId":"<uuid>"}.`,
      inputSchema: capacityIncidentUndoInput,
      annotations: WRITE,
    },
    (args, extra) => capacityIncidentUndoTool(ctx, call(extra), args, deps),
  );

  server.registerTool(
    "capacity_incident_dismiss",
    {
      title: "Dismiss a capacity incident",
      description: `Dismisses an open incident: it leaves the open list and no offer changes (a later block of the same shape reopens it, and a dismissed incident can still be fixed with capacity_incident_apply).${DRY} Example: {"shop":"onesolsupps","incidentId":"<uuid>"}.`,
      inputSchema: capacityIncidentDismissInput,
      annotations: WRITE,
    },
    (args, extra) => capacityIncidentDismissTool(ctx, call(extra), args),
  );

  server.registerTool(
    "capacity_incident_snooze",
    {
      title: "Snooze capacity reminders",
      description: `Snoozes every open capacity incident of the shop for 24 hours (the same shared snooze as the admin banner); nothing else changes.${DRY} Example: {"shop":"onesolsupps"}.`,
      inputSchema: capacityIncidentSnoozeInput,
      annotations: WRITE,
    },
    (args, extra) => capacityIncidentSnoozeTool(ctx, call(extra), args),
  );

  server.registerTool(
    "diagnostics_get",
    {
      title: "Diagnostics",
      description: `What the admin Diagnostics page shows for one shop, with the numbers behind it: health (cached products and variants, cart mutation error rate), the Shopify limits meter (automatic discounts in the store vs the cap, cart slots, sharding), the published config bytes per node and per offer vs the 10 KB metafield limit, the planned nodes and instruction estimate per node vs the budget, combination domains and their groups, and the capacity incidents and applied workarounds. ${LIMIT} Example: {"shop":"onesolsupps"}.`,
      inputSchema: diagnosticsGetInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => diagnosticsGet(ctx.db, await visible(), args, ctx.now, deps)),
  );
}

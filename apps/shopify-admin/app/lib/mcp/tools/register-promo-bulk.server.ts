import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  promoDeleteInput,
  promoDeleteTool,
  promoSetStatusInput,
  promoSetStatusTool,
  promosBulkInput,
  promosBulkTool,
  promosRestoreArchivedInput,
  promosRestoreArchivedTool,
} from "./promo-bulk.server.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const FLOW = " dryRun:true previews the outcome without writing; the default executes. Every status change republishes the shop's Shopify config (the Function config metafield is limited to about 10 KB; a capacity block answers CAPACITY_LIMIT and the change is rolled back).";

/** Status, delete, bulk and restore: the offers list's actions, through offer-lifecycle / offer-bulk. */
export function registerPromoBulkTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_set_status",
    {
      title: "Set a promotion's status",
      description: `Moves an offer to draft, active, paused or archived with the same validation as the admin buttons. draft->active checks conditions, reward, activation rules and capacity (the schedule decides active / scheduled / expired); paused->active resumes; live->paused pauses; any->archived archives; live or paused->draft unpublishes. Invalid moves (e.g. archived->active, active->active) answer INVALID_STATE. Example: {"ref":"promo:onesolsupps:<offerId>","status":"active"}.${FLOW}`,
      inputSchema: promoSetStatusInput,
      annotations: WRITE,
    },
    (args, extra) => promoSetStatusTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_delete",
    {
      title: "Delete a promotion permanently",
      description: `Hard-deletes an offer exactly like the offers list: its rows, analytics, widgets, market overrides, gift clones and bundle definition, neutralizes a dedicated checkout-code discount in Shopify and republishes the shop. IRREVERSIBLE (use promo_set_status archived to keep it). Example: {"ref":"promo:onesolsupps:<offerId>","dryRun":true}.${FLOW}`,
      inputSchema: promoDeleteInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => promoDeleteTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promos_bulk",
    {
      title: "Bulk action on promotions",
      description: `Runs pause | activate | archive | duplicate | delete over up to 200 offers, selected by refs (any shops) or by filter {status,type,query} within one shop. Each offer gets its own result in data.items (ok, statusBefore/After, error code and message, capacity); a failing offer never aborts the rest. pause / activate / archive / delete republish the shop once for the batch. Examples: {"action":"pause","refs":["promo:hpn:<id1>","promo:hpn:<id2>"]}; {"action":"archive","shop":"hpn","filter":{"status":["draft"],"query":"test"},"dryRun":true}.${FLOW}`,
      inputSchema: promosBulkInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => promosBulkTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promos_restore_archived",
    {
      title: "Restore offers archived by an uninstall",
      description: `After a reinstall, puts back the offers the uninstall archived (not the ones archived by a person): each is re-validated, offers that no longer validate stay archived and are counted, then the shop is republished. Example: {"shop":"onesolsupps"}.${FLOW}`,
      inputSchema: promosRestoreArchivedInput,
      annotations: WRITE,
    },
    (args, extra) => promosRestoreArchivedTool(ctx, call(extra), args),
  );
}

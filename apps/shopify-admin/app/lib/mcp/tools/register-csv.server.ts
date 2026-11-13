import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import { offersExportCsv, offersExportCsvInput, offersImportCsv, offersImportCsvInput } from "./csv.server.js";

/** CSV import/export (FIX-mcpfa-18): same columns, limits and validation as the admin Import page and export routes. */
export function registerCsvTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "offers_export_csv",
    {
      title: "Export offers as CSV",
      description:
        "Returns one shop's offers as CSV text (data.csv), one row per reward, with the same columns as the admin export and the admin Import page: offer_id, internal_name, public_title, type, status, priority, schedule, discount_tags, requires_code, main condition, reward, gift fields, tier fields, shop_currency_code. Every status is included; codes are not (use codes_export). Output is capped at 1,000,000 bytes (truncated:true + a warning; pass refs to export the rest). Example: {\"shop\":\"onesolsupps\"} or {\"shop\":\"onesolsupps\",\"refs\":[\"promo:onesolsupps:<offerId>\"]}.",
      inputSchema: offersExportCsvInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => offersExportCsv(ctx, args),
  );

  server.registerTool(
    "offers_import_csv",
    {
      title: "Import offers from CSV",
      description:
        "Creates draft offers from CSV text exactly like the admin Import page (never active: activate afterwards with promo_activate_draft). Every row is validated with the page's messages; one bad row never blocks the others, and the result lists created offers and per-row errors (row 1 = header). dryRun:true returns the same report without writing. Limits: 1,000,000 bytes, 1,000 data rows, 50 columns, 10,000 characters per field; shop_currency_code must match the shop; gift variants must be in the synced catalog. Example: {\"shop\":\"onesolsupps\",\"dryRun\":true,\"csv\":\"internal_name,public_title,type,condition_type,condition_value_threshold_cents,reward_type,discount_type,reward_value\\nspring-10,Spring 10% off,discount,cart_value,5000,order_discount,percentage,10\"}.",
      inputSchema: offersImportCsvInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, extra) => offersImportCsv(ctx, call(extra), args),
  );
}

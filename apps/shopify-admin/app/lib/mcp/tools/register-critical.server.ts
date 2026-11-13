import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  codesCreateBatchInput,
  codesCreateBatchTool,
  codesDeleteInput,
  codesDeleteTool,
  driftRepairSettingsInput,
  driftRepairSettingsTool,
  promoActivateDraftInput,
  promoActivateDraftTool,
  promosPauseAllInput,
  promosPauseAllTool,
  shopSetLimitsEnforcedInput,
  shopSetLimitsEnforcedTool,
} from "./critical-tools.server.js";

const CRITICAL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const FLOW =
  " Applies immediately (any authenticated operator, any visible shop); there is no confirmation step. dryRun:true is an optional preview that writes nothing; idempotencyKey makes a retry return the stored result.";

/** Phase 4.1 high-impact tools. Same full-access semantics as the other write tools: no role, no token, no write lock. */
export function registerCriticalTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promos_pause_all",
    {
      title: "Pause every live promotion of a shop",
      description: `Pauses all active and scheduled offers of one shop in a single publish (rolled back if it fails). dryRun:true lists them.${FLOW}`,
      inputSchema: promosPauseAllInput,
      annotations: CRITICAL,
    },
    (args, extra) => promosPauseAllTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_activate_draft",
    {
      title: "Publish a draft promotion",
      description: `Draft -> live through the admin's Publish sequence (main condition and reward required, validation, schedule-aware status, publish with status rollback, version snapshot).${FLOW}`,
      inputSchema: promoActivateDraftInput,
      annotations: CRITICAL,
    },
    (args, extra) => promoActivateDraftTool(ctx, call(extra), args),
  );

  server.registerTool(
    "codes_create_batch",
    {
      title: "Generate a batch of discount codes",
      description: `Generates up to 500 app-generated codes for an offer (unambiguous charset, entropy-checked). Plaintext codes are never returned: the result has the count and masked samples; export the batch from the Codes tab in the admin. A live offer is republished and the batch removed if that fails.${FLOW}`,
      inputSchema: codesCreateBatchInput,
      annotations: CRITICAL,
    },
    (args, extra) => codesCreateBatchTool(ctx, call(extra), args),
  );

  server.registerTool(
    "codes_delete",
    {
      title: "Delete discount codes",
      description: `Deletes codes of one offer (ids or a batchId; max 2000). Codes still on Shopify are kept (disable them first); with onlyUnused (default) redeemed codes are kept too. Irreversible.${FLOW}`,
      inputSchema: codesDeleteInput,
      annotations: CRITICAL,
    },
    (args, extra) => codesDeleteTool(ctx, call(extra), args),
  );

  server.registerTool(
    "shop_set_limits_enforced",
    {
      title: "Turn offer limits enforcement on or off",
      description: `Flips the per-shop limits.enforced flag and republishes. Refused unless the shop is in LIMITS_TOGGLE_SHOPS and, to enable, no limited automatic offers share a discount title. Reverted if the publish fails.${FLOW}`,
      inputSchema: shopSetLimitsEnforcedInput,
      annotations: CRITICAL,
    },
    (args, extra) => shopSetLimitsEnforcedTool(ctx, call(extra), args),
  );

  server.registerTool(
    "drift_repair_settings",
    {
      title: "Repair Shopify drift of one shop",
      description: `Compares everything the last publish put on Shopify (discount nodes, function_config metafields, purchase-type flags, code counts, cart-validation config) with what is there now. dryRun:true lists every out-of-sync item with current vs expected, bytes before/after and what would be written; nothing is written. Executing reactivates switched-off automatic nodes, re-queues codes deleted on Shopify and republishes the shop config, Refused while drift repair is paused for the shop. One shop per call.${FLOW}`,
      inputSchema: driftRepairSettingsInput,
      annotations: CRITICAL,
    },
    (args, extra) => driftRepairSettingsTool(ctx, call(extra), args),
  );
}

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  codesCreateBatchInput,
  codesCreateBatchTool,
  codesDeleteInput,
  codesDeleteTool,
  promoActivateDraftInput,
  promoActivateDraftTool,
  promosPauseAllInput,
  promosPauseAllTool,
  shopSetLimitsEnforcedInput,
  shopSetLimitsEnforcedTool,
} from "./critical-tools.server.js";

const CRITICAL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const FLOW =
  " Admin only, 3 executions a minute. dryRun defaults to true: it returns the preview and a confirmToken (5 min, single use, bound to these exact arguments); call again with dryRun:false and that token to apply. Only write-enabled shops (see mcp_whoami); other shops answer SHOP_READ_ONLY.";

/** Phase 4.1 critical tools: admin role, confirmToken, same write locks as the Phase 3 tools. */
export function registerCriticalTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promos_pause_all",
    {
      title: "Pause every live promotion of a shop",
      description: `Pauses all active and scheduled offers of one shop in a single publish (rolled back if it fails). The dry run lists them.${FLOW}`,
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
}

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool, type McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  integrationsConnectInput,
  integrationsConnectTool,
  integrationsDisconnectInput,
  integrationsDisconnectTool,
  integrationsList,
  integrationsListInput,
  migrationImportLegacyPresetInput,
  migrationImportLegacyPresetTool,
  migrationShadowModeSetInput,
  migrationShadowModeSetTool,
  settingsGet,
  settingsGetInput,
  settingsSetInput,
  settingsSetTool,
} from "./settings.server.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const FLOW = " Executes immediately; pass dryRun:true to preview first.";

/** Shop settings, flags, migration and integrations (package 15). Every operator can call every tool. */
export function registerSettingsTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "settings_get",
    {
      title: "Read shop settings and flags",
      description:
        'Reads the shop-level settings the admin Settings pages and Diagnostics change: settings index (gift.*, inventory.*, app.*), inventory (gift.oos_behavior, gift.auto_swap_enabled, gift.hide_oos_gifts, gift.continue_selling_enabled), pos.enabled, limits.enforced, function_shards.enabled / .combination_domains / .instruction_budget, function_compact_ids.enabled, storefront.remove_unfunded_gifts, drift_repair.paused, shadow_mode.enabled and the read-only app embed status. Each row has value, default, description, lastChangedAt and whether changing it republishes the shop. Example: {"shop":"onesolsupps","keys":["function_shards.enabled","pos.enabled"]}.',
      inputSchema: settingsGetInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(() => settingsGet(ctx, args)),
  );

  server.registerTool(
    "settings_set",
    {
      title: "Change shop settings and flags",
      description: `Sets one or more settings (partial record, each value validated against its key's type, same rules as the admin pages). Flags that change the compiled Function config (function_shards.*, function_compact_ids.enabled, limits.enforced, shadow_mode.enabled) republish the shop and are reverted if Shopify rejects the publish; limits.enforced also needs the shop in LIMITS_TOGGLE_SHOPS and no shared discount titles among limited automatic offers. dryRun shows before/after and whether a republish happens. Example: {"shop":"hpn-test-store","values":{"function_shards.instruction_budget":false,"gift.oos_behavior":"show_disabled"}}. Shopify limit: a republish can hit the discount capacity limits (see discount_capacity).${FLOW}`,
      inputSchema: settingsSetInput,
      annotations: WRITE,
    },
    (args, extra) => settingsSetTool(ctx, call(extra), args),
  );

  server.registerTool(
    "migration_shadow_mode_set",
    {
      title: "Enable or disable shadow mode",
      description: `Migration console switch: with shadow mode on, offers are evaluated and logged but no cart change is applied and no Function config is active. Republishes the shop. Example: {"shop":"onesolsupps","enabled":true}.${FLOW}`,
      inputSchema: migrationShadowModeSetInput,
      annotations: WRITE,
    },
    (args, extra) => migrationShadowModeSetTool(ctx, call(extra), args),
  );

  server.registerTool(
    "migration_import_legacy_preset",
    {
      title: "Import the shop's legacy preset offers",
      description: `Imports the legacy-store preset registered for the shop (the old scripts app's offers) as DRAFT offers; names that already exist are skipped, so re-running is safe. dryRun lists what would be created. Example: {"shop":"gettrusupps","dryRun":true}.${FLOW}`,
      inputSchema: migrationImportLegacyPresetInput,
      annotations: WRITE,
    },
    (args, extra) => migrationImportLegacyPresetTool(ctx, call(extra), args),
  );

  server.registerTool(
    "integrations_list",
    {
      title: "List connected integrations",
      description:
        'Per shop: which of klaviyo, omnisend, attentive, rebuy, gorgias, postscript are connected and what kind of secret each takes. Secrets are never returned. Example: {"shops":["hpn-supplements"]}.',
      inputSchema: integrationsListInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(() => integrationsList(ctx, args)),
  );

  server.registerTool(
    "integrations_connect",
    {
      title: "Connect or rotate an integration",
      description: `Stores the credential of one integration, encrypted. Klaviyo takes a private API key (validated live against Klaviyo); the others take an HTTPS webhook URL on a public host (private/reserved addresses, credentials in the URL and non-default ports are refused). The secret is write-only: it is never returned, logged or echoed in nextActions. Example: {"shop":"hpn-supplements","integration":"omnisend","secret":"https://hooks.omnisend.com/..."}.${FLOW}`,
      inputSchema: integrationsConnectInput,
      annotations: WRITE,
    },
    (args, extra) => integrationsConnectTool(ctx, call(extra), args),
  );

  server.registerTool(
    "integrations_disconnect",
    {
      title: "Disconnect an integration",
      description: `Deletes the stored credential of one integration (events stop being forwarded). Example: {"shop":"hpn-supplements","integration":"klaviyo"}.${FLOW}`,
      inputSchema: integrationsDisconnectInput,
      annotations: { ...WRITE, destructiveHint: true },
    },
    (args, extra) => integrationsDisconnectTool(ctx, call(extra), args),
  );
}

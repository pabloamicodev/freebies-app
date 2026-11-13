import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { INTEGRATION_IDS, isIntegrationId } from "../../integration-credentials.server.js";
import {
  INTEGRATION_SECRET_KIND,
  connectIntegration,
  disconnectIntegration,
  integrationStatus,
  type IntegrationDeps,
} from "../../integrations.server.js";
import { getLegacyStorePreset, importLegacyPresetForShop, inspectLegacyPreset } from "../../legacy-store-presets.server.js";
import { isShadowModeEnabled } from "../../shadow-mode.server.js";
import {
  SETTING_REGISTRY,
  SettingError,
  applySettings,
  changeShadowMode,
  planSettings,
  readSettings,
} from "../../shop-settings.server.js";
import { WEBHOOK_URL_ERRORS, safeErrorMessage } from "../../safe-error.js";
import { assertSafeWebhookUrl } from "../../safe-webhook-url.server.js";
import { ToolError, buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type ApplyContext, type CallInfo } from "../write-runner.server.js";
import { adminLink, iso } from "./catalog-shared.server.js";

export const settingsControls = {
  dryRun: z.boolean().optional().describe("Optional preview (default false): returns what would change and whether the shop is republished; nothing is written."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
export type SettingsControls = { dryRun?: boolean; idempotencyKey?: string };

const shopField = z.string().max(200).describe("Shop domain or handle.");
const KEY_LIST = SETTING_REGISTRY.map((d) => d.key).join(", ");

export const settingsGetInput = {
  shop: shopField,
  keys: z.array(z.string().max(100)).max(100).optional().describe(`Setting keys to read; omitted = all. Valid: ${KEY_LIST}.`),
};
export const settingsSetInput = {
  shop: shopField,
  values: z
    .record(z.string().max(100), z.unknown())
    .describe('Partial record of setting key -> new value, e.g. {"function_shards.enabled": false, "gift.oos_behavior": "show_disabled"}. Types come from settings_get.'),
  ...settingsControls,
};
export const migrationShadowModeSetInput = {
  shop: shopField,
  enabled: z.boolean().describe("true: evaluate and log offers but apply nothing (no Function config active). false: normal operation."),
  ...settingsControls,
};
export const migrationImportLegacyPresetInput = { shop: shopField, ...settingsControls };
export const integrationsListInput = {
  shops: z.array(z.string().max(200)).max(50).optional().describe("Shop domains or handles; omitted = every visible shop."),
};
export const integrationsConnectInput = {
  shop: shopField,
  integration: z.enum(INTEGRATION_IDS).describe("klaviyo takes a private API key (validated live); omnisend, attentive, rebuy, gorgias, postscript take an HTTPS webhook URL on a public host."),
  secret: z.string().trim().min(1).max(2000).describe("The API key or webhook URL. Write-only: stored encrypted, never returned or logged."),
  ...settingsControls,
};
export const integrationsDisconnectInput = {
  shop: shopField,
  integration: z.enum(INTEGRATION_IDS),
  ...settingsControls,
};

async function resolveShop(ctx: McpContext, ref: string): Promise<VisibleShop> {
  return selectShops(await visibleShops(ctx.db, ctx.operator), [ref])[0]!;
}

function settingToolError(error: unknown): never {
  if (error instanceof SettingError) {
    throw new ToolError(error.kind === "publish_failed" ? "PUBLISH_FAILED" : "VALIDATION", error.message.replace(/\s+/g, " ").slice(0, 500), {
      suggestedAction: { mcp: "promo-engine", tool: "settings_get", args: {}, why: "Check the key's type, default and current value." },
    });
  }
  throw error;
}

async function guardedWrite(
  ctx: McpContext,
  call: CallInfo,
  spec: {
    tool: string;
    shopRef: string;
    args: Record<string, unknown>;
    controls: SettingsControls;
    preview: (shop: VisibleShop) => Promise<{ summary: string; data: Record<string, unknown>; warnings?: ToolResult<unknown>["warnings"] }>;
    apply: (shop: VisibleShop, a: ApplyContext) => Promise<{ summary: string; data: Record<string, unknown>; warnings?: ToolResult<unknown>["warnings"] }>;
  },
): Promise<CallToolResult> {
  let shop: VisibleShop;
  try {
    shop = await resolveShop(ctx, spec.shopRef);
  } catch (error) {
    return toErrorCallToolResult(error);
  }
  return runWrite(ctx, call, {
    tool: spec.tool,
    args: spec.args,
    dryRun: spec.controls.dryRun === true,
    idempotencyKey: spec.controls.idempotencyKey,
    shops: [shop],
    preview: async () => {
      try {
        return { ...(await spec.preview(shop)), links: [adminLink(shopHandle(shop.myshopifyDomain))], offerUpdatedAt: null };
      } catch (error) {
        return settingToolError(error);
      }
    },
    apply: async (a) => {
      try {
        return { ...(await spec.apply(shop, a)), links: [adminLink(shopHandle(shop.myshopifyDomain))] };
      } catch (error) {
        return settingToolError(error);
      }
    },
  });
}

const jsonable = (value: unknown) => (value === undefined ? null : value);

export async function settingsGet(
  ctx: McpContext,
  args: { shop: string; keys?: string[] },
): Promise<ToolResult<{ shopDomain: string; settings: Record<string, unknown>[] }>> {
  const shop = await resolveShop(ctx, args.shop);
  try {
    const rows = await readSettings(ctx.db, shop.id, args.keys);
    return buildResult(
      {
        summary: `${rows.length} setting(s) of ${shop.myshopifyDomain}. Change them with settings_set.`,
        data: {
          shopDomain: shop.myshopifyDomain,
          settings: rows.map((r) => ({
            key: r.key,
            group: r.group,
            value: jsonable(r.value),
            default: jsonable(r.default),
            description: r.description,
            readOnly: r.readOnly,
            republishAfterChange: r.republishAfter,
            lastChangedAt: iso(r.lastChangedAt),
          })),
        },
        links: [adminLink(shopHandle(shop.myshopifyDomain))],
        nextActions: [
          { mcp: "promo-engine", tool: "settings_set", args: { shop: shop.myshopifyDomain, values: {}, dryRun: true }, why: "Preview a change.", risk: "write" },
        ],
      },
      ctx.now,
    );
  } catch (error) {
    return settingToolError(error);
  }
}

export function settingsSetTool(ctx: McpContext, call: CallInfo, args: { shop: string; values: Record<string, unknown> } & SettingsControls): Promise<CallToolResult> {
  const describe = (changes: Awaited<ReturnType<typeof planSettings>>) => {
    const changed = changes.filter((c) => c.changed);
    return {
      changes: changes.map((c) => ({ key: c.key, before: jsonable(c.before), after: jsonable(c.after), changed: c.changed, republish: c.republish })),
      republish: changed.some((c) => c.republish),
    };
  };
  return guardedWrite(ctx, call, {
    tool: "settings_set",
    shopRef: args.shop,
    args,
    controls: args,
    preview: async (shop) => {
      const plan = describe(await planSettings(ctx.db, shop.id, args.values));
      const n = plan.changes.filter((c) => c.changed).length;
      return {
        summary: `${n} of ${plan.changes.length} setting(s) would change on ${shop.myshopifyDomain}${plan.republish ? "; the shop's Shopify config is republished (reverted if that fails)" : ""}.`,
        data: { shopDomain: shop.myshopifyDomain, ...plan },
      };
    },
    apply: async (shop, a) => {
      const result = await applySettings(
        { db: ctx.db, shopId: shop.id, shopDomain: shop.myshopifyDomain, publish: a.publish, performedBy: a.performedBy, auditExtra: a.auditExtra, env: ctx.env },
        args.values,
      );
      const plan = describe(result.changes);
      const n = plan.changes.filter((c) => c.changed).length;
      return {
        summary: n === 0 ? `Nothing changed on ${shop.myshopifyDomain}: every value was already set.` : `Updated ${n} setting(s) on ${shop.myshopifyDomain}${result.republished ? "; Shopify config republished" : ""}.`,
        data: { shopDomain: shop.myshopifyDomain, ...plan, republished: result.republished, at: iso(ctx.now()) },
      };
    },
  });
}

export function migrationShadowModeSetTool(ctx: McpContext, call: CallInfo, args: { shop: string; enabled: boolean } & SettingsControls): Promise<CallToolResult> {
  return guardedWrite(ctx, call, {
    tool: "migration_shadow_mode_set",
    shopRef: args.shop,
    args,
    controls: args,
    preview: async (shop) => {
      const before = await isShadowModeEnabled(shop.id);
      return {
        summary: `Shadow mode on ${shop.myshopifyDomain}: ${before} -> ${args.enabled}${before === args.enabled ? " (no change)" : "; the shop is republished"}.`,
        data: { shopDomain: shop.myshopifyDomain, enabledBefore: before, enabledAfter: args.enabled, changed: before !== args.enabled },
      };
    },
    apply: async (shop, a) => {
      const result = await changeShadowMode({ db: ctx.db, shopId: shop.id, shopDomain: shop.myshopifyDomain, publish: a.publish }, args.enabled);
      if (!result.ok) throw new SettingError("publish_failed", result.error);
      return {
        summary: `Shadow mode on ${shop.myshopifyDomain} is now ${args.enabled}. Shopify config republished.`,
        data: { shopDomain: shop.myshopifyDomain, enabled: args.enabled },
      };
    },
  });
}

export function migrationImportLegacyPresetTool(ctx: McpContext, call: CallInfo, args: { shop: string } & SettingsControls): Promise<CallToolResult> {
  return guardedWrite(ctx, call, {
    tool: "migration_import_legacy_preset",
    shopRef: args.shop,
    args,
    controls: args,
    preview: async (shop) => {
      const preset = getLegacyStorePreset(shop.myshopifyDomain);
      if (!preset) throw new SettingError("validation", "No legacy store preset is registered for this shop.");
      const offers = await inspectLegacyPreset(ctx.db, shop.id, preset);
      const pending = offers.filter((o) => !o.alreadyImported).length;
      return {
        summary: `Would import ${pending} draft offer(s) from "${preset.sourceName}" into ${shop.myshopifyDomain}; ${offers.length - pending} already exist.`,
        data: {
          shopDomain: shop.myshopifyDomain,
          source: preset.sourceName,
          notes: preset.notes,
          offers: offers.map((o) => ({ key: o.key, internalName: o.internalName, publicTitle: o.publicTitle, alreadyImported: o.alreadyImported })),
        },
      };
    },
    apply: async (shop) => {
      const result = await importLegacyPresetForShop(ctx.db, shop.id, shop.myshopifyDomain);
      if (!result.ok) throw new SettingError("validation", result.error);
      return {
        summary: `Imported ${result.created} draft offer(s); ${result.skipped} already existed. Review and publish them from the admin or promo_activate_draft.`,
        data: { shopDomain: shop.myshopifyDomain, created: result.created, skipped: result.skipped, total: result.total },
      };
    },
  });
}

export async function integrationsList(
  ctx: McpContext,
  args: { shops?: string[] },
): Promise<ToolResult<{ shops: { shopDomain: string; integrations: Awaited<ReturnType<typeof integrationStatus>> }[] }>> {
  const selected = selectShops(await visibleShops(ctx.db, ctx.operator), args.shops);
  const shops = await Promise.all(selected.map(async (s) => ({ shopDomain: s.myshopifyDomain, integrations: await integrationStatus(ctx.db, s.id) })));
  const connected = shops.reduce((n, s) => n + s.integrations.filter((i) => i.connected).length, 0);
  return buildResult(
    {
      summary: `${connected} integration(s) connected across ${shops.length} shop(s). Secrets are write-only and never shown.`,
      data: { shops },
    },
    ctx.now,
  );
}

const withoutSecret = (args: Record<string, unknown>): Record<string, unknown> => {
  const { secret: _secret, ...rest } = args;
  return rest;
};

export function integrationsConnectTool(
  ctx: McpContext,
  call: CallInfo,
  args: { shop: string; integration: string; secret: string } & SettingsControls,
  deps: IntegrationDeps = {},
): Promise<CallToolResult> {
  // The secret is kept out of the logged / hashed / echoed arguments.
  const safeArgs = withoutSecret(args);
  return guardedWrite(ctx, call, {
    tool: "integrations_connect",
    shopRef: args.shop,
    args: safeArgs,
    controls: args,
    preview: async (shop) => {
      if (!isIntegrationId(args.integration)) throw new SettingError("validation", "Unknown integration");
      const kind = INTEGRATION_SECRET_KIND[args.integration];
      if (kind === "webhook_url") {
        try {
          await (deps.assertSafeUrl ?? assertSafeWebhookUrl)(args.secret.trim());
        } catch (error) {
          throw new SettingError("validation", safeErrorMessage(error, "Webhook URL is invalid", WEBHOOK_URL_ERRORS));
        }
      }
      const status = (await integrationStatus(ctx.db, shop.id)).find((i) => i.id === args.integration);
      return {
        summary: `Would ${status?.connected ? "replace the credential of" : "connect"} ${args.integration} on ${shop.myshopifyDomain}${kind === "api_key" ? " (the API key is validated with Klaviyo when applied)" : " (the webhook URL passed the safety check)"}.`,
        data: { shopDomain: shop.myshopifyDomain, integration: args.integration, secretKind: kind, alreadyConnected: Boolean(status?.connected) },
      };
    },
    apply: async (shop) => {
      const result = await connectIntegration(ctx.db, shop.id, args.integration, args.secret, deps);
      if (!result.ok) throw new SettingError("validation", result.error);
      return {
        summary: `${args.integration} connected on ${shop.myshopifyDomain}. The secret is stored encrypted and never shown.`,
        data: { shopDomain: shop.myshopifyDomain, integration: args.integration, connected: true },
      };
    },
  });
}

export function integrationsDisconnectTool(ctx: McpContext, call: CallInfo, args: { shop: string; integration: string } & SettingsControls): Promise<CallToolResult> {
  return guardedWrite(ctx, call, {
    tool: "integrations_disconnect",
    shopRef: args.shop,
    args,
    controls: args,
    preview: async (shop) => {
      const status = (await integrationStatus(ctx.db, shop.id)).find((i) => i.id === args.integration);
      return {
        summary: status?.connected ? `Would remove the ${args.integration} credential of ${shop.myshopifyDomain}.` : `${args.integration} is not connected on ${shop.myshopifyDomain}; nothing to remove.`,
        data: { shopDomain: shop.myshopifyDomain, integration: args.integration, connected: Boolean(status?.connected) },
      };
    },
    apply: async (shop) => {
      const result = await disconnectIntegration(ctx.db, shop.id, args.integration);
      if (!result.ok) throw new SettingError("validation", result.error);
      return {
        summary: `${args.integration} disconnected on ${shop.myshopifyDomain}.`,
        data: { shopDomain: shop.myshopifyDomain, integration: args.integration, connected: false },
      };
    },
  });
}

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import { runTool } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  customizeGetInput,
  customizeGetTool,
  customizeSetInput,
  customizeSetTool,
  multicurrencyGetInput,
  multicurrencyGetTool,
  setMulticurrencyInput,
  setMulticurrencyTool,
  translationsGetInput,
  translationsGetTool,
  translationsSetInput,
  translationsSetTool,
} from "./i18n.server.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const FLOW = " dryRun:true previews without writing (optional); idempotencyKey makes a retry safe.";

/** Storefront strings, global widget theme and per-currency overrides (FIX-mcpfa-13). Every operator may call every tool. */
export function registerI18nTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "translations_get",
    {
      title: "Widget translations",
      description:
        'Every editable storefront widget string for one locale: key, label, hint, the {{variables}} it may use, the English default and the stored value (null = uses the default). Example: {"shop":"hpn","locale":"es"}.',
      inputSchema: translationsGetInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(() => translationsGetTool(ctx, args)),
  );

  server.registerTool(
    "translations_set",
    {
      title: "Set widget translations",
      description: `Writes storefront widget strings for one locale (partial patch by default). Same validation as the admin Translation page: supported locale, max 300 chars, {{placeholder}} syntax and allowed variables per key. No Shopify publish is needed. Example: {"shop":"hpn","locale":"es","strings":{"progress.before_goal":"Gasta {{remaining_amount}} mas y llevate un regalo","upsell.no_thanks":null}}.${FLOW}`,
      inputSchema: translationsSetInput,
      annotations: WRITE,
    },
    (args, extra) => translationsSetTool(ctx, call(extra), args),
  );

  server.registerTool(
    "customize_get",
    {
      title: "Widget theme",
      description: 'Global widget theme (colors, font, border radius) and default copy of a shop: effective values, which keys are customized and the defaults. Example: {"shop":"hpn"}.',
      inputSchema: customizeGetInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(() => customizeGetTool(ctx, args)),
  );

  server.registerTool(
    "customize_set",
    {
      title: "Set widget theme",
      description: `Changes the global widget theme and default copy (the admin Customize page). Partial patch by default. Example: {"shop":"hpn","values":{"primaryColor":"#0a7d3b","buttonTextColor":"#ffffff"}}.${FLOW}`,
      inputSchema: customizeSetInput,
      annotations: WRITE,
    },
    (args, extra) => customizeSetTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_multicurrency_get",
    {
      title: "Multicurrency overrides",
      description:
        'Per-currency threshold, maximum and fixed-amount overrides stored on an offer\'s Cart Value condition, in stored units and in major units per currency, plus the base threshold. Example: {"ref":"promo:hpn:<offerId>"}.',
      inputSchema: multicurrencyGetInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(() => multicurrencyGetTool(ctx, args)),
  );

  server.registerTool(
    "promo_set_multicurrency",
    {
      title: "Set multicurrency overrides",
      description: `Sets per-currency overrides of an offer's Cart Value threshold, maximum and fixed discount amount, in MAJOR units of each currency (zero-decimal currencies such as JPY or KRW: 3000 means 3000 yen, never multiply by 100). Republishes the shop config when the offer is active (rolled back and reported if that fails; Shopify config size limits apply). Needs a Cart Value condition. Example: {"ref":"promo:hpn:<offerId>","overrides":[{"currency":"EUR","threshold":25,"fixed":5},{"currency":"JPY","threshold":3000}]}.${FLOW}`,
      inputSchema: setMulticurrencyInput,
      annotations: WRITE,
    },
    (args, extra) => setMulticurrencyTool(ctx, call(extra), args),
  );
}

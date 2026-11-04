import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import { runTool } from "../server.server.js";
import { visibleShops } from "../shops.server.js";
import { promosActive, promosActiveInput } from "./promos-active.server.js";
import { promoDetail, promoDetailInput } from "./promo-detail.server.js";
import { giftsRules, giftsRulesInput } from "./gifts-rules.server.js";
import { bundlesList, bundlesListInput } from "./bundles-list.server.js";
import { upsellsList, upsellsListInput } from "./upsells-list.server.js";
import { codesList, codesListInput } from "./codes-list.server.js";
import { pageConditionsExplain, pageConditionsExplainInput } from "./page-conditions-explain.server.js";
import { discountCapacity, discountCapacityInput } from "./discount-capacity.server.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Phase 1 catalog reads (viewer role, multi-shop, no PII). Every tool respects the operator's shop allow list. */
export function registerCatalogTools(server: McpServer, ctx: McpContext): void {
  const visible = () => visibleShops(ctx.db, ctx.operator);

  server.registerTool(
    "promos_active",
    {
      title: "Active promotions",
      description:
        "Lists offers per shop (default active and scheduled) with type, schedule, rewards, conditions, combination rules and publish errors. Filter by shops, types, status or name.",
      inputSchema: promosActiveInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => promosActive(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "promo_detail",
    {
      title: "Promotion detail",
      description:
        "Full readable definition of one offer: conditions (incl. page/template/section/test group and excludeUrls), rewards, combination policy, schedule and timezone, limits, versions, experiment bindings and recent changes. ref = promo:<shopHandle>:<offerId>, or offerId plus shop.",
      inputSchema: promoDetailInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => promoDetail(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "gifts_rules",
    {
      title: "Gift rules",
      description:
        "Gift offers: cart-value trigger, gift variants, picker vs auto-add, limits (times the gift SET is granted, per gift product), stock sold-out/low and landing page types.",
      inputSchema: giftsRulesInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => giftsRules(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "bundles_list",
    {
      title: "Bundles",
      description: "Bundle offers (classic, mix and match, bundle page, quantity breaks...) with steps, tiers and discounts.",
      inputSchema: bundlesListInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => bundlesList(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "upsells_list",
    {
      title: "Upsells and boosters",
      description: "Upsell and booster offers with trigger conditions, offered products, discount and widget placements.",
      inputSchema: upsellsListInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => upsellsList(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "codes_list",
    {
      title: "Discount codes",
      description:
        "Code offers with totals, usage, mode (checkout_code or automatic), expiry and batches. Codes are always masked (AB••••12). Pass ref to also page through that offer's individual codes.",
      inputSchema: codesListInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => codesList(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "page_conditions_explain",
    {
      title: "Explain page conditions",
      description:
        "Explains whether an offer's page conditions (Store pages, excludeUrls, page URL, template, section, test group, UTM) pass for a given page URL or page type, which condition decides, and what to change.",
      inputSchema: pageConditionsExplainInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => pageConditionsExplain(ctx.db, await visible(), args, ctx.now)),
  );

  server.registerTool(
    "discount_capacity",
    {
      title: "Discount config capacity",
      description:
        "Size of each shop's shared Function config versus the 9500 byte metafield limit, heaviest offers, headroom and risk. live:true also reads the real metafield from Shopify.",
      inputSchema: discountCapacityInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runTool(async () => discountCapacity(ctx.db, await visible(), args, ctx.now)),
  );
}

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  promoConditionDeleteInput,
  promoConditionDeleteTool,
  promoConditionUpsertInput,
  promoConditionUpsertTool,
  promoSubconditionsSetInput,
  promoSubconditionsSetTool,
} from "./promo-conditions.server.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const FLOW =
  " A live (active) offer is republished to Shopify and, if the publish fails because of this change, the offer is paused (same as the admin editor). Pass dryRun:true to preview the stored value without writing. Money fields are in major units of the shop currency (50 = 50.00). Shopify limits: the shop's config size and automatic-discount budget are checked on publish.";

/** Offer conditions editor: add/update/delete one condition, replace the sub-condition set. Same service as the admin route. */
export function registerPromoConditionsTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_condition_upsert",
    {
      title: "Add or update an offer condition",
      description:
        `Adds a condition to an offer, or updates one when conditionId is given. \`condition.type\` picks the shape: cart_value, cart_quantity, cart_value_multiplier, customer_tags, order_history_total_spent|last_order_spent|total_orders, one_use_per_customer, markets, customer_location, sales_channels, subscription_product_type, specific_link, page_types, template, section_shown, experiment, page_url, specific_product, pack_of_products, line_attribute, cart_attribute, utm_parameters. scope: main (default for cart/product/page conditions) or sub (default for customer/market/channel gates).` +
        ` Examples: customer tag VIP -> {"ref":"promo:hpn:<id>","condition":{"type":"customer_tags","includeTags":["VIP"]}}; cart value at least 50 -> {"condition":{"type":"cart_value","threshold":50}}; markets US and CA -> {"condition":{"type":"markets","includeMarketIds":["123456","789012"]}} (ids from markets_list); product and collection pages -> {"condition":{"type":"page_types","pageTypes":["product","collection"]}}; update -> add "conditionId". The "any of these products" rule cannot be combined with another product/pack condition on the same offer.${FLOW}`,
      inputSchema: promoConditionUpsertInput,
      annotations: WRITE,
    },
    (args, extra) => promoConditionUpsertTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_condition_delete",
    {
      title: "Delete an offer condition",
      description: `Deletes one condition by id (see promo_detail). The last enabled main condition of an active offer cannot be deleted: pause the offer or add another main condition first. Example: {"ref":"promo:hpn:<id>","conditionId":"<uuid>"}.${FLOW}`,
      inputSchema: promoConditionDeleteInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => promoConditionDeleteTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_subconditions_set",
    {
      title: "Replace an offer's sub-conditions",
      description: `Replaces the whole set of sub-conditions (the extra gates: customer tags, markets, location, channel, order history, UTM...) atomically; main conditions are untouched and every listed condition is stored as a sub-condition. Pass [] to remove them all. Example: {"ref":"promo:hpn:<id>","subconditions":[{"type":"customer_tags","includeTags":["VIP"]},{"type":"markets","includeMarketIds":["123456"]}]}.${FLOW}`,
      inputSchema: promoSubconditionsSetInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => promoSubconditionsSetTool(ctx, call(extra), args),
  );
}

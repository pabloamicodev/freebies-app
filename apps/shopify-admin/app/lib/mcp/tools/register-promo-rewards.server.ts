import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import { promoRewardDeleteInput, promoRewardUpsertInput, rewardDeleteTool, rewardUpsertTool } from "./promo-rewards.server.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** Reward editor tools: add, update and delete the rewards of one offer. They call the offer-rewards service, never SQL. */
export function registerPromoRewardsTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_reward_upsert",
    {
      title: "Add or update an offer reward",
      description:
        "Adds a reward to an existing offer, or updates one when rewardId is given (rewardId comes from promo_detail). Pass the reward as `reward` (authoring shape, same as promo_create rewards, money in major units) OR as `stored` (the exact stored row: rewardType, discountType, value, target, quantity, isAutoAdd, isCustomerSelectable, trackMode, label, minCartSubtotal). A live offer is republished; a failed publish keeps the saved reward and returns PUBLISH_FAILED. Gift tiers: minCartSubtotal must be unique per gift in the offer, and saving a tier lowers the main cart-value threshold to the lowest tier. Shopify limits apply on publish (config size, automatic discount budget). " +
        "Example (stored, 15% off the cart): { ref: 'promo:hpn:<offerId>', stored: { rewardType: 'order_discount', discountType: 'percentage', value: { amount: 15, currencyCode: 'USD' }, target: { scope: 'cart' } } }. " +
        "dryRun:true previews without writing.",
      inputSchema: promoRewardUpsertInput,
      annotations: WRITE,
    },
    (args, extra) => rewardUpsertTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_reward_delete",
    {
      title: "Delete an offer reward",
      description:
        "Deletes one reward of an offer (rewardId from promo_detail) and republishes a live offer. The last reward of an active offer cannot be deleted: pause it or add another reward first. " +
        "Example: { ref: 'promo:hpn:<offerId>', rewardId: '<uuid>' }. dryRun:true previews without writing.",
      inputSchema: promoRewardDeleteInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => rewardDeleteTool(ctx, call(extra), args),
  );
}

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import { runTool } from "../server.server.js";
import { visibleShops } from "../shops.server.js";
import type { CallInfo } from "../write-runner.server.js";
import { giftTiersGet, giftTiersGetInput, promoSetTierModeInput, setTierModeTool } from "./promo-gifts.server.js";

export function registerPromoGiftsTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_set_tier_mode",
    {
      title: "Set gift tier mode",
      description:
        'Sets how a gift offer combines several reached cart-subtotal tiers: "cumulative" (every reached tier\'s gift) or "highest" (only the highest reached tier\'s gift). Republishes the shop when the offer is active; a capacity block answers CAPACITY_LIMIT. Example: {"ref":"promo:hpn:<offerId>","mode":"highest"}. dryRun:true previews.',
      inputSchema: promoSetTierModeInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) => setTierModeTool(ctx, call(extra), args),
  );

  server.registerTool(
    "gift_tiers_get",
    {
      title: "Gift tiers",
      description:
        'Gift offers with cart-subtotal tiers (what the admin Gift tiers page shows): per tier the subtotal, gift variants, fallbacks, quantity, auto-add vs picker; the offer\'s tier mode ("cumulative"/"highest") and its main threshold, warning when that threshold hides lower tiers. Example: {"ref":"promo:hpn:<offerId>"} or {"shops":["hpn"]}.',
      inputSchema: giftTiersGetInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool(async () => giftTiersGet(ctx.db, await visibleShops(ctx.db, ctx.operator), args, ctx.now)),
  );
}

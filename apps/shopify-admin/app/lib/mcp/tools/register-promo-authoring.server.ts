import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import { CREATE_EXAMPLE, promoCreateInput, promoCreateTool, promoUpdateInput, promoUpdateTool } from "./promo-authoring.server.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const LIMITS =
  "Shopify limits it can hit: the shared automatic-discount config size (about 10 KB per node, split across nodes when the shop has sharding on), the store's 25 automatic-discount budget and a product list of more than 100 ids; a blocked activation answers CAPACITY_LIMIT with the limit, the numbers and the workarounds the admin offers (the offer stays saved as a draft). ";
const CONTROLS = "dryRun:true previews the full outcome (validation + capacity preflight) without writing; omit it to apply. ";

/** Core authoring: create and edit a whole offer (offer fields, conditions, rewards, combinations) in one call. */
export function registerPromoAuthoringTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_create",
    {
      title: "Create a promotion",
      description:
        `Creates a whole offer in one call, exactly as the admin wizard would store it: offer fields, conditions, rewards and combination policy in one transaction, then (status active) validation, capacity preflight and publish to Shopify. ` +
        `rewards[] is discriminated by kind: product_discount (target {scope:'selected'|'all_products', products/variants ids}, quantityTiers[{minQuantity,maxQuantity?,discountType,value,discountedQuantity?}] or a flat discount, selection all|cheapest|most_expensive, countRule, displayType, subscriptionMode) and order_discount (by subtotal|quantity, tiers[{minimum,maximum?,value}]). Money is in shop-currency major units (19.99); ids are numeric or GIDs. The main condition (cart_quantity gte the lowest tier, or cart_value for subtotal tiers) is derived unless you pass one. ` +
        `Example, the owner's request "${CREATE_EXAMPLE}": ` +
        `{"shop":"onesolsupps","type":"discount","internalName":"Protein & Creatine Bundle volume","status":"active","rewards":[{"kind":"product_discount","target":{"scope":"selected","products":["9208279269615"]},"quantityTiers":[{"minQuantity":1,"maxQuantity":1,"discountType":"percentage","value":20},{"minQuantity":2,"discountType":"percentage","value":30}]}]}. ` +
        `Cart-value example: {"shop":"onesolsupps","type":"discount","internalName":"Spend more save more","rewards":[{"kind":"order_discount","by":"subtotal","tiers":[{"minimum":50,"maximum":99.99,"value":10},{"minimum":100,"value":15}]}]}. ` +
        `Writes live offers when status is active. ${CONTROLS}${LIMITS}`,
      inputSchema: promoCreateInput,
      annotations: WRITE,
    },
    (args, extra) => promoCreateTool(ctx, call(extra), args),
  );

  server.registerTool(
    "promo_update",
    {
      title: "Update a promotion",
      description:
        `Edits an offer: any of internalName, publicTitle, cartLabels, description, priority, startsAt/endsAt, tierMode, and optionally REPLACES all its conditions and/or all its rewards, in one transaction. Fields you omit stay as they are; schedule changes move the status like the admin (a future start schedules, a past end expires). A live offer is validated, preflighted and republished; if that fails the edit stays saved and the offer is paused so the shop stays consistent. ` +
        `Pass expectedUpdatedAt (the updatedAt from promo_detail or the last result) to refuse the write with STATE_CONFLICT when someone changed the offer meanwhile. Status changes (pause/resume/archive) have their own tools; combinations are set with promo_set_combinations. ` +
        `Example: {"ref":"promo:onesolsupps:<offerId>","priority":50,"rewards":[{"kind":"product_discount","target":{"scope":"selected","products":["9208279269615"]},"quantityTiers":[{"minQuantity":1,"discountType":"percentage","value":25}]}],"conditions":[{"type":"cart_quantity","scope":"main","operator":"gte","value":{"minQuantity":1,"includeGiftValues":false}}],"expectedUpdatedAt":"2026-11-13T10:00:00.000Z"}. ` +
        `${CONTROLS}${LIMITS}`,
      inputSchema: promoUpdateInput,
      annotations: WRITE,
    },
    (args, extra) => promoUpdateTool(ctx, call(extra), args),
  );
}

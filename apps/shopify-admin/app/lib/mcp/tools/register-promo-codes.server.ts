import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  codesAddInput,
  codesAddTool,
  codesExportInput,
  codesRetryOriginalInput,
  codesRetryOriginalTool,
  codesSetDiscountMessageInput,
  codesSetDiscountMessageTool,
  codesSetRedemptionModeInput,
  codesSetRedemptionModeTool,
  promoCreateCodeOfferInput,
  promoCreateCodeOfferTool,
  runCodesExport,
} from "./promo-codes.server.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const READ = { readOnlyHint: true, openWorldHint: false } as const;

/** Discount-code tools (FIX-mcpfa-08). Writes run directly (dryRun:true previews); exports return codes unmasked. */
export function registerPromoCodesTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "promo_create_code_offer",
    {
      title: "Create a discount-code offer",
      description:
        "Creates a code offer exactly like the admin's Discount Codes wizard: one transaction with the offer, its codes (a typed code OR a generated batch), the page-types condition (+ optional UTM and extra conditions), one reward and the combination policy; status active goes live through the normal publish flow (capacity preflight, rollback to draft if Shopify rejects it). " +
        "Fields: internalName; discountMessage; status draft|active; startsAt/endsAt (shop-local 'YYYY-MM-DDTHH:mm' or ISO); redemption checkout_code|automatic; code OR batch {count,prefix,length,charset}; usageLimit, oncePerCustomer, codeStartsAt, codeEndsAt; target order|products|shipping; discountType percentage|fixed_amount; value (percent, or major currency units); productIds (target products); subscriptionMode; pageTypes; mixedCart; utm; subconditions; combines. " +
        "Example: { shop: 'hpn', internalName: 'Summer 10', code: 'SUMMER10', target: 'order', discountType: 'percentage', value: 10, status: 'active' }. Bulk example: { shop: 'hpn', internalName: 'VIP codes', batch: { count: 500, prefix: 'VIP-' }, usageLimit: 1, oncePerCustomer: true, target: 'shipping' }. " +
        "Limits: a batch is at most 5000 codes per call; a code offer publishes to its own Shopify discount node whose Function config holds ~9.5 KB, so 'products' targets fit a limited number of products (the error says how many); collections are not supported, pass productIds. dryRun:true validates everything and writes nothing.",
      inputSchema: promoCreateCodeOfferInput,
      annotations: WRITE,
    },
    (args, extra) => promoCreateCodeOfferTool(ctx, call(extra), args),
  );

  server.registerTool(
    "codes_add",
    {
      title: "Add a code or generate a batch",
      description:
        "Adds one typed code, or generates a batch of unique codes, on an existing offer (the Codes tab's Add code / Generate). A live offer is republished; above 500 new codes on a live offer the publish simply runs inline. Max 5000 codes per call; the batch's random part must be long enough that guessing is hopeless. " +
        "Example: { ref: 'promo:hpn:<offerId>', code: 'WELCOME15', usageLimit: 100 } or { ref: '...', batch: { count: 200, prefix: 'VIP-', length: 8 }, oncePerCustomer: true }. Batch codes are not returned here: use codes_export with the returned batchId. dryRun:true previews the outcome without writing.",
      inputSchema: codesAddInput,
      annotations: WRITE,
    },
    (args, extra) => codesAddTool(ctx, call(extra), args),
  );

  server.registerTool(
    "codes_set_discount_message",
    {
      title: "Set the discount message",
      description: "Sets the message customers see for the discount (offers.public_title, max 60 chars; empty = the offer's internal name). Example: { ref: 'promo:hpn:<offerId>', message: '10% off your order' }. A live offer is republished. dryRun:true previews the outcome without writing anything.",
      inputSchema: codesSetDiscountMessageInput,
      annotations: WRITE,
    },
    (args, extra) => codesSetDiscountMessageTool(ctx, call(extra), args),
  );

  server.registerTool(
    "codes_set_redemption_mode",
    {
      title: "Set code redemption mode",
      description:
        "Switches an offer between customers entering a code (checkout_code) and applying automatically (automatic; its codes are paused). Automatic needs at least one enabled main condition and free automatic-discount capacity in the shop (Shopify allows a limited number of automatic discounts): a capacity block returns CAPACITY_LIMIT with the numbers. Example: { ref: 'promo:hpn:<offerId>', mode: 'automatic' }. dryRun:true previews the outcome without writing anything.",
      inputSchema: codesSetRedemptionModeInput,
      annotations: WRITE,
    },
    (args, extra) => codesSetRedemptionModeTool(ctx, call(extra), args),
  );

  server.registerTool(
    "codes_retry_original",
    {
      title: "Restore a code's original name",
      description:
        "After a code collided with a discount already on Shopify and was saved with a suffix, switches it back to the original code if that code is free on Shopify now (never touches the merchant's own discount). Example: { ref: 'promo:hpn:<offerId>', codeId: '<code uuid from codes_list>' }. dryRun:true previews the outcome without writing anything.",
      inputSchema: codesRetryOriginalInput,
      annotations: WRITE,
    },
    (args, extra) => codesRetryOriginalTool(ctx, call(extra), args),
  );

  server.registerTool(
    "codes_export",
    {
      title: "Export an offer's codes (unmasked)",
      description:
        "Returns the offer's discount codes UNMASKED as CSV text (`data.csv`, same columns and order as the admin's CSV export: code,status,starts_at,ends_at,usage_limit,once_per_customer,usage_count) plus structured `data.rows`. These are real redeemable codes: handle as secrets. " +
        "Bounded: at most 2000 codes per call (default 500); when more exist meta.page.hasMore is true, pass meta.page.cursor back as cursor (drop the CSV header line of pages after the first). Filters: status, batchId, search. Example: { ref: 'promo:hpn:<offerId>', batchId: '<batch uuid>', limit: 1000 }.",
      inputSchema: codesExportInput,
      annotations: READ,
    },
    (args) => runCodesExport(ctx, args),
  );
}

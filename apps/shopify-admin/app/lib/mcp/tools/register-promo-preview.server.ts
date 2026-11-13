import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import { runTool } from "../server.server.js";
import { visibleShops } from "../shops.server.js";
import { PROMO_PREVIEW_CART_DESCRIPTION, promoPreviewCart, promoPreviewCartInput } from "./promo-preview.server.js";

/** Cart preview (read only): the admin Preview page as a tool, with per-line discounts from the Function reference model. */
export function registerPromoPreviewTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "promo_preview_cart",
    {
      title: "Preview a cart",
      description: PROMO_PREVIEW_CART_DESCRIPTION,
      inputSchema: promoPreviewCartInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool(async () => promoPreviewCart(ctx.db, await visibleShops(ctx.db, ctx.operator), args, ctx.now)),
  );
}

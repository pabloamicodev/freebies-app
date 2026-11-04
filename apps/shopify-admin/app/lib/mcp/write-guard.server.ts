import type { Db } from "@promo/db";
import { requireRole, type McpRole, type Operator } from "./auth.server.js";
import type { ShopRef } from "./multi-shop.server.js";
import { ToolError } from "./result.server.js";
import { resolveWriteModes } from "./shops.server.js";

/**
 * Role first, then both shop locks (env MCP_WRITE_SHOPS AND app_settings `mcp.writeMode` = write).
 * An admin still gets SHOP_READ_ONLY on a shop that is not unlocked.
 */
export async function assertWriteAllowed(
  db: Db,
  env: NodeJS.ProcessEnv,
  operator: Operator,
  shopList: ShopRef[],
  minimumRole: McpRole,
): Promise<void> {
  requireRole(operator, minimumRole);
  const modes = await resolveWriteModes(db, shopList, env);
  for (const shop of shopList) {
    if (modes.get(shop.id) === "write") continue;
    throw new ToolError(
      "SHOP_READ_ONLY",
      `${shop.myshopifyDomain} is read-only for the MCP. Writes need the shop in MCP_WRITE_SHOPS and its mcp.writeMode set to write; ask the owner to enable it.`,
      {
        suggestedAction: {
          mcp: "promo-engine",
          tool: "mcp_whoami",
          args: {},
          why: "Check which shops are write-enabled (writeMode) and run the write there, or ask the owner.",
        },
      },
    );
  }
}

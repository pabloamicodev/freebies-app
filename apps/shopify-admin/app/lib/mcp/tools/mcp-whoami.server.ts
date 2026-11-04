import type { Db } from "@promo/db";
import type { Operator } from "../auth.server.js";
import { buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { resolveWriteModes, type VisibleShop, type WriteMode } from "../shops.server.js";

export const mcpWhoamiInput = {};

export type WhoamiData = {
  operator: { id: string; email: string; name: string; role: Operator["role"]; shopAccess: "all" | "list" | "none" };
  shops: { shopDomain: string; shopHandle: string; currency: string; timezone: string; writeMode: WriteMode }[];
  server: { name: "promo-engine"; phase: number; writeEnabledShops: string[] };
};

/** Who is calling, with which role, which shops they see and which of them accept writes. No secrets. */
export async function mcpWhoami(
  db: Db,
  operator: Operator,
  visible: VisibleShop[],
  env: NodeJS.ProcessEnv,
  now: () => Date = () => new Date(),
): Promise<ToolResult<WhoamiData>> {
  const modes = await resolveWriteModes(db, visible, env);
  const rows = visible.map((s) => ({
    shopDomain: s.myshopifyDomain,
    shopHandle: shopHandle(s.myshopifyDomain),
    currency: s.currencyCode,
    timezone: s.timezone,
    writeMode: modes.get(s.id) ?? ("read_only" as const),
  }));
  const writable = rows.filter((r) => r.writeMode === "write").map((r) => r.shopDomain);
  const shopAccess = operator.shopAllowList.includes("*") ? "all" : operator.shopAllowList.length ? "list" : "none";
  const summary = [
    `You are ${operator.name} <${operator.email}> with the ${operator.role} role.`,
    `${rows.length} shop(s) visible (${shopAccess === "all" ? "all-shops access" : shopAccess === "list" ? "allow list" : "no shop access"}).`,
    writable.length ? `Write enabled on: ${writable.join(", ")}.` : "No visible shop is write-enabled; everything is read-only.",
  ].join("\n");
  return buildResult(
    {
      summary,
      data: {
        operator: { id: operator.id, email: operator.email, name: operator.name, role: operator.role, shopAccess },
        shops: rows,
        server: { name: "promo-engine", phase: 4, writeEnabledShops: writable },
      },
      nextActions: rows.length
        ? [{ mcp: "promo-engine", tool: "shops_list", args: {}, why: "See offers and health per shop.", risk: "read" }]
        : [],
    },
    now,
  );
}

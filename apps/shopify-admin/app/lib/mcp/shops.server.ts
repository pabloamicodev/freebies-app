import { and, eq, isNull, inArray } from "drizzle-orm";
import { appSettings, shops, type Db } from "@promo/db";
import type { Operator } from "./auth.server.js";
import { ToolError, shopHandle } from "./result.server.js";
import type { ShopRef } from "./multi-shop.server.js";

export type WriteMode = "read_only" | "write";

export type VisibleShop = ShopRef & {
  name: string;
  planName: string | null;
  installedAt: Date;
  publishPendingAt: Date | null;
};

export const WRITE_MODE_SETTING_KEY = "mcp.writeMode";

/** Active installed shops the operator may see (allow list empty = all). */
export async function visibleShops(db: Db, operator: Operator): Promise<VisibleShop[]> {
  const rows = await db
    .select()
    .from(shops)
    .where(and(isNull(shops.uninstalledAt), eq(shops.isActive, true)))
    .orderBy(shops.myshopifyDomain);
  return rows
    .filter((s) => operator.shopAllowList.length === 0 || operator.shopAllowList.includes(s.myshopifyDomain))
    .map((s) => ({
      id: s.id,
      myshopifyDomain: s.myshopifyDomain,
      timezone: s.timezone,
      currencyCode: s.currencyCode,
      name: shopHandle(s.myshopifyDomain),
      planName: s.planName,
      installedAt: s.installedAt,
      publishPendingAt: s.publishPendingAt,
    }));
}

/** Accepts `x.myshopify.com`, the handle `x`, or the shops.id uuid. Omitted = every visible shop. */
export function selectShops(visible: VisibleShop[], requested?: string[]): VisibleShop[] {
  if (!requested || requested.length === 0) return visible;
  return requested.map((ref) => {
    const wanted = ref.trim().toLowerCase();
    const found = visible.find(
      (s) =>
        s.id === wanted ||
        s.myshopifyDomain.toLowerCase() === wanted ||
        shopHandle(s.myshopifyDomain).toLowerCase() === wanted,
    );
    if (!found) throw new ToolError("SHOP_NOT_FOUND", `Shop "${ref}" does not exist or is not visible to you.`, {
      suggestedAction: { mcp: "promo-engine", tool: "shops_list", args: {}, why: "List the shops you can see." },
    });
    return found;
  });
}

export function writeShopsFromEnv(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env["MCP_WRITE_SHOPS"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Both locks must allow: the env list AND the per-shop app_settings `mcp.writeMode` = "write". */
export async function resolveWriteModes(
  db: Db,
  shopList: ShopRef[],
  env: NodeJS.ProcessEnv,
): Promise<Map<string, WriteMode>> {
  const allowed = writeShopsFromEnv(env);
  const modes = new Map<string, WriteMode>();
  if (shopList.length === 0) return modes;
  const rows = await db
    .select({ shopId: appSettings.shopId, value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.key, WRITE_MODE_SETTING_KEY), inArray(appSettings.shopId, shopList.map((s) => s.id))));
  const setting = new Map(rows.map((r) => [r.shopId, parseSetting(r.value)]));
  for (const shop of shopList) {
    const envOk = allowed.has(shop.myshopifyDomain.toLowerCase());
    modes.set(shop.id, envOk && setting.get(shop.id) === "write" ? "write" : "read_only");
  }
  return modes;
}

function parseSetting(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return raw;
  }
}

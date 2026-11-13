import { and, eq, isNull } from "drizzle-orm";
import { appSettings, shops, type Db } from "@promo/db";
import { canSeeShop, type Operator } from "./auth.server.js";
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

/** Active installed shops the operator may see (allow list: explicit domains, "*" = all, empty = none). */
export async function visibleShops(db: Db, operator: Operator): Promise<VisibleShop[]> {
  const rows = await db
    .select()
    .from(shops)
    .where(and(isNull(shops.uninstalledAt), eq(shops.isActive, true)))
    .orderBy(shops.myshopifyDomain);
  return rows
    .filter((s) => canSeeShop(operator.shopAllowList, s.myshopifyDomain))
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

/** Owner 2026-11-13: every shop is writable for every authenticated operator; the stored per-shop setting no longer gates anything. */
export function resolveWriteModes(shopList: ShopRef[]): Map<string, WriteMode> {
  return new Map(shopList.map((shop) => [shop.id, "write" as const]));
}

function parseSetting(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return raw;
  }
}

/** CLI side of the legacy per-shop setting (informational since 2026-11-13, no tool reads it): `shop` is a myshopify domain or its handle. */
export async function setShopWriteMode(db: Db, shop: string, mode: WriteMode): Promise<{ myshopifyDomain: string; mode: WriteMode }> {
  const key = shop.trim().toLowerCase();
  const domain = key.includes(".") ? key : `${key}.myshopify.com`;
  const [row] = await db.select({ id: shops.id, myshopifyDomain: shops.myshopifyDomain }).from(shops).where(eq(shops.myshopifyDomain, domain));
  if (!row) throw new Error(`no such shop: ${shop}`);
  const value = JSON.stringify(mode);
  await db
    .insert(appSettings)
    .values({ shopId: row.id, key: WRITE_MODE_SETTING_KEY, value })
    .onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value, updatedAt: new Date() } });
  return { myshopifyDomain: row.myshopifyDomain, mode };
}

/** Stored per-shop setting only (a missing or unknown value reads as read_only); informational, writes never check it. */
export async function listShopWriteModes(db: Db): Promise<{ myshopifyDomain: string; mode: WriteMode }[]> {
  const rows = await db
    .select({ myshopifyDomain: shops.myshopifyDomain, value: appSettings.value })
    .from(shops)
    .leftJoin(appSettings, and(eq(appSettings.shopId, shops.id), eq(appSettings.key, WRITE_MODE_SETTING_KEY)))
    .orderBy(shops.myshopifyDomain);
  return rows.map((r) => ({ myshopifyDomain: r.myshopifyDomain, mode: r.value !== null && parseSetting(r.value) === "write" ? "write" : "read_only" }));
}

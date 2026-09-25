import { and, eq } from "drizzle-orm";
import { getDb, shops } from "@promo/db";

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const CUSTOMER_GID_PATTERN = /^gid:\/\/shopify\/Customer\/(\d+)$/;

/** `dest` of a verified checkout / customer-account session token. */
export function shopDomainFromDest(dest: unknown): string {
  const domain = typeof dest === "string" ? dest.replace(/^https:\/\//, "").replace(/\/+$/, "") : "";
  if (!SHOP_DOMAIN_PATTERN.test(domain)) throw new Response("Unauthorized", { status: 401 });
  return domain;
}

/** Numeric customer id from a session token `sub` (only present for logged-in buyers). */
export function customerIdFromSub(sub: unknown): string | null {
  if (typeof sub !== "string") return null;
  return CUSTOMER_GID_PATTERN.exec(sub)?.[1] ?? null;
}

export async function getActiveShop(shopDomain: string) {
  const db = getDb();
  const rows = await db
    .select({ id: shops.id, currencyCode: shops.currencyCode, accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(and(eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)))
    .limit(1);

  const shop = rows[0];
  if (!shop) throw new Response("Shop not found or app uninstalled", { status: 404 });
  return { ...shop, shopDomain, db };
}

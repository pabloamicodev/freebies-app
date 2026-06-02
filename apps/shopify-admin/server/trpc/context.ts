/**
 * tRPC context factory — extracts shopId from Shopify session.
 * Used by React Router action/loader wrappers.
 */

import type { TRPCContext } from "./router.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";

export async function createContext(shopDomain: string): Promise<TRPCContext> {
  const db = getDb();
  const [shop] = await db.select({ id: shops.id })
    .from(shops)
    .where(eq(shops.myshopifyDomain, shopDomain))
    .limit(1);

  return {
    shopId: shop?.id ?? "",
    shopDomain,
  };
}

import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";

export interface ShopContext {
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"];
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"];
  shopDomain: string;
  shopId: string;
  currencyCode: string;
  db: ReturnType<typeof getDb>;
}

export async function getShopContext(request: Request): Promise<ShopContext> {
  const adminContext = await authenticate.admin(request);
  const { admin, session } = adminContext;
  const db = getDb();

  const shopRows = await db
    .select({ id: shops.id, currencyCode: shops.currencyCode })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  return {
    admin,
    session,
    shopDomain: session.shop,
    shopId: shopRows[0]?.id ?? "",
    currencyCode: shopRows[0]?.currencyCode ?? "USD",
    db,
  };
}

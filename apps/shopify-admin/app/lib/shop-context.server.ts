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

  const shopRow = shopRows[0];
  if (!shopRow) throw new Response("Shop not found — re-install the app", { status: 404 });

  return {
    admin,
    session,
    shopDomain: session.shop,
    shopId: shopRow.id,
    currencyCode: shopRow.currencyCode ?? "USD",
    db,
  };
}

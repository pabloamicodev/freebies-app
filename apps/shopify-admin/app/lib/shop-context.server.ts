import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";

export interface ShopContext {
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"];
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"];
  shopDomain: string;
  shopId: string;
  currencyCode: string;
  /** IANA timezone (e.g. "America/New_York") — fetched from Admin API at install, used to
   * interpret wizard/schedule "local time" inputs as wall-clock in the shop's own zone. */
  timezone: string;
  db: ReturnType<typeof getDb>;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function getShopContext(request: Request): Promise<ShopContext> {
  const adminContext = await authenticate.admin(request);
  const { admin, session } = adminContext;
  const db = getDb();

  const shopRows = await db
    .select({ id: shops.id, currencyCode: shops.currencyCode, timezone: shops.timezone })
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
    timezone: shopRow.timezone && isValidTimeZone(shopRow.timezone) ? shopRow.timezone : "UTC",
    db,
  };
}

import { authenticate } from "../shopify.server.js";
import { getDb, shops, offers } from "@promo/db";
import { eq } from "drizzle-orm";

export interface OfferContext {
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"];
  shopDomain: string;
  shopId: string;
  currencyCode: string;
  db: ReturnType<typeof getDb>;
  offer: typeof offers.$inferSelect;
}

export async function getOfferContext(
  request: Request,
  offerId: string,
): Promise<OfferContext> {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const [shopRows, offerRows] = await Promise.all([
    db
      .select({ id: shops.id, currencyCode: shops.currencyCode })
      .from(shops)
      .where(eq(shops.myshopifyDomain, session.shop))
      .limit(1),
    db
      .select()
      .from(offers)
      .where(eq(offers.id, offerId))
      .limit(1),
  ]);

  const shopId = shopRows[0]?.id ?? "";
  const offer = offerRows[0];

  if (!offer || offer.shopId !== shopId) {
    throw new Response("Not found", { status: 404 });
  }

  return {
    session,
    shopDomain: session.shop,
    shopId,
    currencyCode: shopRows[0]?.currencyCode ?? "USD",
    db,
    offer,
  };
}

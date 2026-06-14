import { offers, type Db, type Offer } from "@promo/db";
import { and, eq } from "drizzle-orm";

export async function loadOwnedOffer(db: Db, shopId: string, offerId: string): Promise<Offer> {
  const rows = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)))
    .limit(1);

  const offer = rows[0];
  if (!offer) throw new Response("Not found", { status: 404 });
  return offer;
}

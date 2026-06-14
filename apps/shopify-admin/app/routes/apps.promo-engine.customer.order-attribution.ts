import type { LoaderFunctionArgs } from "react-router";
import { analyticsEvents } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const { id: shopId, db } = await getSignedShop(request);
  const url = new URL(request.url);
  const orderGid = url.searchParams.get("order_gid");
  if (!orderGid) return Response.json({ attributedOffers: [] });

  const events = await db
    .select({
      offerId: analyticsEvents.offerId,
      eventName: analyticsEvents.eventName,
      properties: analyticsEvents.properties,
    })
    .from(analyticsEvents)
    .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.orderId, orderGid)));

  return Response.json({
    attributedOffers: events.flatMap((event) => event.offerId ? [{ offerId: event.offerId, eventName: event.eventName }] : []),
  });
}

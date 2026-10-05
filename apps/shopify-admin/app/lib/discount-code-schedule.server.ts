import { and, eq, isNotNull, isNull, lte, gt, or, sql } from "drizzle-orm";
import { discountCodes, offers, shops, type Db } from "@promo/db";
import { publishShopConfig } from "./offer-publish-flow.server.js";

/**
 * Shops whose live Shopify code nodes disagree with the codes' own windows:
 * a code whose start passed (or whose publish failed earlier) and isn't on its
 * node yet, or a code whose end passed while it's still on the node. Both are
 * fixed by a normal publish.
 */
export async function findShopsWithDueCodeChanges(
  db: Db,
  now: Date,
): Promise<Array<{ shopId: string; shopDomain: string }>> {
  const rows = await db
    .selectDistinct({ shopId: discountCodes.shopId, shopDomain: shops.myshopifyDomain })
    .from(discountCodes)
    .innerJoin(offers, eq(offers.id, discountCodes.offerId))
    .innerJoin(shops, and(eq(shops.id, discountCodes.shopId), eq(shops.isActive, true)))
    .where(
      and(
        eq(offers.status, "active"),
        eq(offers.codeRedemption, "checkout_code"),
        or(
          and(
            eq(discountCodes.status, "active"),
            isNull(discountCodes.shopifySyncedAt),
            or(isNull(discountCodes.startsAt), lte(discountCodes.startsAt, now)),
            or(isNull(discountCodes.endsAt), gt(discountCodes.endsAt, now)),
            or(
              isNull(discountCodes.usageLimit),
              sql`${discountCodes.usageCount} < ${discountCodes.usageLimit}`,
            ),
          ),
          and(
            isNotNull(discountCodes.shopifySyncedAt),
            or(
              and(isNotNull(discountCodes.endsAt), lte(discountCodes.endsAt, now)),
              sql`${discountCodes.status} <> 'active'`,
            ),
          ),
        ),
      ),
    );
  return rows;
}

export async function runDiscountCodeSchedule(
  db: Db,
  now = new Date(),
  publish: typeof publishShopConfig = publishShopConfig,
): Promise<{
  shops: number;
  failures: Array<{ shopId: string; shopDomain: string; error: string }>;
}> {
  const due = await findShopsWithDueCodeChanges(db, now);
  const failures: Array<{ shopId: string; shopDomain: string; error: string }> = [];
  for (const shop of due) {
    const error = await publish(shop.shopId, shop.shopDomain);
    if (error) failures.push({ ...shop, error });
  }
  return { shops: due.length, failures };
}

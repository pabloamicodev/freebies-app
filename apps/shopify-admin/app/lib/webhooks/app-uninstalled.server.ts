import { offers, shops, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";

export interface SessionStorageLike {
  findSessionsByShop(shop: string): Promise<Array<{ id: string }>>;
  deleteSessions(ids: string[]): Promise<boolean>;
}

// Shopify revokes the access token before this webhook is delivered, so no
// Admin API calls are possible here: gift clone products and the discount's
// function_config metafield stay in the store. Only local state is cleaned up.
// Every step is idempotent so Shopify retries (on 503) are safe.
export async function handleAppUninstalled(
  db: Db,
  sessionStorage: SessionStorageLike,
  shop: string,
  triggeredAt: string | null,
): Promise<void> {
  // Shopify can deliver/retry this webhook after a faster reinstall already
  // happened (afterAuth sets installedAt=now()). Trust the reinstall over a
  // stale uninstall: otherwise the reinstalled shop loses its discount ids
  // and gets archived offers moments after coming back up.
  if (triggeredAt) {
    const triggeredDate = new Date(triggeredAt);
    if (!Number.isNaN(triggeredDate.getTime())) {
      const [current] = await db
        .select({ installedAt: shops.installedAt })
        .from(shops)
        .where(eq(shops.myshopifyDomain, shop))
        .limit(1);
      if (current && current.installedAt > triggeredDate) {
        console.info(`[webhooks] APP_UNINSTALLED skipped: shop reinstalled after trigger — shop=${shop}`);
        return;
      }
    }
  }

  const [shopRecord] = await db
    .update(shops)
    .set({
      isActive: false,
      uninstalledAt: new Date(),
      // Cleared so a reinstall can't inherit a discount node Shopify may have
      // deleted (or that a slow ensureDiscountNodes call would otherwise
      // trust without verifying — see discount-node.server.ts).
      discountId: null,
      deliveryDiscountId: null,
    })
    .where(eq(shops.myshopifyDomain, shop))
    .returning({ id: shops.id });

  if (shopRecord) {
    await db
      .update(offers)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(offers.shopId, shopRecord.id), eq(offers.status, "active")));
  }

  const sessions = await sessionStorage.findSessionsByShop(shop);
  if (sessions.length > 0) await sessionStorage.deleteSessions(sessions.map((s) => s.id));
}

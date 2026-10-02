import { appSettings, offers, shops, type Db } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import { CODED_SHIPPING_POOL_SETTING, CODE_NODE_SETTING } from "../discount-node.server.js";
import { PUBLISH_MANIFEST_SETTING } from "../publish-manifest.server.js";
import { recordUninstallArchive } from "../restore-archived-offers.server.js";
import { invalidateOfferDefinitions } from "../offer-definitions.server.js";
import { invalidateShopCache } from "../proxy-shop.server.js";

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
    // Remember which offers THIS uninstall archived, so a reinstall can offer to restore exactly them.
    const active = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.shopId, shopRecord.id), eq(offers.status, "active")));
    await recordUninstallArchive(
      db,
      shopRecord.id,
      active.map((offer) => offer.id),
    );
    await db
      .update(offers)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(offers.shopId, shopRecord.id), eq(offers.status, "active")));
    // Shopify deletes the app's discount nodes with the app: ids and manifests we kept are now stale.
    await db
      .delete(appSettings)
      .where(
        and(
          eq(appSettings.shopId, shopRecord.id),
          inArray(appSettings.key, [CODE_NODE_SETTING, CODED_SHIPPING_POOL_SETTING, PUBLISH_MANIFEST_SETTING]),
        ),
      );
  }

  // The storefront proxy caches the shop row and its offer definitions for ~30 s: drop both now.
  await invalidateShopCache(shop);
  if (shopRecord) await invalidateOfferDefinitions(shopRecord.id);

  const sessions = await sessionStorage.findSessionsByShop(shop);
  if (sessions.length > 0) await sessionStorage.deleteSessions(sessions.map((s) => s.id));
}

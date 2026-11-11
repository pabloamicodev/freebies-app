/**
 * Turns the per-shop "remove an auto-added gift Shopify did not discount" flag on or off (default OFF).
 *
 *   pnpm tsx scripts/set-remove-unfunded-gifts.ts <shop-domain> status|on|off
 *
 * Needs DATABASE_URL (.env / .env.local). The flag reaches the storefront as the app-installation metafield
 * promo_engine.remove_unfunded_gifts, written on publish: republish the shop afterwards (MCP promos_republish_shop or any offer save).
 */
import process from "node:process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { and, eq } from "drizzle-orm";

for (const file of [".env", ".env.local"]) {
  if (existsSync(resolve(file))) process.loadEnvFile(resolve(file));
}

const [shopDomain, action = "status"] = process.argv.slice(2);
if (!shopDomain || !["status", "on", "off"].includes(action)) {
  console.error("usage: set-remove-unfunded-gifts.ts <shop-domain> status|on|off");
  process.exit(2);
}

async function main(): Promise<void> {
  const { getDb, shops, appSettings } = await import("@promo/db");
  const db = getDb();
  const KEY = "storefront.remove_unfunded_gifts";

  const [shop] = await db.select({ id: shops.id, domain: shops.shopDomain }).from(shops).where(eq(shops.shopDomain, shopDomain));
  if (!shop) {
    console.error(`shop ${shopDomain} not found`);
    process.exit(1);
  }

  if (action !== "status") {
    const value = action === "on" ? "true" : "false";
    await db
      .insert(appSettings)
      .values({ shopId: shop.id, key: KEY, value })
      .onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value, updatedAt: new Date() } });
  }

  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, KEY)));
  console.info(`${shop.domain} ${KEY} = ${row?.value ?? "(unset -> false)"}`);
  if (action !== "status") console.info("republish the shop afterwards so the metafield reaches the storefront");
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });

/**
 * Turns the per-shop Function shards flag on or off (FIX-cap-04 rollout).
 *
 *   pnpm tsx scripts/set-function-shards.ts <shop-domain> status|on|off [--domains on|off]
 *
 * `--domains` sets function_shards.combination_domains (FIX-cap-12: nodes split by combination group, default on).
 *
 * Needs DATABASE_URL (.env / .env.local). The flag is read at publish time, so
 * republish the shop afterwards (MCP promos_republish_shop or any offer save).
 */
import process from "node:process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { and, eq } from "drizzle-orm";

for (const file of [".env", ".env.local"]) {
  if (existsSync(resolve(file))) process.loadEnvFile(resolve(file));
}

const args = process.argv.slice(2);
const domainsAt = args.indexOf("--domains");
const domainsAction = domainsAt >= 0 ? args[domainsAt + 1] : undefined;
if (domainsAt >= 0) args.splice(domainsAt, 2);
const [shopDomain, action = "status"] = args;
if (!shopDomain || !["status", "on", "off"].includes(action) || (domainsAt >= 0 && !["on", "off"].includes(domainsAction ?? ""))) {
  console.error("usage: set-function-shards.ts <shop-domain> status|on|off [--domains on|off]");
  process.exit(2);
}

async function main(): Promise<void> {
  const { getDb, shops, appSettings } = await import("@promo/db");
  const db = getDb();
  const KEY = "function_shards.enabled";

  const [shop] = await db
    .select({ id: shops.id, domain: shops.shopDomain })
    .from(shops)
    .where(eq(shops.shopDomain, shopDomain));
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
  console.log(`${shop.domain} ${KEY} = ${row?.value ?? "(unset → true)"}`);

  const DOMAINS_KEY = "function_shards.combination_domains";
  if (domainsAction) {
    const value = domainsAction === "on" ? "true" : "false";
    await db
      .insert(appSettings)
      .values({ shopId: shop.id, key: DOMAINS_KEY, value })
      .onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value, updatedAt: new Date() } });
  }
  const [domains] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, DOMAINS_KEY)));
  console.log(`${shop.domain} ${DOMAINS_KEY} = ${domains?.value ?? "(unset -> true)"}`);
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });

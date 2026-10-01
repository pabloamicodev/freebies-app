/**
 * Re-syncs variant_cache for a shop's gift and fallback variants from Shopify's live stock.
 * DRY-RUN by default (reads Shopify + DB, prints the rows that would change); pass --apply to write.
 *
 *   tsx scripts/resync-gift-variants.ts <shop.myshopify.com> [--apply] [--env path/to/.env]
 */
import process from "node:process";

const args = process.argv.slice(2);
const shopDomain = args.find((arg) => arg.endsWith(".myshopify.com"));
const apply = args.includes("--apply");
const envIndex = args.indexOf("--env");
process.loadEnvFile(envIndex >= 0 ? args[envIndex + 1] : ".env");

if (!shopDomain) {
  console.error("usage: resync-gift-variants.ts <shop.myshopify.com> [--apply] [--env path]");
  process.exit(1);
}

async function main(): Promise<void> {
  const { getDb, shops } = await import("@promo/db");
  const { eq } = await import("drizzle-orm");
  const { reconcileGiftVariants } = await import("../apps/shopify-admin/app/lib/sync/gift-stock-reconcile.server.js");

  const [shop] = await getDb().select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, shopDomain)).limit(1);
  if (!shop) throw new Error(`Shop not found: ${shopDomain}`);

  const { sql } = await import("drizzle-orm");
  const columns = await getDb().execute(
    sql`select 1 from information_schema.columns where table_name = 'variant_cache' and column_name = 'inventory_tracked'`,
  );
  const trackedColumn = columns.length > 0;
  if (!trackedColumn) {
    if (apply) throw new Error("variant_cache.inventory_tracked is missing — run db:migrate first.");
    console.log("note: inventory_tracked column not migrated yet; 'tracked' shown as null in before");
  }
  const result = await reconcileGiftVariants(shop.id, { dryRun: !apply, trackedColumn });
  console.log(`${apply ? "APPLIED" : "DRY-RUN"} ${shopDomain}: checked ${result.checked}, ${result.changes.length} would change`);
  if (result.missing.length) console.log("not found in Shopify:", result.missing);
  for (const change of result.changes) {
    console.log(JSON.stringify(change));
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

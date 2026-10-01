/**
 * Re-syncs variant_cache from Shopify's live stock. DRY-RUN by default (reads Shopify + DB, prints
 * how many rows would change plus a sample); pass --apply to write.
 *
 *   tsx scripts/resync-gift-variants.ts <shop.myshopify.com ...> [--all] [--every-shop] [--apply]
 *                                       [--sample N] [--env path/to/.env]
 *
 *   --all          every cached variant of the shop (default: gift + fallback variants only)
 *   --every-shop   every installed shop instead of naming them
 */
import process from "node:process";

const out = (line: string) => process.stdout.write(`${line}\n`);
const args = process.argv.slice(2);
const flagValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const apply = args.includes("--apply");
const scope = args.includes("--all") ? "all" : "gift";
const sampleLimit = Number(flagValue("--sample") ?? 5);
process.loadEnvFile(flagValue("--env") ?? ".env");

async function main(): Promise<void> {
  const { getDb, shops } = await import("@promo/db");
  const { and, inArray, isNull, sql } = await import("drizzle-orm");
  const { reconcileShopVariants } = await import("../apps/shopify-admin/app/lib/sync/gift-stock-reconcile.server.js");
  const db = getDb();

  const named = args.filter((arg) => arg.endsWith(".myshopify.com"));
  if (named.length === 0 && !args.includes("--every-shop")) {
    throw new Error("usage: resync-gift-variants.ts <shop.myshopify.com ...> | --every-shop [--all] [--apply]");
  }
  const targets = await db
    .select({ id: shops.id, domain: shops.myshopifyDomain })
    .from(shops)
    .where(
      named.length > 0
        ? and(inArray(shops.myshopifyDomain, named), isNull(shops.uninstalledAt))
        : isNull(shops.uninstalledAt),
    );
  for (const name of named) {
    if (!targets.some((target) => target.domain === name)) out(`not found or uninstalled: ${name}`);
  }

  const columns = await db.execute(
    sql`select 1 from information_schema.columns where table_name = 'variant_cache' and column_name = 'inventory_tracked'`,
  );
  const trackedColumn = columns.length > 0;
  if (!trackedColumn) {
    if (apply) throw new Error("variant_cache.inventory_tracked is missing; run db:migrate first.");
    out("note: inventory_tracked column not migrated yet; 'tracked' shows as null in before");
  }

  for (const target of targets) {
    const result = await reconcileShopVariants(target.id, { dryRun: !apply, scope, sampleLimit, trackedColumn });
    out(
      `${apply ? "APPLIED" : "DRY-RUN"} ${target.domain} [${scope}]: checked ${result.checked}, ` +
        `${result.changed} ${apply ? "changed" : "would change"} ` +
        `(${result.stockChanged} real stock/availability, rest tracked-flag only), ${result.missing} not found in Shopify`,
    );
    for (const change of result.sample) out(`  ${JSON.stringify(change)}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);

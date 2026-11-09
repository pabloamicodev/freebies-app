/**
 * One-off: divides the x100 thresholds that zero-decimal shops (JPY, KRW, ...) saved before the unit fix.
 *
 *   tsx scripts/migrate-zero-decimal-thresholds.ts --before <ISO timestamp> [--shop <domain>]... [--env <file>] [--apply]
 *
 * Dry-run (default) only reads and prints each change. --apply writes, in one transaction per shop.
 * --before is required: rows updated at or after it are taken as already migrated (every write stamps updated_at with now,
 * so a second run is a no-op). Use the moment the unit fix was deployed. Shops on two-decimal currencies are never read.
 * After --apply, republish the shop's active offers (the Functions read the compiled config, not these rows).
 */

import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function args(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg === flag && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

function loadEnvironment() {
  for (const file of [...args("--env"), ".env", ".env.local"]) {
    try {
      process.loadEnvFile(resolve(file));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code !== "ENOENT") throw error;
    }
  }
}

async function main() {
  const [beforeRaw] = args("--before");
  if (!beforeRaw) throw new Error("--before <ISO timestamp> is required (the moment the unit fix was deployed)");
  const before = new Date(beforeRaw);
  loadEnvironment();
  const apply = process.argv.includes("--apply");
  const [{ closeDb, getDb }, { migrateZeroDecimalThresholds }] = await Promise.all([
    import("@promo/db"),
    import("../apps/shopify-admin/app/lib/zero-decimal-migration.server.js"),
  ]);
  console.log(apply ? "APPLY mode: writing changes." : "DRY-RUN: no writes. Pass --apply to write.");
  try {
    const result = await migrateZeroDecimalThresholds(getDb(), { before, apply, shopDomains: args("--shop") });
    for (const change of result.changes) {
      console.log(`${change.shop} ${change.table} ${change.id} (offer ${change.offerId}) ${change.field}: ${change.from} -> ${change.to}`);
    }
    for (const skip of result.skipped) console.log(`SKIPPED ${skip.shop} ${skip.table} ${skip.id}: ${skip.reason}`);
    console.log(`summary: shops=${result.shopsScanned} changes=${result.changes.length} skipped=${result.skipped.length} rowsWritten=${result.rowsWritten}`);
  } finally {
    await closeDb();
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

/**
 * Reconciles imported legacy-preset offers with the current preset.
 *
 *   tsx scripts/reconcile-legacy-presets.ts [--shop <domain>]... [--env <file>] [--apply]
 *
 * Dry-run (default) only reads and prints the per-offer diff. --apply writes: it imports
 * missing offers as drafts and rewrites pristine drafts. Active, paused, published or
 * hand-edited offers are never written; they are reported as "needs manual review".
 */

import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SHOPS = [
  "hpn-supplements.myshopify.com",
  "gettrusupps.myshopify.com",
  "ambrosia-nutraceuticals.myshopify.com",
];

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
  loadEnvironment();
  const apply = process.argv.includes("--apply");
  const shops = args("--shop");
  const [{ and, eq }, { closeDb, getDb, shops: shopsTable }, { getLegacyStorePreset }, { reconcileLegacyPreset }] =
    await Promise.all([
      import("drizzle-orm"),
      import("@promo/db"),
      import("../apps/shopify-admin/app/lib/legacy-store-presets.server.js"),
      import("../apps/shopify-admin/app/lib/legacy-preset-reconcile.server.js"),
    ]);

  console.log(apply ? "APPLY mode: writing changes." : "DRY-RUN: no writes. Pass --apply to write.");
  const db = getDb();
  try {
    for (const domain of shops.length ? shops : DEFAULT_SHOPS) {
      const preset = getLegacyStorePreset(domain);
      const [shop] = await db
        .select({ id: shopsTable.id })
        .from(shopsTable)
        .where(and(eq(shopsTable.myshopifyDomain, domain), eq(shopsTable.isActive, true)))
        .limit(1);
      console.log(`\n===== ${domain}`);
      if (!preset) {
        console.log("no preset for this shop");
        continue;
      }
      if (!shop) {
        console.log("not installed (no active shop row)");
        continue;
      }
      const { results, counts } = await reconcileLegacyPreset(db, shop.id, preset, { apply });
      const label = { import: "IMPORT (missing)", update: apply ? "UPDATED" : "WOULD UPDATE", in_sync: "in sync", manual_review: "NEEDS MANUAL REVIEW" } as const;
      for (const r of results) {
        console.log(`- ${r.key} [${r.status ?? "-"}]: ${label[r.action]}`);
        if (r.reasons.length) console.log(`    why: ${r.reasons.join("; ")}`);
        for (const line of r.diff) console.log(`    ${line}`);
      }
      console.log(`summary: ${JSON.stringify(counts)}`);
    }
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

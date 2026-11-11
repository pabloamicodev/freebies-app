/**
 * Republishes shops through the real publish flow (publishShopConfig) and prints the resulting discount_shards.
 *
 *   pnpm tsx scripts/republish-shop.ts <shop-domain>... [--all] [--plan]
 *
 * `--all` takes every shop. `--plan` is a dry run: only preflightCapacity, nothing is written to Shopify or the DB.
 * Unknown domains are refused before anything runs. Needs DATABASE_URL and the Shopify app env (.env / .env.local).
 */
import process from "node:process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

for (const file of [".env", ".env.local"]) {
  if (existsSync(resolve(file))) process.loadEnvFile(resolve(file));
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const plan = args.includes("--plan");
const domains = args.filter((a) => !a.startsWith("--"));
if (args.some((a) => a.startsWith("--") && a !== "--all" && a !== "--plan") || (!all && domains.length === 0)) {
  console.error("usage: republish-shop.ts <shop-domain>... [--all] [--plan]");
  process.exit(2);
}

async function main(): Promise<void> {
  const { getDb, shops } = await import("@promo/db");
  const { sql } = await import("drizzle-orm");
  const { publishShopConfig } = await import("../apps/shopify-admin/app/lib/offer-publish-flow.server.js");
  const { preflightCapacity } = await import("../apps/shopify-admin/app/lib/capacity-preflight.server.js");
  const { runPerShop } = await import("../apps/shopify-admin/app/lib/run-per-shop.js");
  const db = getDb();

  const rows = await db.select({ id: shops.id, domain: shops.shopDomain }).from(shops);
  const known = new Set(rows.map((r) => r.domain));
  const unknown = domains.filter((d) => !known.has(d));
  if (unknown.length > 0) {
    console.error(`unknown shop domain(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
  const targets = all ? rows : rows.filter((r) => domains.includes(r.domain));

  const one = async (shop: { id: string; domain: string }): Promise<boolean> => {
    if (plan) {
      const result = await preflightCapacity(db, shop.id, []);
      console.info(
        `${shop.domain}: ` +
          (result.ok
            ? `plan ok | slots=${result.plan.slots}/${result.plan.maxSlots} bytes=${result.plan.bytesPerSlot.join(",")} delivery=${result.plan.deliveryBytes}`
            : `BLOCKED ${result.code}: ${result.message}`),
      );
      return result.ok;
    }
    const error = await publishShopConfig(shop.id, shop.domain);
    const res = (await db.execute(
      sql`select slot, config_bytes, jsonb_array_length(unit_keys) as units from discount_shards where shop_id = ${shop.id} order by slot`,
    )) as unknown as { rows?: Array<{ slot: number; config_bytes: number; units: number }> } & Array<{ slot: number; config_bytes: number; units: number }>;
    const shards = (res.rows ?? res).map((r) => `slot${r.slot}=${r.config_bytes}B/${r.units}u`).join(" ");
    console.info(`${shop.domain}: ${error ?? "ok"} | ${shards || "(no shards)"}`);
    return error === null;
  };

  const failed = await runPerShop(targets, one);
  if (failed > 0) {
    console.error(`${failed} of ${targets.length} shop(s) failed`);
    process.exit(1);
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });

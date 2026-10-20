/**
 * Read-only review of per-customer/per-cart limits (design §5).
 *
 *   tsx scripts/limits-review.ts [--shop <domain>]... [--env <file>]
 *
 * Prints, per shop: (1) offers with a per-cart or per-customer limit set, (2) live offers with an
 * enabled one_use_per_customer condition, (3) title collisions among limited automatic offers.
 * Only SELECTs are issued.
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
  loadEnvironment();
  const only = args("--shop");
  const [{ sql }, { closeDb, getDb }] = await Promise.all([import("drizzle-orm"), import("@promo/db")]);
  const db = getDb();
  const rowsOf = async (query: ReturnType<typeof sql>) => {
    const res = (await db.execute(query)) as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    return Array.isArray(res) ? res : (res.rows ?? []);
  };
  const shopFilter = only.length ? sql`AND s.myshopify_domain IN (${sql.join(only.map((d) => sql`${d}`), sql`, `)})` : sql``;
  try {
    console.log("READ-ONLY: SELECT queries only.\n");

    console.log("== 1. Offers with a per-cart or per-customer limit (not archived)");
    console.table(
      await rowsOf(sql`
        SELECT s.myshopify_domain AS shop, o.id AS offer_id, o.internal_name, o.public_title, o.type, o.status,
               p.max_applications_per_cart AS max_per_cart,
               p.max_applications_per_customer AS max_per_customer,
               p.updated_at AS policy_updated_at
        FROM offer_combination_policies p
        JOIN offers o ON o.id = p.offer_id AND o.shop_id = p.shop_id
        JOIN shops s ON s.id = p.shop_id
        WHERE (p.max_applications_per_cart > 0 OR p.max_applications_per_customer > 0)
          AND o.status <> 'archived' ${shopFilter}
        ORDER BY s.myshopify_domain, o.status, o.internal_name`),
    );

    console.log("\n== 2. Offers with an enabled one_use_per_customer condition (enforced once limits ship)");
    console.table(
      await rowsOf(sql`
        SELECT s.myshopify_domain AS shop, o.id AS offer_id, o.internal_name, o.status, c.scope
        FROM offer_conditions c
        JOIN offers o ON o.id = c.offer_id AND o.shop_id = c.shop_id
        JOIN shops s ON s.id = c.shop_id
        WHERE c.condition_type = 'one_use_per_customer' AND c.is_enabled AND o.status <> 'archived' ${shopFilter}
        ORDER BY s.myshopify_domain, o.internal_name`),
    );

    console.log("\n== 3. Title collisions among automatic offers where at least one has a per-customer limit");
    console.table(
      await rowsOf(sql`
        WITH msg AS (
          SELECT o.shop_id, o.id, o.internal_name,
                 lower(coalesce(nullif(o.public_title, ''), o.internal_name)) AS message,
                 EXISTS (SELECT 1 FROM offer_combination_policies p
                         WHERE p.offer_id = o.id AND p.max_applications_per_customer > 0)
                 OR EXISTS (SELECT 1 FROM offer_conditions c
                            WHERE c.offer_id = o.id AND c.condition_type = 'one_use_per_customer' AND c.is_enabled) AS limited
          FROM offers o
          WHERE o.status <> 'archived' AND NOT o.requires_code AND o.required_discount_code IS NULL
        )
        SELECT s.myshopify_domain AS shop, m.message, array_agg(m.internal_name ORDER BY m.internal_name) AS offers
        FROM msg m JOIN shops s ON s.id = m.shop_id
        WHERE true ${shopFilter}
        GROUP BY s.myshopify_domain, m.message
        HAVING count(*) > 1 AND bool_or(m.limited)
        ORDER BY s.myshopify_domain, m.message`),
    );
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

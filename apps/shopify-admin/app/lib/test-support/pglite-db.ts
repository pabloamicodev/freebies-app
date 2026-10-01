import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../../../../packages/db/src/schema/index.js";
import type { Db } from "@promo/db";

/** In-process real Postgres with every repo migration applied, for integration tests. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: resolve(__dirname, "../../../../../packages/db/drizzle") });
  return { db: db as unknown as Db, close: () => client.close() };
}

export async function seedShop(db: Db, domain = "test-shop.myshopify.com"): Promise<string> {
  const [shop] = await db
    .insert(schema.shops)
    .values({ shopDomain: domain, myshopifyDomain: domain, accessTokenEncrypted: "x", isActive: true, currencyCode: "USD", timezone: "UTC" })
    .returning({ id: schema.shops.id });
  return shop!.id;
}

export async function seedOffer(
  db: Db,
  shopId: string,
  overrides: Partial<typeof schema.offers.$inferInsert> = {},
): Promise<string> {
  const name = overrides.internalName ?? `offer-${Math.random().toString(36).slice(2, 8)}`;
  const [offer] = await db
    .insert(schema.offers)
    .values({ shopId, type: "gift", status: "active", internalName: name, publicTitle: name, ...overrides })
    .returning({ id: schema.offers.id });
  return offer!.id;
}

/**
 * Runs pending Drizzle migrations under a Postgres advisory lock so two
 * concurrent Vercel production deploys (or a manual `db:migrate` run during a
 * deploy) can never apply migrations at the same time. `pg_advisory_lock`
 * requires holding the same connection across lock/unlock, so this uses a
 * single dedicated client rather than the pooled app connection.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { isLocalDatabaseUrl, normalizeDatabaseUrl } from "../src/connection-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "drizzle");

// Migrations must bypass the connection pooler (Neon requires unpooled URL for DDL) —
// mirrors drizzle.config.ts.
const rawUrl = process.env["DATABASE_URL_UNPOOLED"] ?? process.env["DATABASE_URL"] ?? "";
if (!rawUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required for migrations");
const databaseUrl = normalizeDatabaseUrl(rawUrl);

// Fixed key: migrations are one serialized operation for the whole database,
// not per-shop, so every migration run contends for the same lock.
const MIGRATION_LOCK_KEY = 7_27_271;

const sql = postgres(databaseUrl, {
  max: 1,
  ssl: isLocalDatabaseUrl(databaseUrl) ? false : { rejectUnauthorized: true },
});

try {
  await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
  console.log("[migrate] advisory lock acquired, applying migrations...");
  await migrate(drizzle(sql), { migrationsFolder });
  console.log("[migrate] completed");
} finally {
  await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch((err) => {
    console.error("[migrate] failed to release advisory lock", err instanceof Error ? err.message : err);
  });
  await sql.end();
}

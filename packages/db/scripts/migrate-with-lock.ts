/**
 * Runs pending Drizzle migrations under a Postgres advisory lock so two
 * concurrent Vercel production deploys (or a manual `db:migrate` run during a
 * deploy) can never apply migrations at the same time. The advisory lock is
 * per connection, so this uses a single dedicated client on the UNPOOLED
 * endpoint (see migrate-lib.ts: no pooled fallback).
 *
 * Safety nets: lock_timeout (DDL aborts instead of queueing behind live
 * traffic and blocking it), statement_timeout, and retry with backoff on
 * transient failures. drizzle applies all pending files in one transaction, so
 * a retry starts from a clean state. Policy: docs/RUNBOOK.md (migrations).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { isLocalDatabaseUrl, normalizeDatabaseUrl } from "../src/connection-url.js";
import { MIGRATION_LOCK_KEY, resolveMigrationSettings, retryTransient } from "./migrate-lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "drizzle");

const settings = resolveMigrationSettings(process.env);
const databaseUrl = normalizeDatabaseUrl(settings.url);

const sql = postgres(databaseUrl, {
  max: 1,
  ssl: isLocalDatabaseUrl(databaseUrl) ? false : { rejectUnauthorized: true },
  connection: {
    lock_timeout: settings.lockTimeoutMs,
    statement_timeout: settings.statementTimeoutMs,
  },
});

// pg_try_advisory_lock polled instead of pg_advisory_lock: lock_timeout would
// otherwise abort a deploy that is merely waiting for another deploy's migrate.
async function acquireAdvisoryLock(): Promise<void> {
  const deadline = Date.now() + settings.lockWaitMs;
  for (;;) {
    const [row] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked`;
    if (row?.locked) return;
    if (Date.now() > deadline) throw new Error(`[migrate] could not acquire advisory lock within ${settings.lockWaitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

try {
  await acquireAdvisoryLock();
  console.info("[migrate] advisory lock acquired, applying migrations...");
  await retryTransient(() => migrate(drizzle(sql), { migrationsFolder }), {
    attempts: settings.attempts,
    onRetry: (error, attempt) =>
      console.warn(`[migrate] attempt ${attempt} failed (${(error as { code?: string }).code ?? "error"}), retrying`),
  });
  console.info("[migrate] completed");
} finally {
  await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch((err) => {
    console.error("[migrate] failed to release advisory lock", err instanceof Error ? err.message : err);
  });
  await sql.end();
}

/**
 * Read-only: confirms every migration in drizzle/meta/_journal.json is recorded in
 * drizzle.__drizzle_migrations (matched by `when`, hash compared). Exits 1 on any gap.
 * Run: DATABASE_URL_UNPOOLED=... pnpm --filter @promo/db exec tsx scripts/verify-migration-journal.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { isLocalDatabaseUrl, normalizeDatabaseUrl } from "../src/connection-url.js";
import { diffMigrationJournal, migrationHash, resolveMigrationSettings, type JournalEntry } from "./migrate-lib.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const journal = (JSON.parse(readFileSync(path.join(root, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] }).entries.map(
  (entry) => ({ ...entry, hash: migrationHash(readFileSync(path.join(root, `${entry.tag}.sql`), "utf8")) }),
);

const url = normalizeDatabaseUrl(resolveMigrationSettings(process.env).url);
const sql = postgres(url, {
  max: 1,
  ssl: isLocalDatabaseUrl(url) ? false : { rejectUnauthorized: true },
  connection: { default_transaction_read_only: true },
});
try {
  const rows = await sql<{ hash: string; created_at: string }[]>`select hash, created_at from drizzle.__drizzle_migrations`;
  const result = diffMigrationJournal(journal, rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) })));
  console.info(`[journal] ${journal.length} in repo, ${rows.length} applied`);
  if (result.missing.length) console.error("[journal] NOT APPLIED:", result.missing.join(", "));
  if (result.hashMismatch.length) console.error("[journal] HASH MISMATCH (file edited after apply):", result.hashMismatch.join(", "));
  if (result.unknown.length) console.warn("[journal] applied but not in repo journal:", result.unknown.join(", "));
  process.exitCode = result.missing.length || result.hashMismatch.length ? 1 : 0;
} finally {
  await sql.end();
}

import { createHash } from "node:crypto";
import { isLocalDatabaseUrl } from "../src/connection-url.js";

export const MIGRATION_LOCK_KEY = 7_27_271;

export interface MigrationSettings {
  url: string;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  lockWaitMs: number;
  attempts: number;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * DDL must never go through Neon's transaction-mode pooler (advisory locks and
 * session settings are per backend connection). The pooled URL is therefore
 * only acceptable for a local database, never as a silent fallback.
 */
export function resolveMigrationSettings(env: NodeJS.ProcessEnv): MigrationSettings {
  const unpooled = env["DATABASE_URL_UNPOOLED"];
  const pooled = env["DATABASE_URL"];
  let url = unpooled;
  if (!url) {
    if (pooled && isLocalDatabaseUrl(pooled)) url = pooled;
    else throw new Error("DATABASE_URL_UNPOOLED is required for migrations (the pooled DATABASE_URL is not allowed for DDL)");
  }
  return {
    url,
    // Fail fast instead of queueing behind a long evaluate/sync transaction and
    // blocking every query that queues behind the DDL.
    lockTimeoutMs: intFromEnv(env, "MIGRATION_LOCK_TIMEOUT_MS", 5_000),
    statementTimeoutMs: intFromEnv(env, "MIGRATION_STATEMENT_TIMEOUT_MS", 120_000),
    lockWaitMs: intFromEnv(env, "MIGRATION_LOCK_WAIT_MS", 120_000),
    attempts: intFromEnv(env, "MIGRATION_ATTEMPTS", 4),
  };
}

const TRANSIENT_SQLSTATES = new Set(["55P03", "57014", "40P01", "40001", "57P01", "08006", "08003", "08000"]);
const TRANSIENT_NODE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECT_TIMEOUT"]);

/** lock_not_available, statement timeout, deadlock, serialization failure and dropped connections. */
export function isTransientMigrationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NODE_CODES.has(code);
}

export async function retryTransient<T>(
  run: (attempt: number) => Promise<T>,
  options: {
    attempts: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: unknown, attempt: number) => void;
  },
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= options.attempts || !isTransientMigrationError(error)) throw error;
      options.onRetry?.(error, attempt);
      await sleep((options.baseDelayMs ?? 2_000) * 2 ** (attempt - 1));
    }
  }
}

/**
 * Runs `run` under the migration advisory lock, retrying transient failures. The lock belongs to the
 * database connection: a connection-class error (ECONNRESET, 57P01, 08xxx...) silently drops it and postgres.js
 * reconnects with a fresh session, so every attempt takes the lock again before touching the schema. Taking it
 * twice on a surviving session is harmless (the final `pg_advisory_unlock_all` / session end releases it).
 */
export async function runLockedWithRetry<T>(
  acquireLock: () => Promise<void>,
  run: () => Promise<T>,
  options: Parameters<typeof retryTransient>[1],
): Promise<T> {
  return retryTransient(async () => {
    await acquireLock();
    return run();
  }, options) as Promise<T>;
}

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export interface AppliedMigration {
  hash: string;
  createdAt: number;
}

export function migrationHash(sqlFileContent: string): string {
  return createHash("sha256").update(sqlFileContent).digest("hex");
}

/**
 * drizzle records `created_at = journal.when` and `hash = sha256(sql file)`,
 * not the tag, so the journal is matched by timestamp and the hash is checked
 * to catch a file edited after it was applied.
 */
export function diffMigrationJournal(
  journal: Array<JournalEntry & { hash: string }>,
  applied: AppliedMigration[],
): { missing: string[]; hashMismatch: string[]; unknown: number[] } {
  const appliedByTime = new Map(applied.map((row) => [Number(row.createdAt), row]));
  const missing: string[] = [];
  const hashMismatch: string[] = [];
  for (const entry of journal) {
    const row = appliedByTime.get(entry.when);
    if (!row) missing.push(entry.tag);
    else if (row.hash !== entry.hash) hashMismatch.push(entry.tag);
  }
  const known = new Set(journal.map((entry) => entry.when));
  return {
    missing,
    hashMismatch,
    unknown: applied.map((row) => Number(row.createdAt)).filter((time) => !known.has(time)),
  };
}

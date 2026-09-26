import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";
import { isLocalDatabaseUrl, normalizeDatabaseUrl } from "./connection-url.js";

let _client: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (!_client) {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) throw new Error("DATABASE_URL environment variable is required");

    const normalizedUrl = normalizeDatabaseUrl(databaseUrl);
    _sql = postgres(normalizedUrl, {
      // Each serverless function instance holds its own pool against Neon's
      // pooler, which has a hard ceiling shared across every concurrent
      // instance. Raised from 3: the evaluate hot path plus background sync/cron
      // work was serializing on the old ceiling under moderate load.
      max: 8,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: isLocalDatabaseUrl(normalizedUrl) ? false : { rejectUnauthorized: true },
    });

    _client = drizzle(_sql, { schema });
  }
  return _client;
}

/**
 * Reserves a single dedicated connection from the pool. `pg_advisory_lock` /
 * `pg_advisory_unlock` must run on the same connection, which the normal
 * pooled `getDb()` client can't guarantee across awaits — callers must
 * release the reservation (and unlock) themselves, in a `finally`.
 */
export async function reserveConnection() {
  getDb(); // ensures _sql is initialized
  return _sql!.reserve();
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
    _client = null;
  }
}

export type Db = ReturnType<typeof getDb>;

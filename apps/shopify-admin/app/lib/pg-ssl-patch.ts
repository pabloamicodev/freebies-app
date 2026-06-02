/**
 * Monkey-patches pg.Pool to always enable SSL.
 *
 * WHY THIS EXISTS:
 * @shopify/shopify-app-session-storage-postgresql creates a pg.Pool internally
 * by manually decomposing the URL into host/user/password/database/port fields.
 * It completely IGNORES URL query parameters (sslmode=require, channel_binding=require).
 * It also does NOT pass any ssl option to the Pool.
 *
 * The Node.js `pg` library does NOT read PGSSLMODE from env vars (that's a libpq/C thing).
 * So the only reliable way to inject SSL is to patch pg.Pool before the library imports it.
 *
 * IMPORT ORDER: This file MUST be imported before any import of
 * @shopify/shopify-app-session-storage-postgresql.
 *
 * Node.js module cache ensures the patched pg.Pool is seen by all subsequent require('pg').
 */
import pg from "pg";

const OriginalPool = pg.Pool;

class SSLPool extends OriginalPool {
  constructor(config?: ConstructorParameters<typeof OriginalPool>[0]) {
    super({ ...config, ssl: { rejectUnauthorized: false } });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(pg as any).Pool = SSLPool;

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

let _client: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_client) {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) throw new Error("DATABASE_URL environment variable is required");

    const sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });

    _client = drizzle(sql, { schema });
  }
  return _client;
}

export type Db = ReturnType<typeof getDb>;

import { defineConfig } from "drizzle-kit";
import { normalizeDatabaseUrl } from "./src/connection-url.js";
import { resolveMigrationSettings } from "./scripts/migrate-lib.js";

// Same rule as migrate-with-lock: DDL never goes through the pooler. With no URL at all
// (drizzle-kit generate) there is nothing to connect to, so it stays empty.
const migrationUrl =
  process.env["DATABASE_URL_UNPOOLED"] || process.env["DATABASE_URL"] ? resolveMigrationSettings(process.env).url : "";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Migrations must bypass the connection pooler (Neon requires unpooled URL for DDL).
    // DATABASE_URL is accepted only for a local database.
    url: normalizeDatabaseUrl(migrationUrl),
  },
  verbose: true,
  strict: true,
});

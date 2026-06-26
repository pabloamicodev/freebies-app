import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Migrations must bypass the connection pooler (Neon requires unpooled URL for DDL).
    // Falls back to DATABASE_URL for local dev where there's no pooler.
    url: process.env["DATABASE_URL_UNPOOLED"] ?? process.env["DATABASE_URL"] ?? "",
  },
  verbose: true,
  strict: true,
});

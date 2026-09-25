import { execSync } from "node:child_process";

// Only production deploys migrate; previews may share the production database.
if (process.env.VERCEL_ENV === "production") {
  if (!process.env.DATABASE_URL_UNPOOLED) {
    throw new Error("DATABASE_URL_UNPOOLED is required for production migrations");
  }
  execSync("pnpm db:migrate", { stdio: "inherit" });
}

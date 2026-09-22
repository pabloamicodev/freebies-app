import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { sql } from "drizzle-orm";
import Redis from "ioredis";

export async function loader(_: LoaderFunctionArgs) {
  const checks: Record<string, "ok" | "fail" | "not_configured"> = {};

  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    checks["db"] = "ok";
  } catch {
    checks["db"] = "fail";
  }

  const redisUrl = process.env["REDIS_URL"];
  if (redisUrl) {
    try {
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 3000 });
      await redis.connect();
      await redis.ping();
      redis.disconnect();
      checks["redis"] = "ok";
    } catch {
      checks["redis"] = "fail";
    }
  } else {
    checks["redis"] = "not_configured";
  }

  // Missing required config is a hard failure, not just "degraded" — it means
  // the app can't function, not that it's slow.
  const requiredEnv = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "DATABASE_URL", "SHOPIFY_APP_URL"];
  const missingEnv = requiredEnv.filter((v) => !process.env[v]);
  checks["config"] = missingEnv.length === 0 ? "ok" : "fail";

  const allOk = Object.values(checks).every((v) => v === "ok" || v === "not_configured");

  return Response.json(
    {
      status: allOk ? "ok" : "degraded",
      checks,
      missingEnv: missingEnv.length > 0 ? missingEnv : undefined,
      version: process.env["VERCEL_GIT_COMMIT_SHA"] ?? null,
      deployedAt: process.env["VERCEL_DEPLOYMENT_ID"] ? new Date().toISOString() : null,
    },
    { status: allOk ? 200 : 503 },
  );
}

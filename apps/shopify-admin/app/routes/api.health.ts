import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { sql } from "drizzle-orm";
import { getSharedRedis, isRedisConfigured, resetSharedRedis } from "../lib/redis.server.js";

export async function loader(_: LoaderFunctionArgs) {
  const checks: Record<string, "ok" | "fail" | "not_configured"> = {};

  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    checks["db"] = "ok";
  } catch {
    checks["db"] = "fail";
  }

  if (isRedisConfigured()) {
    try {
      const redis = await getSharedRedis();
      if (!redis) throw new Error("Redis unavailable");
      await redis.ping();
      checks["redis"] = "ok";
    } catch {
      resetSharedRedis();
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
    { status: allOk ? "ok" : "degraded" },
    {
      status: allOk ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

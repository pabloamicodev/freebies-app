import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { sql } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { getSharedRedis, isRedisConfigured, resetSharedRedis } from "../lib/redis.server.js";
import { apiJson, getRequestId } from "../lib/api-response.server.js";
import {
  summarizeHealthChecks,
  type DependencyHealth,
} from "../lib/health-status.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const requestId = getRequestId(request);
  const checks: Record<string, DependencyHealth> = {};

  const dbStartedAt = performance.now();
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    checks["database"] = { status: "ok", critical: true, latencyMs: elapsedMs(dbStartedAt) };
  } catch (error) {
    checks["database"] = { status: "fail", critical: true, latencyMs: elapsedMs(dbStartedAt) };
    reportHealthFailure("database", requestId, error);
  }

  if (isRedisConfigured()) {
    const redisStartedAt = performance.now();
    try {
      const redis = await getSharedRedis();
      if (!redis) throw new Error("Redis unavailable");
      await redis.ping();
      checks["redis"] = { status: "ok", critical: false, latencyMs: elapsedMs(redisStartedAt) };
    } catch (error) {
      resetSharedRedis();
      checks["redis"] = {
        status: "degraded",
        critical: false,
        latencyMs: elapsedMs(redisStartedAt),
      };
      reportHealthFailure("redis", requestId, error);
    }
  } else {
    // Redis is an optional acceleration tier. Rate limiting remains enforced by
    // PostgreSQL when it is absent, so this is accurately healthy, not fail-open.
    checks["redis"] = { status: "not_configured", critical: false };
  }

  // Missing required config is a hard failure, not just "degraded" — it means
  // the app can't function, not that it's slow.
  const requiredEnv = [
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "DATABASE_URL",
    "SHOPIFY_APP_URL",
    ...((process.env["NODE_ENV"] ?? "production") === "production"
      ? ["TOKEN_ENCRYPTION_KEY", "CRON_SECRET"]
      : []),
  ];
  const missingEnv = requiredEnv.filter((v) => !process.env[v]);
  checks["configuration"] = {
    status: missingEnv.length === 0 ? "ok" : "fail",
    critical: true,
  };
  if (missingEnv.length > 0) {
    const error = new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);
    reportHealthFailure("configuration", requestId, error);
  }

  const summary = summarizeHealthChecks(checks);

  return apiJson(
    request,
    {
      status: summary.status,
      checks,
      requestId,
      timestamp: new Date().toISOString(),
    },
    {
      status: summary.statusCode,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function reportHealthFailure(check: string, requestId: string, error: unknown): void {
  Sentry.captureException(error, { tags: { route: "api.health", check, requestId } });
  console.error("[api.health] dependency check failed", {
    check,
    requestId,
    error: error instanceof Error
      ? { name: error.name, message: error.message, code: (error as Error & { code?: unknown }).code }
      : { name: "UnknownError", message: String(error) },
  });
}

import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { sql } from "drizzle-orm";

export async function loader(_: LoaderFunctionArgs) {
  const checks: Record<string, "ok" | "fail"> = {};

  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    checks["db"] = "ok";
  } catch {
    checks["db"] = "fail";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");

  return Response.json(
    { status: allOk ? "ok" : "degraded", checks },
    { status: allOk ? 200 : 503 },
  );
}

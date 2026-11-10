import { appSettings, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const FUNCTION_SHARDS_SETTING = "function_shards.enabled";

export async function isFunctionShardsEnabled(db: Db, shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, FUNCTION_SHARDS_SETTING)));
  // Default ON since 2026-11-10: only an explicit "false" keeps a shop on one node (kill-switch).
  if (!row) return process.env["FUNCTION_SHARDS_DEFAULT"] !== "off";
  return row.value === "true";
}

export const SHARD_DOMAINS_SETTING = "function_shards.combination_domains";

/**
 * Whether nodes are split by combination group (FIX-cap-12) instead of one policy for all nodes.
 * Default ON; only an explicit "false" turns a shop off, and the global env FUNCTION_SHARD_DOMAINS=off overrides every shop.
 */
export async function isShardDomainsEnabled(db: Db, shopId: string): Promise<boolean> {
  if (process.env["FUNCTION_SHARD_DOMAINS"] === "off") return false;
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, SHARD_DOMAINS_SETTING)));
  // FUNCTION_SHARD_DOMAINS_DEFAULT exists so test suites can start from single-node behavior; it is ignored outside
  // tests, so production can only switch the feature off with FUNCTION_SHARD_DOMAINS=off.
  const testDefault = process.env["NODE_ENV"] === "test" || process.env["VITEST"] ? process.env["FUNCTION_SHARD_DOMAINS_DEFAULT"] : undefined;
  if (!row) return testDefault !== "off";
  return row.value !== "false";
}

export async function setShardDomainsEnabled(db: Db, shopId: string, enabled: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ shopId, key: SHARD_DOMAINS_SETTING, value: String(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(enabled), updatedAt: new Date() },
    });
}

export async function setFunctionShardsEnabled(db: Db, shopId: string, enabled: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ shopId, key: FUNCTION_SHARDS_SETTING, value: String(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(enabled), updatedAt: new Date() },
    });
}

/**
 * A publish that can't take the per-shop advisory lock in time (Postgres 55P03) is not a failure of
 * the offer: another publish for the same shop is already running. The shop is flagged
 * `publishPendingAt` and retried in the background; the offers cron re-runs any shop still flagged
 * (`reconcileActiveShopDiscountNodes`). Offers are never paused because of it.
 */
import { getDb, shops } from "@promo/db";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { waitUntil } from "@vercel/functions";

export function isLockTimeoutError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "55P03") return true;
    if (typeof candidate.message === "string" && /lock timeout|canceling statement due to lock timeout/i.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export async function markPublishPending(shopId: string): Promise<void> {
  await getDb().update(shops).set({ publishPendingAt: new Date() }).where(eq(shops.id, shopId));
}

/** Clears the flag unless a newer request flagged the shop after `startedAt`. */
export async function clearPublishPending(shopId: string, startedAt: Date): Promise<void> {
  await getDb()
    .update(shops)
    .set({ publishPendingAt: null })
    .where(and(eq(shops.id, shopId), or(isNull(shops.publishPendingAt), lte(shops.publishPendingAt, startedAt))));
}

export async function isPublishPending(shopId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ pendingAt: shops.publishPendingAt })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  return Boolean(row?.pendingAt);
}

const RETRY_DELAYS_MS = [3_000, 10_000, 25_000];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Keeps retrying a lock-timed-out publish after the response went out. `publish` returns "pending"
 * when it timed out on the lock again. Anything left over is picked up by the cron.
 */
export function scheduleBackgroundPublishRetry(
  shopId: string,
  publish: () => Promise<"published" | "pending">,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<void> {
  const run = async () => {
    for (const delay of delays) {
      await sleep(delay);
      try {
        if ((await publish()) === "published") return;
      } catch (error) {
        Sentry.captureException(error, { tags: { shopId, context: "publish-pending-retry" } });
        return;
      }
    }
  };
  const promise = run();
  waitUntil(promise);
  return promise;
}

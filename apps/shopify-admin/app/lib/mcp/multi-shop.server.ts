import type { PerShop } from "./result.server.js";
import { shopHandle } from "./result.server.js";

export type ShopRef = { id: string; myshopifyDomain: string; timezone: string; currencyCode: string };

export type FanOutOptions = {
  concurrency?: number;
  timeoutMs?: number;
  /** Cache key parts besides the shop (tool name + args); omit to skip the cache. */
  cacheKey?: string;
  cacheTtlMs?: number;
  now?: () => number;
};

export type FanOutResult<T> = { perShop: PerShop[]; results: { shop: ShopRef; value: T }[] };

const cache = new Map<string, { expires: number; value: unknown }>();

export function clearFanOutCache(shopId?: string): void {
  if (!shopId) return cache.clear();
  for (const key of cache.keys()) if (key.includes(`|${shopId}|`)) cache.delete(key);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One shop failing or timing out never breaks the rest; each shop reports ok/error. */
export async function fanOut<T>(
  shops: ShopRef[],
  fn: (shop: ShopRef) => Promise<T>,
  options: FanOutOptions = {},
): Promise<FanOutResult<T>> {
  const { concurrency = 3, timeoutMs = 15_000, cacheKey, cacheTtlMs = 60_000, now = Date.now } = options;
  const outcomes: ({ ok: true; value: T } | { ok: false; reason: string })[] = new Array(shops.length);
  let next = 0;

  async function worker() {
    while (next < shops.length) {
      const index = next++;
      const shop = shops[index]!;
      const key = cacheKey ? `${cacheKey}|${shop.id}|` : null;
      const hit = key ? cache.get(key) : undefined;
      if (hit && hit.expires > now()) {
        outcomes[index] = { ok: true, value: hit.value as T };
        continue;
      }
      try {
        const value = await withTimeout(fn(shop), timeoutMs);
        if (key) cache.set(key, { expires: now() + cacheTtlMs, value });
        outcomes[index] = { ok: true, value };
      } catch (error) {
        outcomes[index] = { ok: false, reason: error instanceof Error && error.message === "timeout" ? "timeout" : "error" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, shops.length)) }, worker));

  const perShop: PerShop[] = [];
  const results: { shop: ShopRef; value: T }[] = [];
  shops.forEach((shop, index) => {
    const outcome = outcomes[index]!;
    perShop.push({
      shopDomain: shop.myshopifyDomain,
      shopHandle: shopHandle(shop.myshopifyDomain),
      shopTimezone: shop.timezone,
      currency: shop.currencyCode,
      status: outcome.ok ? "ok" : "error",
      ...(outcome.ok ? {} : { reason: outcome.reason }),
    });
    if (outcome.ok) results.push({ shop, value: outcome.value });
  });
  return { perShop, results };
}

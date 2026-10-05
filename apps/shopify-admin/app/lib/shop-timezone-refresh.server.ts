import { getDb, offers, shops, type Db } from "@promo/db";
import { and, eq, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { decryptToken } from "./token-crypto.server.js";
import { shopifyGraphQL } from "./shopify-fetch.server.js";

const THROTTLE_MS = 60 * 60 * 1000;
const lastAttempt = new Map<string, number>();

export function needsTimezoneRefresh(stored: string | null | undefined): boolean {
  return !stored || stored === "UTC";
}

function isRealZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz === "UTC" || tz === "Etc/UTC") return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Stores the shop zone and pins it on the shop's offers that followed it (NULL). Stored instants are untouched. */
export async function applyShopTimezone(db: Db, shopId: string, timezone: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(shops).set({ timezone }).where(eq(shops.id, shopId));
    await tx.update(offers).set({ timezone }).where(and(eq(offers.shopId, shopId), isNull(offers.timezone)));
  });
}

/** Fire-and-forget safe: never throws. Returns the new zone when the shop was updated. */
export async function refreshShopTimezone(opts: {
  shopId: string;
  storedTimezone: string | null | undefined;
  fetchZone: () => Promise<string | null | undefined>;
  db?: Db;
  now?: number;
}): Promise<string | null> {
  if (!needsTimezoneRefresh(opts.storedTimezone)) return null;
  const now = opts.now ?? Date.now();
  const last = lastAttempt.get(opts.shopId);
  if (last !== undefined && now - last < THROTTLE_MS) return null;
  lastAttempt.set(opts.shopId, now);
  try {
    const zone = await opts.fetchZone();
    if (!isRealZone(zone)) return null;
    await applyShopTimezone(opts.db ?? getDb(), opts.shopId, zone);
    return zone;
  } catch (error) {
    Sentry.captureException(error, { tags: { shopId: opts.shopId, context: "shop-timezone-refresh" } });
    return null;
  }
}

type AdminLike = { graphql: (query: string) => Promise<Response> };

export function adminZoneFetcher(admin: AdminLike) {
  return async () => {
    const res = await admin.graphql(`{ shop { ianaTimezone } }`);
    const json = (await res.json()) as { data?: { shop?: { ianaTimezone?: string } } };
    return json.data?.shop?.ianaTimezone ?? null;
  };
}

export function _resetTimezoneThrottleForTests() {
  lastAttempt.clear();
}

/** Cron heal: shops still on the UTC fallback, via their offline token. Throttled per shop like the request path. */
export async function refreshStaleShopTimezones(db: Db = getDb()): Promise<{ checked: number; updated: number }> {
  const rows = await db
    .select({ id: shops.id, domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted, timezone: shops.timezone })
    .from(shops)
    .where(and(eq(shops.isActive, true), eq(shops.timezone, "UTC")));
  let updated = 0;
  for (const row of rows) {
    const zone = await refreshShopTimezone({
      db,
      shopId: row.id,
      storedTimezone: row.timezone,
      fetchZone: async () => {
        const data = await shopifyGraphQL<{ shop: { ianaTimezone: string } }>({
          shopDomain: row.domain,
          accessToken: await decryptToken(row.token),
          query: `{ shop { ianaTimezone } }`,
          maxRetries: 1,
        });
        return data.shop.ianaTimezone;
      },
    });
    if (zone) updated += 1;
  }
  return { checked: rows.length, updated };
}

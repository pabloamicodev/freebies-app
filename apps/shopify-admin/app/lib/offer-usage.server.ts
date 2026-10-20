import { discountCodes, offerCombinationPolicies, offerConditions, offerCustomerUsages, offers, offerUsageSync, shops, type Db } from "@promo/db";
import { and, asc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import { clampDiscountMessage, normalizeOfferTitle } from "./discount-message.js";
import { decryptToken } from "./token-crypto.server.js";
import { shopifyGraphQL } from "./shopify-fetch.server.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Shopify omits metafield values over 10,000 B in Function input; stay under it. */
const MAX_VALUE_BYTES = 9_000;
export const USAGE_SYNC_MAX_ATTEMPTS = 10;
export const USAGE_SYNC_BATCH = 50;
const USAGE_SYNC_BUDGET_MS = 120_000;

const allocations = z.array(z.object({ amount: z.string() })).default([]);

/** Only what usage attribution reads from the orders/paid payload; validated at the webhook boundary. */
export const orderUsageSchema = z.object({
  admin_graphql_api_id: z.string().min(1),
  customer: z.object({ id: z.union([z.number(), z.string()]) }).nullish(),
  discount_applications: z
    .array(z.object({ type: z.string(), title: z.string().nullish(), code: z.string().nullish() }))
    .default([]),
  line_items: z
    .array(
      z.object({
        properties: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
        discount_allocations: allocations,
      }),
    )
    .default([]),
});
export type OrderUsagePayload = z.infer<typeof orderUsageSchema>;

export type UsageSource = "title" | "code" | "line";

const offerMessage = (o: { publicTitle: string; internalName: string }) => {
  const message = clampDiscountMessage(o.publicTitle) ?? clampDiscountMessage(o.internalName);
  return message === undefined ? undefined : normalizeOfferTitle(message);
};

export interface UsageOfferRow {
  id: string;
  publicTitle: string;
  internalName: string;
  requiresCode: boolean;
  requiredDiscountCode: string | null;
}

/** Automatic-discount titles, upper-cased codes and discounted gift-line offer ids found on an order. */
export function orderUsageSignals(order: OrderUsagePayload) {
  const automaticTitles = new Set(
    order.discount_applications.flatMap((a) => (a.type === "automatic" && a.title ? [normalizeOfferTitle(a.title)] : [])),
  );
  const codes = [
    ...new Set(
      order.discount_applications.flatMap((a) =>
        a.type === "discount_code" && a.code?.trim() ? [a.code.trim().toUpperCase()] : [],
      ),
    ),
  ];
  const discountedLineOfferIds = new Set(
    order.line_items.flatMap((line) =>
      line.discount_allocations.some((a) => Number.parseFloat(a.amount) > 0)
        ? line.properties.filter((p) => p.name === "_promo_engine_offer_id" && UUID_PATTERN.test(p.value)).map((p) => p.value.toLowerCase())
        : [],
    ),
  );
  return { automaticTitles, codes, discountedLineOfferIds };
}

/** Pure attribution: automatic offers by normalized title, gift lines by offer id, code offers via `codeOfferIds`. */
export function matchOrderOffers(
  signals: ReturnType<typeof orderUsageSignals>,
  rows: UsageOfferRow[],
  codeOfferIds: Iterable<string>,
): { result: Map<string, UsageSource>; titleMatches: string[] } {
  const result = new Map<string, UsageSource>();
  const titleMatches: string[] = [];
  for (const row of rows) {
    if (!row.requiresCode && !row.requiredDiscountCode) {
      const message = offerMessage(row);
      if (message && signals.automaticTitles.has(message)) {
        result.set(row.id, "title");
        titleMatches.push(row.id);
      }
    }
    if (!result.has(row.id) && signals.discountedLineOfferIds.has(row.id)) result.set(row.id, "line");
  }
  for (const id of codeOfferIds) result.set(id, "code");
  return { result, titleMatches };
}

/** Offers (and how) that discounted this order. Every offer of a title collision is counted (fails closed). */
export async function attributeOrderOffers(
  db: Db,
  shopId: string,
  order: OrderUsagePayload,
): Promise<Map<string, UsageSource>> {
  const signals = orderUsageSignals(order);
  const { automaticTitles, codes, discountedLineOfferIds } = signals;
  if (automaticTitles.size === 0 && codes.length === 0 && discountedLineOfferIds.size === 0) return new Map();

  let rows: UsageOfferRow[] = [];
  if (automaticTitles.size > 0 || discountedLineOfferIds.size > 0) {
    rows = await db
      .select({
        id: offers.id,
        publicTitle: offers.publicTitle,
        internalName: offers.internalName,
        requiresCode: offers.requiresCode,
        requiredDiscountCode: offers.requiredDiscountCode,
      })
      .from(offers)
      .where(and(eq(offers.shopId, shopId), ne(offers.status, "archived")));
  }
  let codeOfferIds: string[] = [];
  if (codes.length > 0) {
    const codeRows = await db
      .select({ offerId: discountCodes.offerId })
      .from(discountCodes)
      .where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.code, codes)));
    codeOfferIds = codeRows.map((r) => r.offerId);
  }
  const { result, titleMatches } = matchOrderOffers(signals, rows, codeOfferIds);
  if (titleMatches.length > 1) {
    Sentry.captureMessage("Automatic offers share a discount title; the order counts against all of them", {
      level: "warning",
      tags: { shopId, context: "offer-usage-title-collision" },
      extra: { offerIds: titleMatches },
    });
  }
  return result;
}

/** Records the order against each offer that discounted it. Idempotent per (shop, order, offer). */
export async function recordOfferUsages(
  db: Db,
  shopId: string,
  rawOrder: unknown,
): Promise<{ customerGid: string; inserted: number } | null> {
  const parsed = orderUsageSchema.safeParse(rawOrder);
  if (!parsed.success) {
    Sentry.captureMessage("orders/paid payload rejected by the usage schema", {
      level: "warning",
      tags: { shopId, context: "offer-usage-payload" },
      extra: { issues: parsed.error.issues.slice(0, 5) },
    });
    return null;
  }
  const order = parsed.data;
  if (order.customer?.id == null) return null;
  const customerGid = `gid://shopify/Customer/${order.customer.id}`;
  const attributed = await attributeOrderOffers(db, shopId, order);
  if (attributed.size === 0) return null;

  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(offerCustomerUsages)
      .values(
        [...attributed].map(([offerId, source]) => ({
          shopId,
          offerId,
          customerGid,
          orderGid: order.admin_graphql_api_id,
          source,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: offerCustomerUsages.id });
    if (rows.length > 0) {
      await tx
        .insert(offerUsageSync)
        .values({ shopId, customerGid, pendingSince: sql`now()` })
        .onConflictDoUpdate({
          target: [offerUsageSync.shopId, offerUsageSync.customerGid],
          set: { pendingSince: sql`now()`, attempts: 0 },
        });
    }
    return rows.length;
  });
  return { customerGid, inserted };
}

/** Compact, versioned value the Function parses: {"v":1,"u":{"<offerId>":count}}. */
export function encodeUsageValue(counts: Map<string, number>): string {
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  const build = (list: typeof entries) => JSON.stringify({ v: 1, u: Object.fromEntries(list) });
  let value = build(entries);
  while (value.length > MAX_VALUE_BYTES && entries.length > 0) {
    entries.pop();
    value = build(entries);
  }
  return value;
}

export type PushUsage = (args: { shopDomain: string; accessToken: string; customerGid: string; value: string }) => Promise<void>;

export const pushUsageMetafield: PushUsage = async ({ shopDomain, accessToken, customerGid, value }) => {
  const data = await shopifyGraphQL<{ metafieldsSet: { userErrors: Array<{ message: string }> } }>({
    shopDomain,
    accessToken,
    // Setting a metafield to a value is idempotent: a timed-out attempt may be re-sent.
    retryable: true,
    query: `mutation PromoEngineCustomerUsage($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    variables: {
      metafields: [{ ownerId: customerGid, namespace: "$app:promo_engine", key: "usage", type: "json", value }],
    },
  });
  const errors = data.metafieldsSet.userErrors;
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join(", "));
};

const MISSING_SCOPE = /access denied|ACCESS_DENIED|required access|write_customers/i;
const warnedShops = new Set<string>();

export type UsageSyncOutcome = "synced" | "skipped" | "missing-scope" | "failed" | "stale";

export const USAGE_SCOPE_COOLDOWN_MS = 60 * 60 * 1000;

async function currentUsageValue(db: Db, shopId: string, customerGid: string): Promise<string> {
  const rows = await db
    .select({ offerId: offerCustomerUsages.offerId, count: sql<number>`count(*)::int` })
    .from(offerCustomerUsages)
    .innerJoin(offers, eq(offers.id, offerCustomerUsages.offerId))
    .where(
      and(
        eq(offerCustomerUsages.shopId, shopId),
        eq(offerCustomerUsages.customerGid, customerGid),
        ne(offers.status, "archived"),
      ),
    )
    .groupBy(offerCustomerUsages.offerId);
  return encodeUsageValue(new Map(rows.map((r) => [r.offerId, r.count])));
}

/**
 * Pushes the customer's per-offer counts (recomputed from the table, never incremented) to their app
 * metafield. The pending mark is cleared only if no order landed since it was read, so a concurrent
 * order leaves the customer pending for the next pass.
 */
export async function syncCustomerUsageMetafield(
  db: Db,
  shopId: string,
  customerGid: string,
  push: PushUsage = pushUsageMetafield,
): Promise<UsageSyncOutcome> {
  const [pending] = await db
    .select({ since: sql<string | null>`${offerUsageSync.pendingSince}::text` })
    .from(offerUsageSync)
    .where(and(eq(offerUsageSync.shopId, shopId), eq(offerUsageSync.customerGid, customerGid)))
    .limit(1);
  if (!pending?.since) return "skipped";
  const [shop] = await db
    .select({ domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted, isActive: shops.isActive })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!shop?.isActive) return "skipped";

  const value = await currentUsageValue(db, shopId, customerGid);

  const key = and(eq(offerUsageSync.shopId, shopId), eq(offerUsageSync.customerGid, customerGid));
  try {
    await push({ shopDomain: shop.domain, accessToken: await decryptToken(shop.token), customerGid, value });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_SCOPE.test(message)) {
      // Setup state (the merchant hasn't re-approved write_customers): rows stay, the customer stays pending, no attempt burned.
      if (!warnedShops.has(shopId)) {
        warnedShops.add(shopId);
        Sentry.captureMessage("Offer usage not pushed to customer metafields: the app lacks write_customers", {
          level: "warning",
          tags: { shopId, context: "offer-usage-scope" },
          extra: { message },
        });
      }
      await db
        .update(offerUsageSync)
        .set({ nextAttemptAt: new Date(Date.now() + USAGE_SCOPE_COOLDOWN_MS) })
        .where(and(eq(offerUsageSync.shopId, shopId), sql`${offerUsageSync.pendingSince} is not null`));
      return "missing-scope";
    }
    const [updated] = await db
      .update(offerUsageSync)
      .set({ attempts: sql`${offerUsageSync.attempts} + 1` })
      .where(key)
      .returning({ attempts: offerUsageSync.attempts });
    Sentry.captureException(error, { tags: { shopId, context: "offer-usage-sync" } });
    if (updated?.attempts === USAGE_SYNC_MAX_ATTEMPTS) {
      Sentry.captureException(new Error("Offer usage sync abandoned after the maximum attempts"), {
        tags: { shopId, context: "offer-usage-sync-abandoned" },
        extra: { customerGid },
      });
    }
    return "failed";
  }
  // A concurrent sync may have pushed newer counts before this push landed; if the counts moved, this push is stale.
  if ((await currentUsageValue(db, shopId, customerGid)) !== value) {
    await db.update(offerUsageSync).set({ pendingSince: sql`now()` }).where(key);
    return "stale";
  }
  await db
    .update(offerUsageSync)
    .set({ pendingSince: null, syncedAt: new Date(), attempts: 0, nextAttemptAt: null })
    .where(and(key, sql`${offerUsageSync.pendingSince}::text = ${pending.since}`));
  return "synced";
}

/** Cron retry: bounded batch, bounded attempts, and a shop without the scope is skipped for the rest of the run. */
export async function drainUsageSync(
  db: Db,
  push: PushUsage = pushUsageMetafield,
  now: () => number = Date.now,
): Promise<{ synced: number; failed: number; blockedShops: number }> {
  const started = now();
  // Round-robin per shop (each shop's oldest first), so one shop's backlog cannot crowd out the others.
  const ranked = db
    .select({
      shopId: offerUsageSync.shopId,
      customerGid: offerUsageSync.customerGid,
      pendingSince: offerUsageSync.pendingSince,
      rank: sql<number>`row_number() over (partition by ${offerUsageSync.shopId} order by ${offerUsageSync.pendingSince})`.as("rank"),
    })
    .from(offerUsageSync)
    .where(
      and(
        sql`${offerUsageSync.pendingSince} is not null`,
        lt(offerUsageSync.attempts, USAGE_SYNC_MAX_ATTEMPTS),
        or(sql`${offerUsageSync.nextAttemptAt} is null`, sql`${offerUsageSync.nextAttemptAt} <= now()`),
      ),
    )
    .as("ranked");
  const candidates = await db
    .select({ shopId: ranked.shopId, customerGid: ranked.customerGid })
    .from(ranked)
    .orderBy(asc(ranked.rank), asc(ranked.pendingSince))
    .limit(USAGE_SYNC_BATCH * 4);
  const blocked = new Set<string>();
  let attempted = 0;
  let synced = 0;
  let failed = 0;
  for (const { shopId, customerGid } of candidates) {
    if (attempted >= USAGE_SYNC_BATCH || now() - started > USAGE_SYNC_BUDGET_MS) break;
    if (blocked.has(shopId)) continue;
    attempted += 1;
    const outcome = await syncCustomerUsageMetafield(db, shopId, customerGid, push);
    if (outcome === "synced") synced += 1;
    else if (outcome === "failed") failed += 1;
    else if (outcome === "missing-scope") blocked.add(shopId);
  }
  return { synced, failed, blockedShops: blocked.size };
}

/** Test hook: the once-per-shop warning is process state. */
export function resetUsageScopeWarnings(): void {
  warnedShops.clear();
}

/** Other non-archived automatic offers whose discount title equals this offer's: their orders cannot be told apart. */
export async function findTitleCollisions(
  db: Db,
  shopId: string,
  offer: { id: string; publicTitle: string; internalName: string },
): Promise<Array<{ id: string; internalName: string }>> {
  const message = offerMessage(offer);
  if (!message) return [];
  const rows = await db
    .select({ id: offers.id, internalName: offers.internalName, publicTitle: offers.publicTitle, requiresCode: offers.requiresCode, requiredDiscountCode: offers.requiredDiscountCode })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), ne(offers.status, "archived"), ne(offers.id, offer.id)));
  return rows
    .filter((o) => !o.requiresCode && !o.requiredDiscountCode && offerMessage(o) === message)
    .map(({ id, internalName }) => ({ id, internalName }));
}

export const LIMITED_TITLE_REQUIRED_ERROR =
  "Offers with a customer limit need a unique customer-facing title, it's how orders are matched. Set a public title that no other non-archived automatic offer uses.";

/** DL4: a per-customer limit on an automatic offer needs its own customer-facing title. Null = ok. */
export async function limitedTitleError(db: Db, shopId: string, offerId: string): Promise<string | null> {
  const [offer] = await db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1);
  if (!offer) return null;
  const [code] = await db.select({ id: discountCodes.id }).from(discountCodes).where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offerId))).limit(1);
  if (offer.requiresCode || offer.requiredDiscountCode || code) return null;
  if (!offer.publicTitle.trim()) return LIMITED_TITLE_REQUIRED_ERROR;
  const collisions = await findTitleCollisions(db, shopId, offer);
  return collisions.length > 0
    ? `${LIMITED_TITLE_REQUIRED_ERROR} Same title as: ${collisions.map((c) => c.internalName).join(", ")}.`
    : null;
}

/** Groups of non-archived automatic offers sharing a discount title where at least one is limited (mpu or one_use). */
export async function listLimitedTitleCollisions(db: Db, shopId: string): Promise<Array<{ title: string; offers: string[] }>> {
  const rows = await db
    .select({
      id: offers.id,
      internalName: offers.internalName,
      publicTitle: offers.publicTitle,
      requiresCode: offers.requiresCode,
      requiredDiscountCode: offers.requiredDiscountCode,
    })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), ne(offers.status, "archived")));
  const automatic = rows.filter((o) => !o.requiresCode && !o.requiredDiscountCode);
  if (automatic.length < 2) return [];
  const ids = automatic.map((o) => o.id);
  const [policies, oneUse] = await Promise.all([
    db.select({ offerId: offerCombinationPolicies.offerId, mpu: offerCombinationPolicies.maxApplicationsPerCustomer }).from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, ids))),
    db.select({ offerId: offerConditions.offerId }).from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.conditionType, "one_use_per_customer"), eq(offerConditions.isEnabled, true), inArray(offerConditions.offerId, ids))),
  ]);
  const limited = new Set([...policies.filter((p) => (p.mpu ?? 0) > 0).map((p) => p.offerId), ...oneUse.map((c) => c.offerId)]);
  const groups = new Map<string, typeof automatic>();
  for (const offer of automatic) {
    const key = offerMessage(offer);
    if (key) groups.set(key, [...(groups.get(key) ?? []), offer]);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1 && group.some((o) => limited.has(o.id)))
    .map(([title, group]) => ({ title, offers: group.map((o) => o.internalName).sort() }));
}

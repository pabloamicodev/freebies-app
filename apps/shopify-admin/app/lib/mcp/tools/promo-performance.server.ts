import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { sql, type SQL } from "drizzle-orm";
import { offers, type Db } from "@promo/db";
import { buildResult, moneyFromMinor, parsePromoRef, promoRef, shopHandle, ToolError, type Money, type NextAction, type ToolResult, type Warning } from "../result.server.js";
import { fanOut, type ShopRef } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import {
  MoneyBag,
  clampLimit,
  encodeCursor,
  formatMoneyList,
  iso,
  offsetFromCursor,
  pct,
  rate,
  resolveWindow,
  type Window,
} from "./insights-common.server.js";

export const GROUP_BY = ["offer", "day", "type"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export const promoPerformanceInput = {
  ref: z.string().optional().describe("promo:<shopHandle>:<offerId>; narrows to that one offer (overrides shops)."),
  shops: z.array(z.string()).optional().describe("Shop domains, handles or ids; omitted = every visible shop."),
  start: z.string().optional().describe("ISO 8601 window start."),
  end: z.string().optional().describe("ISO 8601 window end (default now)."),
  lastDays: z.number().int().min(1).max(90).optional().describe("Window length in days when start is omitted (default 30, max 90)."),
  groupBy: z.enum(GROUP_BY).optional().describe("offer (default) | day | type."),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

/** Event names per funnel stage, as the storefront pixel and the orders webhook write them. */
export const EVENT_STAGES = {
  views: ["promo_engine:widget_viewed"],
  qualified: ["promo_engine:offer_qualified"],
  adds: ["promo_engine:gift_auto_added", "promo_engine:gift_added", "promo_engine:gift_selected", "promo_engine:bundle_added_to_cart"],
  checkouts: ["checkout_started"],
  cartErrors: ["promo_engine:cart_mutation_error"],
} as const;
export const ORDER_EVENT = "order_placed_attributed";

export type Counts = {
  views: number;
  qualified: number;
  adds: number;
  checkouts: number;
  cartErrors: number;
  orders: number;
};

export type Bucket = Counts & {
  ordersWithoutReference: number;
  revenue: MoneyBag;
  discount: MoneyBag;
  /** Orders that carried a subtotal, per currency: the AOV denominator. */
  revenueOrders: Map<string, number>;
};

export function emptyBucket(): Bucket {
  return {
    views: 0,
    qualified: 0,
    adds: 0,
    checkouts: 0,
    cartErrors: 0,
    orders: 0,
    ordersWithoutReference: 0,
    revenue: new MoneyBag(),
    discount: new MoneyBag(),
    revenueOrders: new Map(),
  };
}

export function addBucket(into: Bucket, from: Bucket): void {
  into.views += from.views;
  into.qualified += from.qualified;
  into.adds += from.adds;
  into.checkouts += from.checkouts;
  into.cartErrors += from.cartErrors;
  into.orders += from.orders;
  into.ordersWithoutReference += from.ordersWithoutReference;
  for (const c of from.revenue.currencies()) into.revenue.add(c, from.revenue.get(c));
  for (const c of from.discount.currencies()) into.discount.add(c, from.discount.get(c));
  for (const [c, n] of from.revenueOrders) into.revenueOrders.set(c, (into.revenueOrders.get(c) ?? 0) + n);
}

export type Rates = {
  addRate: number | null;
  checkoutRate: number | null;
  orderRate: number | null;
  cartErrorRate: number | null;
};

/** Always recomputed from the summed numerators/denominators, never averaged. */
export function ratesOf(b: Counts): Rates {
  return {
    addRate: rate(b.adds, b.views),
    checkoutRate: rate(b.checkouts, b.adds),
    orderRate: rate(b.orders, b.checkouts),
    cartErrorRate: rate(b.cartErrors, b.adds + b.cartErrors),
  };
}

/** Money per currency; AOV = revenue / orders that had a subtotal, only where that count is > 0. */
export function moneyOf(b: Bucket): { revenue: Money[]; discountGiven: Money[]; aov: Money[] } {
  const aov: Money[] = [];
  for (const currency of b.revenue.currencies()) {
    const n = b.revenueOrders.get(currency) ?? 0;
    if (n > 0) aov.push(moneyFromMinor(Math.round(b.revenue.get(currency) / n), currency));
  }
  return { revenue: b.revenue.toMoney(), discountGiven: b.discount.toMoney(), aov };
}

export type ShopQuality = {
  eventCounts: Record<keyof typeof EVENT_STAGES | "ordersAttributed", number>;
  missingEvents: { stage: string; eventNames: string[]; impact: string }[];
  ordersWithoutReference: number;
  ordersWithoutRevenue: number;
  earliestEventAt: string | null;
  windowStartsBeforeEarliestEvent: boolean;
};

export type ShopPerformance = {
  buckets: Map<string, Bucket>;
  labels: Map<string, { name: string; type: string; status: string; offerId: string }>;
  quality: ShopQuality;
  total: Bucket;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

const inList = (names: readonly string[]): SQL => sql.join(names.map((n) => sql`${n}`), sql`, `);
const ALL_COUNT_EVENTS = [...EVENT_STAGES.views, ...EVENT_STAGES.qualified, ...EVENT_STAGES.adds, ...EVENT_STAGES.checkouts, ...EVENT_STAGES.cartErrors, ORDER_EVENT];

const STAGE_IMPACT: Record<string, string> = {
  views: "No widget views: add-rate cannot be computed.",
  qualified: "No offer_qualified events: qualification cannot be reported.",
  adds: "No gift/bundle add events: add-rate and checkout-rate cannot be computed.",
  checkouts: "No checkout_started events: checkout-rate and order-rate cannot be computed.",
  cartErrors: "No cart mutation errors recorded (may simply mean none happened).",
  ordersAttributed: "No order_placed_attributed events: orders, revenue and AOV are unavailable.",
};

/** Reads only analytics_events filtered by shop + time (+ offer): the existing indexes, never a global scan. */
export async function queryShopPerformance(
  db: Db,
  shop: ShopRef,
  window: Window,
  opts: { groupBy: GroupBy; offerId?: string },
): Promise<ShopPerformance> {
  const { groupBy, offerId } = opts;
  const startIso = window.start.toISOString();
  const endIso = window.end.toISOString();
  const join = groupBy === "type" ? sql`JOIN offers o ON o.id = e.offer_id AND o.shop_id = e.shop_id` : sql``;
  const keyExpr =
    groupBy === "offer"
      ? sql`e.offer_id::text`
      : groupBy === "type"
        ? sql`o.type::text`
        : sql`to_char(e.occurred_at AT TIME ZONE ${shop.timezone}, 'YYYY-MM-DD')`;
  const offerFilter = offerId ? sql`AND e.offer_id = ${offerId}` : sql``;
  const base = sql`e.shop_id = ${shop.id} AND e.occurred_at >= ${startIso} AND e.occurred_at < ${endIso} AND e.offer_id IS NOT NULL ${offerFilter}`;

  const counts = rowsOf<Record<string, string | number | null>>(
    await db.execute(sql`
      SELECT ${keyExpr} AS key,
        COUNT(*) FILTER (WHERE e.event_name IN (${inList(EVENT_STAGES.views)}))::int AS views,
        COUNT(*) FILTER (WHERE e.event_name IN (${inList(EVENT_STAGES.qualified)}))::int AS qualified,
        COUNT(*) FILTER (WHERE e.event_name IN (${inList(EVENT_STAGES.adds)}))::int AS adds,
        COUNT(*) FILTER (WHERE e.event_name IN (${inList(EVENT_STAGES.checkouts)}))::int AS checkouts,
        COUNT(*) FILTER (WHERE e.event_name IN (${inList(EVENT_STAGES.cartErrors)}))::int AS cart_errors,
        COUNT(*) FILTER (WHERE e.event_name = ${ORDER_EVENT} AND e.order_id IS NULL)::int AS orders_no_id
      FROM analytics_events e ${join}
      WHERE ${base} AND e.event_name IN (${inList(ALL_COUNT_EVENTS)})
      GROUP BY 1`),
  );

  const orders = rowsOf<Record<string, string | number | null>>(
    await db.execute(sql`
      SELECT key, currency,
        COUNT(*)::int AS orders,
        COUNT(subtotal)::int AS with_subtotal,
        COALESCE(SUM(subtotal), 0)::bigint AS subtotal_cents,
        COALESCE(SUM(saved), 0)::bigint AS saved_cents
      FROM (
        SELECT DISTINCT ON (e.offer_id, e.order_id)
          ${keyExpr} AS key,
          COALESCE(NULLIF(e.properties->>'currencyCode', ''), ${shop.currencyCode}) AS currency,
          CASE WHEN e.properties->>'subtotalCents' ~ '^[0-9]+$' THEN (e.properties->>'subtotalCents')::bigint END AS subtotal,
          CASE WHEN e.properties->>'savedCents' ~ '^[0-9]+$' THEN (e.properties->>'savedCents')::bigint END AS saved
        FROM analytics_events e ${join}
        WHERE ${base} AND e.event_name = ${ORDER_EVENT} AND e.order_id IS NOT NULL
        ORDER BY e.offer_id, e.order_id, e.occurred_at DESC
      ) d
      GROUP BY key, currency`),
  );

  const [earliest] = rowsOf<{ at: string | Date | null }>(
    await db.execute(sql`SELECT e.occurred_at AS at FROM analytics_events e WHERE e.shop_id = ${shop.id} ORDER BY e.occurred_at ASC LIMIT 1`),
  );

  const buckets = new Map<string, Bucket>();
  const bucketFor = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = emptyBucket()));
    return b;
  };
  for (const row of counts) {
    const b = bucketFor(String(row["key"]));
    b.views += Number(row["views"] ?? 0);
    b.qualified += Number(row["qualified"] ?? 0);
    b.adds += Number(row["adds"] ?? 0);
    b.checkouts += Number(row["checkouts"] ?? 0);
    b.cartErrors += Number(row["cart_errors"] ?? 0);
    b.ordersWithoutReference += Number(row["orders_no_id"] ?? 0);
  }
  let ordersWithoutRevenue = 0;
  for (const row of orders) {
    const b = bucketFor(String(row["key"]));
    const currency = String(row["currency"]);
    const n = Number(row["orders"] ?? 0);
    const withSubtotal = Number(row["with_subtotal"] ?? 0);
    b.orders += n;
    ordersWithoutRevenue += n - withSubtotal;
    b.revenue.add(currency, Number(row["subtotal_cents"] ?? 0));
    b.discount.add(currency, Number(row["saved_cents"] ?? 0));
    if (withSubtotal > 0) b.revenueOrders.set(currency, (b.revenueOrders.get(currency) ?? 0) + withSubtotal);
  }

  const total = emptyBucket();
  for (const b of buckets.values()) addBucket(total, b);

  const labels = new Map<string, { name: string; type: string; status: string; offerId: string }>();
  if (groupBy === "offer" && buckets.size > 0) {
    const ids = [...buckets.keys()];
    const found = await db
      .select({ id: offers.id, name: offers.internalName, type: offers.type, status: offers.status })
      .from(offers)
      .where(and(eq(offers.shopId, shop.id), inArray(offers.id, ids)));
    for (const o of found) labels.set(o.id, { name: o.name, type: o.type, status: o.status, offerId: o.id });
  }

  const eventCounts = {
    views: total.views,
    qualified: total.qualified,
    adds: total.adds,
    checkouts: total.checkouts,
    cartErrors: total.cartErrors,
    ordersAttributed: total.orders,
  };
  const missingEvents = (Object.keys(eventCounts) as (keyof typeof eventCounts)[])
    .filter((stage) => eventCounts[stage] === 0)
    .map((stage) => ({
      stage,
      eventNames: stage === "ordersAttributed" ? [ORDER_EVENT] : [...EVENT_STAGES[stage]],
      impact: STAGE_IMPACT[stage]!,
    }));
  const earliestIso = iso(earliest?.at ?? null);
  return {
    buckets,
    labels,
    total,
    quality: {
      eventCounts,
      missingEvents,
      ordersWithoutReference: total.ordersWithoutReference,
      ordersWithoutRevenue,
      earliestEventAt: earliestIso,
      windowStartsBeforeEarliestEvent: earliestIso === null || new Date(earliestIso) > window.start,
    },
  };
}

export type PerformanceRow = {
  key: string;
  promoRef?: string;
  shopDomain?: string;
  name?: string;
  offerType?: string;
  offerStatus?: string;
  counts: Counts;
  rates: Rates;
  revenue: Money[];
  discountGiven: Money[];
  aov: Money[];
};

function toRow(key: string, b: Bucket, extra: Partial<PerformanceRow> = {}): PerformanceRow {
  const { revenue, discountGiven, aov } = moneyOf(b);
  return {
    key,
    ...extra,
    counts: { views: b.views, qualified: b.qualified, adds: b.adds, checkouts: b.checkouts, cartErrors: b.cartErrors, orders: b.orders },
    rates: ratesOf(b),
    revenue,
    discountGiven,
    aov,
  };
}

export type PromoPerformanceData = {
  window: { start: string; end: string };
  groupBy: GroupBy;
  totals: PerformanceRow;
  rows: PerformanceRow[];
  dataQuality: {
    aggregate: Omit<ShopQuality, "earliestEventAt" | "windowStartsBeforeEarliestEvent">;
    perShop: (ShopQuality & { shopDomain: string })[];
    notes: string[];
  };
};

const QUALITY_NOTES = [
  "Revenue is the full subtotal of orders attributed to the offer (order_placed_attributed.subtotalCents), not incremental revenue.",
  "An order with several attributed offers counts once per offer; totals can exceed the shop's real order count.",
  "Browser events (views, adds) can be missing for visitors with blockers or consent limits; treat funnel rates as indicative.",
  "Money is kept per currency and never converted; rates are recomputed from summed counts.",
];

export async function promoPerformance(
  db: Db,
  visible: VisibleShop[],
  args: {
    ref?: string;
    shops?: string[];
    start?: string;
    end?: string;
    lastDays?: number;
    groupBy?: GroupBy;
    cursor?: string;
    limit?: number;
  },
  now: () => Date = () => new Date(),
): Promise<ToolResult<PromoPerformanceData>> {
  const groupBy = args.groupBy ?? "offer";
  const window = resolveWindow(args, now());
  const limit = clampLimit(args.limit);
  const offset = offsetFromCursor(args.cursor);

  let selected: VisibleShop[];
  let offerId: string | undefined;
  if (args.ref) {
    const parsed = parsePromoRef(args.ref);
    if (!parsed) throw new ToolError("VALIDATION", "ref must look like promo:<shopHandle>:<offerId>.");
    selected = selectShops(visible, [parsed.shopHandle]);
    offerId = parsed.offerId;
    const [exists] = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.shopId, selected[0]!.id), eq(offers.id, offerId)))
      .limit(1);
    if (!exists) throw new ToolError("NOT_FOUND", `Offer ${args.ref} was not found.`, {
      suggestedAction: { mcp: "promo-engine", tool: "promos_active", args: { shops: [parsed.shopHandle] }, why: "List the offers of that shop." },
    });
  } else {
    selected = selectShops(visible, args.shops);
  }

  const { perShop, results } = await fanOut(
    selected,
    (shop) => queryShopPerformance(db, shop, window, { groupBy, ...(offerId ? { offerId } : {}) }),
    { cacheKey: `promo_performance:${groupBy}:${offerId ?? ""}:${window.start.toISOString()}:${window.end.toISOString()}` },
  );

  const merged = new Map<string, { bucket: Bucket; extra: Partial<PerformanceRow> }>();
  const totalBucket = emptyBucket();
  const aggregateQuality = {
    eventCounts: { views: 0, qualified: 0, adds: 0, checkouts: 0, cartErrors: 0, ordersAttributed: 0 },
    ordersWithoutReference: 0,
    ordersWithoutRevenue: 0,
  };
  for (const { shop, value } of results) {
    addBucket(totalBucket, value.total);
    for (const [stage, n] of Object.entries(value.quality.eventCounts)) {
      aggregateQuality.eventCounts[stage as keyof typeof aggregateQuality.eventCounts] += n;
    }
    aggregateQuality.ordersWithoutReference += value.quality.ordersWithoutReference;
    aggregateQuality.ordersWithoutRevenue += value.quality.ordersWithoutRevenue;
    for (const [rawKey, bucket] of value.buckets) {
      const label = value.labels.get(rawKey);
      const key = groupBy === "offer" ? promoRef(shop.myshopifyDomain, rawKey) : rawKey;
      const slot = merged.get(key) ?? { bucket: emptyBucket(), extra: {} };
      addBucket(slot.bucket, bucket);
      if (groupBy === "offer") {
        slot.extra = {
          promoRef: key,
          shopDomain: shop.myshopifyDomain,
          name: label?.name ?? "(deleted offer)",
          ...(label ? { offerType: label.type, offerStatus: label.status } : {}),
        };
      }
      merged.set(key, slot);
    }
  }

  const all = [...merged.entries()].map(([key, { bucket, extra }]) => ({ b: bucket, row: toRow(key, bucket, extra) }));
  if (groupBy === "day") all.sort((a, z) => a.row.key.localeCompare(z.row.key));
  else all.sort((a, z) => z.b.orders - a.b.orders || z.b.views - a.b.views || a.row.key.localeCompare(z.row.key));
  const page = all.slice(offset, offset + limit).map((x) => x.row);
  const hasMore = offset + limit < all.length;

  const aggregateMissing = (Object.keys(aggregateQuality.eventCounts) as (keyof typeof aggregateQuality.eventCounts)[])
    .filter((s) => aggregateQuality.eventCounts[s] === 0)
    .map((stage) => ({
      stage,
      eventNames: stage === "ordersAttributed" ? [ORDER_EVENT] : [...EVENT_STAGES[stage]],
      impact: STAGE_IMPACT[stage]!,
    }));
  const totals = toRow("total", totalBucket);
  const warnings: Warning[] = [];
  for (const { shop, value } of results) {
    const handle = shopHandle(shop.myshopifyDomain);
    if (value.quality.missingEvents.some((m) => m.stage === "ordersAttributed")) {
      warnings.push({ code: "NO_ORDER_EVENTS", severity: "warn", message: `${handle}: no order_placed_attributed events in the window; orders, revenue and AOV are unavailable.` });
    }
    if (value.quality.ordersWithoutRevenue > 0) {
      warnings.push({ code: "ORDERS_WITHOUT_REVENUE", severity: "info", message: `${handle}: ${value.quality.ordersWithoutRevenue} attributed order(s) have no subtotal; revenue and AOV exclude them.` });
    }
    if (value.quality.windowStartsBeforeEarliestEvent) {
      warnings.push({ code: "WINDOW_BEFORE_DATA", severity: "info", message: `${handle}: the window starts before the earliest stored event (${value.quality.earliestEventAt ?? "none"}); retention may have trimmed older data.` });
    }
  }
  for (const p of perShop.filter((s) => s.status === "error")) {
    warnings.push({ code: "SHOP_FAILED", severity: "warn", message: `${p.shopDomain}: ${p.reason ?? "error"}; excluded from the totals.` });
  }

  const t = totals;
  const summary = [
    `Promo performance ${window.start.toISOString().slice(0, 10)} to ${window.end.toISOString().slice(0, 10)}, grouped by ${groupBy}, ${results.length}/${selected.length} shop(s).`,
    `Views ${t.counts.views}, adds ${t.counts.adds} (${pct(t.rates.addRate)}), checkouts ${t.counts.checkouts} (${pct(t.rates.checkoutRate)}), attributed orders ${t.counts.orders} (${pct(t.rates.orderRate)}), cart errors ${t.counts.cartErrors}.`,
    `Revenue: ${formatMoneyList(t.revenue)}; discount given: ${formatMoneyList(t.discountGiven)}; AOV: ${formatMoneyList(t.aov)}.`,
    aggregateMissing.length
      ? `Missing events in the window: ${aggregateMissing.map((m) => m.stage).join(", ")}.`
      : "All funnel event types are present.",
    ...page.slice(0, 5).map((r) => `- ${r.name ?? r.key}: ${r.counts.views} views, ${r.counts.orders} orders, add ${pct(r.rates.addRate)}`),
    hasMore ? "More rows are available with the cursor." : "",
  ].filter(Boolean).join("\n");

  const nextActions: NextAction[] = [];
  if (groupBy !== "offer") {
    nextActions.push({ mcp: "promo-engine", tool: "promo_performance", args: { shops: args.shops ?? [], lastDays: args.lastDays ?? 30, groupBy: "offer" }, why: "Break the totals down per offer.", risk: "read" });
  }
  nextActions.push({ mcp: "promo-engine", tool: "suggest_promo_tests", args: { shops: args.shops ?? [] }, why: "Turn this performance into test candidates for the Experiment Engine.", risk: "read" });

  return buildResult(
    {
      summary,
      data: {
        window: { start: window.start.toISOString(), end: window.end.toISOString() },
        groupBy,
        totals,
        rows: page,
        dataQuality: {
          aggregate: { ...aggregateQuality, missingEvents: aggregateMissing },
          perShop: results.map(({ shop, value }) => ({ shopDomain: shop.myshopifyDomain, ...value.quality })),
          notes: QUALITY_NOTES,
        },
      },
      perShop,
      links: selected.map((s) => ({ label: `${shopHandle(s.myshopifyDomain)} admin`, url: `https://admin.shopify.com/store/${shopHandle(s.myshopifyDomain)}` })),
      warnings,
      nextActions,
      meta: {
        window: { start: window.start.toISOString(), end: window.end.toISOString() },
        page: { hasMore, ...(hasMore ? { cursor: encodeCursor({ o: offset + limit }) } : {}) },
      },
    },
    now,
  );
}

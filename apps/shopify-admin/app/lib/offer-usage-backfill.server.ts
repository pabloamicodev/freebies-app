import { offerCustomerUsages, offerUsageSync, type Db } from "@promo/db";
import { sql } from "drizzle-orm";
import {
  matchOrderOffers,
  orderUsageSchema,
  orderUsageSignals,
  type UsageOfferRow,
} from "./offer-usage.server.js";

export interface BackfillUsageRow {
  offerId: string;
  customerGid: string;
  orderGid: string;
}

/** Bulk query: orders (with their discount applications and line attributes) from a date, paid-like only. */
export function buildBulkOrdersQuery(since: string): string {
  const filter = `created_at:>=${since} AND (financial_status:paid OR financial_status:partially_paid OR financial_status:partially_refunded OR financial_status:refunded)`;
  return `{
    orders(query: ${JSON.stringify(filter)}) {
      edges { node {
        id
        customer { id }
        discountApplications { edges { node {
          __typename
          ... on AutomaticDiscountApplication { title }
          ... on DiscountCodeApplication { code }
        } } }
        lineItems { edges { node {
          id
          customAttributes { key value }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } }
        } } }
      } }
    }
  }`;
}

type Json = Record<string, unknown>;
interface PartialOrder {
  id: string;
  customerId: string | null;
  applications: Array<{ type: string; title?: string; code?: string }>;
  lines: Array<{ properties: Array<{ name: string; value: string }>; discount_allocations: Array<{ amount: string }> }>;
}

const numericId = (gid: unknown) => (typeof gid === "string" ? (/(\d+)$/.exec(gid)?.[1] ?? null) : null);

/** Streams the bulk JSONL (children carry `__parentId`) into usage rows; malformed lines are skipped and counted. */
export function parseBulkOrdersJsonl(
  lines: Iterable<string>,
  offerRows: UsageOfferRow[],
  codeOfferIdsByCode: Map<string, string[]>,
  targetOfferIds?: Set<string>,
): { rows: BackfillUsageRow[]; orders: number; skipped: number } {
  const orders = new Map<string, PartialOrder>();
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Json;
    try {
      obj = JSON.parse(line) as Json;
    } catch {
      skipped += 1;
      continue;
    }
    const parent = obj.__parentId;
    if (typeof parent !== "string") {
      if (typeof obj.id !== "string") {
        skipped += 1;
        continue;
      }
      orders.set(obj.id, {
        id: obj.id,
        customerId: numericId((obj.customer as Json | null | undefined)?.id),
        applications: [],
        lines: [],
      });
      continue;
    }
    const order = orders.get(parent);
    if (!order) {
      skipped += 1;
      continue;
    }
    const typename = obj.__typename;
    if (typeof typename === "string") {
      if (typename === "AutomaticDiscountApplication" && typeof obj.title === "string") {
        order.applications.push({ type: "automatic", title: obj.title });
      } else if (typename === "DiscountCodeApplication" && typeof obj.code === "string") {
        order.applications.push({ type: "discount_code", code: obj.code });
      }
      continue;
    }
    const attrs = Array.isArray(obj.customAttributes) ? (obj.customAttributes as Json[]) : [];
    const allocations = Array.isArray(obj.discountAllocations) ? (obj.discountAllocations as Json[]) : [];
    order.lines.push({
      properties: attrs.flatMap((a) =>
        typeof a.key === "string" && typeof a.value === "string" ? [{ name: a.key, value: a.value }] : [],
      ),
      discount_allocations: allocations.map((a) => ({
        amount: String((((a.allocatedAmountSet as Json | undefined)?.shopMoney as Json | undefined)?.amount) ?? "0"),
      })),
    });
  }

  const seen = new Set<string>();
  const rows: BackfillUsageRow[] = [];
  for (const order of orders.values()) {
    if (!order.customerId) continue;
    const parsed = orderUsageSchema.safeParse({
      admin_graphql_api_id: order.id,
      customer: { id: order.customerId },
      discount_applications: order.applications,
      line_items: order.lines,
    });
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const signals = orderUsageSignals(parsed.data);
    const codeOfferIds = signals.codes.flatMap((c) => codeOfferIdsByCode.get(c) ?? []);
    const { result } = matchOrderOffers(signals, offerRows, codeOfferIds);
    for (const offerId of result.keys()) {
      if (targetOfferIds && !targetOfferIds.has(offerId)) continue;
      const key = `${order.id}|${offerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ offerId, customerGid: `gid://shopify/Customer/${order.customerId}`, orderGid: order.id });
    }
  }
  return { rows, orders: orders.size, skipped };
}

/** Inserts with ON CONFLICT DO NOTHING (source `backfill`) and marks only customers with new rows pending for the cron push. */
export async function applyBackfillUsages(
  db: Db,
  shopId: string,
  rows: BackfillUsageRow[],
  batchSize = 500,
): Promise<{ inserted: number; customersMarked: number }> {
  let inserted = 0;
  const marked = new Set<string>();
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await db.transaction(async (tx) => {
      const out = await tx
        .insert(offerCustomerUsages)
        .values(batch.map((r) => ({ shopId, offerId: r.offerId, customerGid: r.customerGid, orderGid: r.orderGid, source: "backfill" })))
        .onConflictDoNothing()
        .returning({ customerGid: offerCustomerUsages.customerGid });
      inserted += out.length;
      const customers = [...new Set(out.map((r) => r.customerGid))];
      if (customers.length > 0) {
        await tx
          .insert(offerUsageSync)
          .values(customers.map((customerGid) => ({ shopId, customerGid, pendingSince: sql`now()` })))
          .onConflictDoUpdate({
            target: [offerUsageSync.shopId, offerUsageSync.customerGid],
            set: { pendingSince: sql`now()`, attempts: 0 },
          });
        for (const c of customers) marked.add(c);
      }
    });
  }
  return { inserted, customersMarked: marked.size };
}

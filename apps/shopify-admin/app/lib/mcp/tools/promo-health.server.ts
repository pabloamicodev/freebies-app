import { z } from "zod";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { auditLogs, offers, shops, type Db } from "@promo/db";
import { buildResult, promoRef, shopHandle, type NextAction, type ToolResult, type Warning } from "../result.server.js";
import { fanOut, type ShopRef } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import { getOfferPublishErrors } from "../../offer-publish-errors.server.js";
import { needsDiscountReconciliation } from "../../discount-reconciliation.server.js";
import { DAY_MS, clampLimit, encodeCursor, iso, offsetFromCursor } from "./insights-common.server.js";

export const promoHealthInput = {
  shops: z.array(z.string()).optional().describe("Shop domains, handles or ids; omitted = every visible shop."),
  lastDays: z.number().int().min(1).max(90).optional().describe("How far back to look for system pauses (default 14)."),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export const HEALTH_KINDS = [
  "publish_error",
  "system_pause",
  "publish_pending",
  "missing_discount_node",
  "offer_not_compiled",
  "schedule_drift",
] as const;
export type HealthKind = (typeof HEALTH_KINDS)[number];
export type Severity = "high" | "medium" | "low";

export type HealthFinding = {
  kind: HealthKind;
  severity: Severity;
  shopDomain: string;
  shopHandle: string;
  promoRef?: string;
  offerName?: string;
  offerStatus?: string;
  message: string;
  since?: string;
  detail?: Record<string, unknown>;
};

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
/** Grace so a cron that is about to run is not reported as drift. */
const SCHEDULE_GRACE_MS = 15 * 60_000;
const PENDING_HIGH_MS = 30 * 60_000;
const SYSTEM_ACTIONS = ["system_pause", "system_draft"];

type OfferLite = { id: string; name: string; status: string };

async function shopFindings(db: Db, shop: ShopRef, lastDays: number, now: Date): Promise<HealthFinding[]> {
  const base = { shopDomain: shop.myshopifyDomain, shopHandle: shopHandle(shop.myshopifyDomain) };
  const findings: HealthFinding[] = [];
  const offerRef = (o: OfferLite) => ({ promoRef: promoRef(shop.myshopifyDomain, o.id), offerName: o.name, offerStatus: o.status });

  const [shopRow] = await db
    .select({ discountId: shops.discountId, deliveryDiscountId: shops.deliveryDiscountId, publishPendingAt: shops.publishPendingAt })
    .from(shops)
    .where(eq(shops.id, shop.id))
    .limit(1);

  // 1. Publish errors recorded against specific offers.
  const errors = await getOfferPublishErrors(shop.id, db);
  const errorIds = Object.keys(errors);
  const errorOffers = errorIds.length
    ? await db
        .select({ id: offers.id, name: offers.internalName, status: offers.status })
        .from(offers)
        .where(and(eq(offers.shopId, shop.id), inArray(offers.id, errorIds)))
    : [];
  for (const o of errorOffers) {
    if (o.status === "archived") continue;
    findings.push({ ...base, kind: "publish_error", severity: "high", ...offerRef(o), message: errors[o.id]!.slice(0, 500) });
  }

  // 2. Offers the system paused or reverted to draft on its own and that are still stopped.
  const since = new Date(now.getTime() - lastDays * DAY_MS);
  const events = await db
    .select({ entityId: auditLogs.entityId, action: auditLogs.action, after: auditLogs.after, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.shopId, shop.id),
        eq(auditLogs.entityType, "offer"),
        eq(auditLogs.performedBy, "system"),
        inArray(auditLogs.action, SYSTEM_ACTIONS),
        gte(auditLogs.createdAt, since),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);
  const latestByOffer = new Map<string, (typeof events)[number]>();
  for (const e of events) if (!latestByOffer.has(e.entityId)) latestByOffer.set(e.entityId, e);
  const uuid = /^[0-9a-f-]{36}$/i;
  const pausedIds = [...latestByOffer.keys()].filter((id) => uuid.test(id));
  const pausedOffers = pausedIds.length
    ? await db
        .select({ id: offers.id, name: offers.internalName, status: offers.status })
        .from(offers)
        .where(and(eq(offers.shopId, shop.id), inArray(offers.id, pausedIds), inArray(offers.status, ["paused", "draft"])))
    : [];
  for (const o of pausedOffers) {
    const e = latestByOffer.get(o.id)!;
    const after = (e.after && typeof e.after === "object" ? e.after : {}) as Record<string, unknown>;
    const reason = typeof after["reason"] === "string" ? after["reason"] : "unknown";
    const error = typeof after["error"] === "string" ? after["error"] : "";
    findings.push({
      ...base,
      kind: "system_pause",
      severity: "high",
      ...offerRef(o),
      message: `The system moved this offer to ${o.status} (${e.action}, reason: ${reason})${error ? `: ${error.slice(0, 300)}` : ""}.`,
      since: iso(e.createdAt)!,
      detail: { action: e.action, reason },
    });
  }

  // 3. Publish waiting on the per-shop lock.
  if (shopRow?.publishPendingAt) {
    const age = now.getTime() - shopRow.publishPendingAt.getTime();
    findings.push({
      ...base,
      kind: "publish_pending",
      severity: age > PENDING_HIGH_MS ? "high" : "medium",
      message: `A publish has been waiting to retry for ${Math.max(0, Math.round(age / 60_000))} minute(s).`,
      since: shopRow.publishPendingAt.toISOString(),
    });
  }

  // 4. Drift visible from the database alone (live Admin API drift is the cron's job).
  const active = await db
    .select({ id: offers.id, name: offers.internalName, status: offers.status, compiled: offers.compiledConfig, startsAt: offers.startsAt, endsAt: offers.endsAt })
    .from(offers)
    .where(and(eq(offers.shopId, shop.id), inArray(offers.status, ["active", "scheduled"])));
  const notCompiled = active.filter((o) => o.status === "active" && o.compiled === null);
  for (const o of notCompiled) {
    findings.push({ ...base, kind: "offer_not_compiled", severity: "high", ...offerRef(o), message: "Active offer has no compiled config, so the Function cannot apply it." });
  }
  const activeCount = active.filter((o) => o.status === "active").length;
  if (
    activeCount > 0 &&
    needsDiscountReconciliation({
      discountId: shopRow?.discountId ?? null,
      deliveryDiscountId: shopRow?.deliveryDiscountId ?? null,
      compiledConfig: {},
    })
  ) {
    findings.push({
      ...base,
      kind: "missing_discount_node",
      severity: "high",
      message: `${activeCount} active offer(s) but the shop has no ${shopRow?.discountId == null ? "automatic discount" : "delivery discount"} node to carry them.`,
      detail: { discountNode: shopRow?.discountId != null, deliveryNode: shopRow?.deliveryDiscountId != null },
    });
  }
  const cutoff = now.getTime() - SCHEDULE_GRACE_MS;
  for (const o of active) {
    if (o.status === "active" && o.endsAt && o.endsAt.getTime() < cutoff) {
      findings.push({ ...base, kind: "schedule_drift", severity: "medium", ...offerRef(o), message: `Offer is still active but its end date passed (${o.endsAt.toISOString()}).`, since: o.endsAt.toISOString() });
    } else if (o.status === "scheduled" && o.startsAt && o.startsAt.getTime() < cutoff) {
      findings.push({ ...base, kind: "schedule_drift", severity: "medium", ...offerRef(o), message: `Offer is still scheduled but its start date passed (${o.startsAt.toISOString()}).`, since: o.startsAt.toISOString() });
    } else if (o.status === "active" && o.startsAt && o.startsAt.getTime() > now.getTime() + SCHEDULE_GRACE_MS) {
      findings.push({ ...base, kind: "schedule_drift", severity: "low", ...offerRef(o), message: `Offer is active but its start date is in the future (${o.startsAt.toISOString()}).`, since: o.startsAt.toISOString() });
    }
  }
  return findings;
}

function actionsFor(findings: HealthFinding[]): NextAction[] {
  const actions: NextAction[] = [];
  const seen = new Set<string>();
  const push = (a: NextAction) => {
    const key = `${a.tool}:${JSON.stringify(a.args)}`;
    if (!seen.has(key) && actions.length < 8) {
      seen.add(key);
      actions.push(a);
    }
  };
  for (const f of findings) {
    if (f.promoRef) {
      push({ mcp: "promo-engine", tool: "promo_detail", args: { ref: f.promoRef }, why: `Inspect the ${f.kind.replace(/_/g, " ")} on ${f.offerName}.`, risk: "read" });
      if (f.kind === "system_pause" || f.kind === "publish_error") {
        push({ mcp: "promo-engine", tool: "promo_audit_log", args: { ref: f.promoRef }, why: "See what changed before it failed.", risk: "read" });
      }
    } else {
      push({ mcp: "promo-engine", tool: "discount_capacity", args: { shops: [f.shopDomain] }, why: `Check the shared config size and nodes of ${f.shopHandle}.`, risk: "read" });
    }
  }
  return actions;
}

export type PromoHealthData = {
  window: { start: string; end: string };
  counts: { total: number; bySeverity: Record<Severity, number>; byKind: Partial<Record<HealthKind, number>> };
  findings: HealthFinding[];
  notes: string[];
};

export async function promoHealth(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; lastDays?: number; cursor?: string; limit?: number },
  now: () => Date = () => new Date(),
): Promise<ToolResult<PromoHealthData>> {
  const current = now();
  const lastDays = args.lastDays ?? 14;
  const limit = clampLimit(args.limit);
  const offset = offsetFromCursor(args.cursor);
  const selected = selectShops(visible, args.shops);

  const { perShop, results } = await fanOut(selected, (shop) => shopFindings(db, shop, lastDays, current), {
    cacheKey: `promo_health:${lastDays}`,
    now: () => current.getTime(),
  });

  const all = results.flatMap((r) => r.value).sort(
    (a, z) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[z.severity] ||
      a.shopDomain.localeCompare(z.shopDomain) ||
      a.kind.localeCompare(z.kind) ||
      (a.offerName ?? "").localeCompare(z.offerName ?? ""),
  );
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  const byKind: Partial<Record<HealthKind, number>> = {};
  for (const f of all) {
    bySeverity[f.severity] += 1;
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  }
  const page = all.slice(offset, offset + limit);
  const hasMore = offset + limit < all.length;

  const warnings: Warning[] = perShop
    .filter((p) => p.status === "error")
    .map((p) => ({ code: "SHOP_FAILED", severity: "warn" as const, message: `${p.shopDomain}: health could not be read (${p.reason ?? "error"}).` }));

  const summary = all.length === 0
    ? `No health issues across ${results.length} shop(s).`
    : [
        `${all.length} health issue(s) across ${results.length} shop(s): ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low.`,
        ...page.slice(0, 8).map((f) => `- [${f.severity}] ${f.shopHandle} ${f.kind}${f.offerName ? ` "${f.offerName}"` : ""}: ${f.message.slice(0, 140)}`),
        hasMore ? "More findings are available with the cursor." : "",
      ].filter(Boolean).join("\n");

  return buildResult(
    {
      summary,
      data: {
        window: { start: new Date(current.getTime() - lastDays * DAY_MS).toISOString(), end: current.toISOString() },
        counts: { total: all.length, bySeverity, byKind },
        findings: page,
        notes: [
          "Drift here is what the database shows (compiled config, discount nodes, schedule). Live Shopify node drift is checked by the discount drift cron.",
        ],
      },
      perShop,
      links: selected.map((s) => ({ label: `${shopHandle(s.myshopifyDomain)} admin`, url: `https://admin.shopify.com/store/${shopHandle(s.myshopifyDomain)}` })),
      warnings,
      nextActions: actionsFor(page),
      meta: { page: { hasMore, ...(hasMore ? { cursor: encodeCursor({ o: offset + limit }) } : {}) } },
    },
    now,
  );
}


import { z } from "zod";
import { discountShards, shops, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { loadDiagnostics } from "../../diagnostics.server.js";
import { preflightCapacity, sharedConfigBreakdown, type CapacityOptions } from "../../capacity-preflight.server.js";
import { NODE_INSTRUCTION_BUDGET, NODE_INSTRUCTION_FLOOR } from "../../sync/instruction-estimate.js";
import { MAX_METAFIELD_BYTES } from "../../sync/offer-publisher.server.js";
import { buildResult, shopHandle, type ToolResult, type Warning } from "../result.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import { adminLink } from "./catalog-shared.server.js";

export const diagnosticsGetInput = {
  shop: z.string().max(200).describe("Shop domain, handle or id (one shop per call)."),
};

export type DiagnosticsDeps = { capacity?: CapacityOptions };

const TOP_OFFERS = 10;
const pct = (used: number, limit: number) => Math.round((used / limit) * 1000) / 10;

/**
 * Everything the admin Diagnostics page shows, plus the numbers behind it: health counters (cache, cart mutation
 * errors), the Shopify limits meter (automatic discounts in the store vs the 25 cap, cart slots, sharding and
 * combination domains), the published config size per node, the instruction estimate per planned node and the
 * capacity incidents and applied workarounds ("transforms").
 */
export async function diagnosticsGet(
  db: Db,
  visible: VisibleShop[],
  args: { shop: string },
  now: () => Date = () => new Date(),
  deps: DiagnosticsDeps = {},
): Promise<ToolResult<Record<string, unknown>>> {
  const [shop] = selectShops(visible, [args.shop]);
  const page = await loadDiagnostics(db, shop!.myshopifyDomain, deps.capacity?.loadBudget ? { loadBudget: deps.capacity.loadBudget } : {});
  const [breakdown, plan, shardRows, [nodes]] = await Promise.all([
    sharedConfigBreakdown(db, shop!.id, shop!.currencyCode),
    preflightCapacity(db, shop!.id, [], deps.capacity).catch(() => null),
    db
      .select({ slot: discountShards.slot, nodeId: discountShards.discountNodeId, bytes: discountShards.configBytes })
      .from(discountShards)
      .where(and(eq(discountShards.shopId, shop!.id), eq(discountShards.kind, "cart"))),
    db.select({ discountId: shops.discountId, deliveryDiscountId: shops.deliveryDiscountId }).from(shops).where(eq(shops.id, shop!.id)),
  ]);

  const warnings: Warning[] = [];
  const planned = plan?.ok ? plan.plan : null;
  if (plan && !plan.ok) warnings.push({ code: "CAPACITY_BLOCKED", severity: "block", message: `The next publish would be blocked (${plan.code}): ${plan.message}` });
  if (!page.limits) warnings.push({ code: "LIMITS_UNKNOWN", severity: "warn", message: "Could not read the shop's automatic discount count from Shopify; the limits meter is empty." });
  if (page.limits?.level === "critical") warnings.push({ code: "AUTOMATIC_DISCOUNT_LIMIT", severity: "block", message: `The store is at Shopify's cap of ${page.limits.limit} active automatic discounts.` });
  else if (page.limits?.level === "warning") warnings.push({ code: "AUTOMATIC_DISCOUNT_NEAR_LIMIT", severity: "warn", message: "The store is close to Shopify's automatic discount cap." });
  if (page.capacity && page.capacity.open.length > 0) {
    warnings.push({ code: "OPEN_CAPACITY_INCIDENTS", severity: "warn", message: `${page.capacity.open.length} open capacity incident(s): capacity_incidents_list shows the fixes.` });
  }

  const fullest = planned ? Math.max(0, ...planned.bytesPerSlot) : breakdown.totalBytes;
  const data = {
    shopDomain: shop!.myshopifyDomain,
    health: page.diagnostics,
    shopifyLimits: page.limits
      ? {
          automaticDiscountCap: page.limits.limit,
          storeActive: page.limits.storeActive,
          ours: page.limits.ours,
          others: page.limits.others,
          level: page.limits.level,
          cartSlotsInUse: page.limits.slotsInUse,
          maxCartSlots: page.limits.maxCartSlots,
          shardsEnabled: page.limits.shardsEnabled,
        }
      : null,
    config: {
      metafieldLimitBytes: MAX_METAFIELD_BYTES,
      sharedConfigBytes: breakdown.totalBytes,
      fullestNodeBytes: fullest,
      fullestNodePct: pct(fullest, MAX_METAFIELD_BYTES),
      deliveryBytes: breakdown.deliveryBytes,
      validationBytes: breakdown.validationBytes,
      topOffers: [...breakdown.perOffer].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_OFFERS),
    },
    nodes: {
      cartNodeId: nodes?.discountId ?? null,
      deliveryNodeId: nodes?.deliveryDiscountId ?? null,
      shardNodes: shardRows.filter((row) => row.slot > 0).map((row) => ({ slot: row.slot, nodeId: row.nodeId, bytes: row.bytes })),
      planned: planned
        ? {
            slots: planned.slots,
            maxSlots: planned.maxSlots,
            bytesPerSlot: planned.bytesPerSlot,
            offersPerSlot: planned.offersPerSlot ?? null,
            singleShardReason: planned.singleShardReason ?? null,
          }
        : null,
    },
    instructionEstimate: {
      budgetPerNode: NODE_INSTRUCTION_BUDGET,
      nodeFloor: NODE_INSTRUCTION_FLOOR,
      perPlannedSlot: planned?.instructionsPerSlot ?? null,
      warnings: planned?.warnings ?? [],
    },
    combinationDomains: {
      enabled: page.limits?.domainsEnabled ?? false,
      groups: page.limits?.combinationGroups ?? null,
      policyPerSlot: planned?.policyPerSlot ?? null,
      blockers: planned?.combinationBlockers ?? [],
    },
    transforms: { incidents: page.capacity?.open ?? [], recentlyResolved: page.capacity?.resolved ?? [], actions: page.capacity?.actions ?? [] },
  };

  return buildResult(
    {
      summary: `${shop!.myshopifyDomain}: ${page.diagnostics?.activeOffers ?? 0} active offer(s), fullest node ${pct(fullest, MAX_METAFIELD_BYTES)}% of ${MAX_METAFIELD_BYTES} bytes, ${
        page.limits ? `${page.limits.storeActive ?? "?"}/${page.limits.limit} automatic discounts in the store` : "automatic discount count unavailable"
      }, ${page.capacity?.open.length ?? 0} open capacity incident(s).`,
      data,
      links: [adminLink(shopHandle(shop!.myshopifyDomain))],
      warnings,
      nextActions: (page.capacity?.open.length ?? 0) > 0 ? [{ mcp: "promo-engine", tool: "capacity_incidents_list", args: { shop: shop!.myshopifyDomain }, why: "See the proposed fixes for the open incidents.", risk: "read" }] : [],
    },
    now,
  );
}

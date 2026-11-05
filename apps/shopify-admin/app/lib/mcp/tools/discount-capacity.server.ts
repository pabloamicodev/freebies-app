import { z } from "zod";
import { eq } from "drizzle-orm";
import { shops, type Db } from "@promo/db";
import { preflightCapacity, sharedConfigBreakdown, type CapacityBudget, type CapacityOptions } from "../../capacity-preflight.server.js";
import { MAX_VALIDATION_CONFIG_BYTES } from "../../cart-validation.server.js";
import { MAX_METAFIELD_BYTES } from "../../sync/offer-publisher.server.js";
import { shopifyGraphQL } from "../../shopify-fetch.server.js";
import { decryptToken } from "../../token-crypto.server.js";
import { buildResult, shopHandle, type ToolResult, type Warning } from "../result.server.js";
import { fanOut, type ShopRef } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import { adminLink, shopsInput } from "./catalog-shared.server.js";

export const discountCapacityInput = {
  shops: shopsInput,
  live: z.boolean().optional().describe("Also read the real function_config metafield from Shopify and compare (one Admin API call per shop). Default false."),
};

const WARN_AT = 0.8;
const TOP_OFFERS = 10;
const LIVE_METAFIELD_NAMESPACE = "$app:promo_engine";

export type LiveNode = { role: "cart" | "delivery"; found: boolean; bytes: number | null };
export type CapacityRow = {
  shopDomain: string;
  nodeCount: number;
  bytesUsed: number;
  limit: number;
  pct: number;
  headroom: number;
  risk: "ok" | "warn" | "block";
  offerCount: number;
  perOffer: { offerId: string; name: string; bytes: number }[];
  cartValidation: { bytesUsed: number; limit: number; pct: number };
  /** Slots the planner needs for the active offers (null when the plan is blocked or could not be computed). */
  plannedSlots: number | null;
  /** Cart slots the shop may use: 1 with sharding off, else the live automatic-discount budget. */
  maxCartSlots: number | null;
  deliveryBytes: number;
  budget: CapacityBudget | null;
  /** Code of the preflight failure the next publish would hit, if any. */
  blockedBy: string | null;
  live?: { checked: boolean; nodes: LiveNode[]; driftBytes: number | null; error?: string };
};

export type CapacityDeps = {
  graphQL?: typeof shopifyGraphQL;
  decrypt?: (stored: string) => Promise<string>;
  capacity?: CapacityOptions;
};

const pct = (used: number, limit: number) => Math.round((used / limit) * 1000) / 10;

async function liveCheck(db: Db, shop: ShopRef, computed: number, deps: CapacityDeps): Promise<NonNullable<CapacityRow["live"]>> {
  const [row] = await db
    .select({ token: shops.accessTokenEncrypted, discountId: shops.discountId, deliveryDiscountId: shops.deliveryDiscountId })
    .from(shops)
    .where(eq(shops.id, shop.id));
  const targets: { role: LiveNode["role"]; id: string }[] = [
    ...(row?.discountId ? [{ role: "cart" as const, id: row.discountId }] : []),
    ...(row?.deliveryDiscountId ? [{ role: "delivery" as const, id: row.deliveryDiscountId }] : []),
  ];
  if (!row || targets.length === 0) return { checked: false, nodes: [], driftBytes: null, error: "The shop has no discount nodes recorded yet." };
  const accessToken = await (deps.decrypt ?? decryptToken)(row.token);
  const data = await (deps.graphQL ?? shopifyGraphQL)<{ nodes: Array<{ id?: string; metafield?: { value: string } | null } | null> }>({
    shopDomain: shop.myshopifyDomain,
    accessToken,
    query: `query PromoEngineMcpCapacity($ids: [ID!]!) {
      nodes(ids: $ids) { ... on DiscountAutomaticNode { id metafield(namespace: "${LIVE_METAFIELD_NAMESPACE}", key: "function_config") { value } } }
    }`,
    variables: { ids: targets.map((t) => t.id) },
  });
  const nodes = targets.map((t, i): LiveNode => {
    const value = data.nodes[i]?.metafield?.value;
    return { role: t.role, found: typeof value === "string", bytes: typeof value === "string" ? new TextEncoder().encode(value).byteLength : null };
  });
  const cart = nodes.find((n) => n.role === "cart");
  return { checked: true, nodes, driftBytes: cart?.bytes == null ? null : cart.bytes - computed };
}

export async function discountCapacity(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; live?: boolean },
  now: () => Date = () => new Date(),
  deps: CapacityDeps = {},
): Promise<ToolResult<{ shops: CapacityRow[] }>> {
  const selected = selectShops(visible, args.shops);
  const { perShop, results } = await fanOut(selected, async (shop): Promise<CapacityRow> => {
    const [breakdown, [nodes]] = await Promise.all([
      sharedConfigBreakdown(db, shop.id, shop.currencyCode),
      db.select({ discountId: shops.discountId, deliveryDiscountId: shops.deliveryDiscountId }).from(shops).where(eq(shops.id, shop.id)),
    ]);
    const ratio = breakdown.totalBytes / MAX_METAFIELD_BYTES;
    const plan = await preflightCapacity(db, shop.id, [], deps.capacity).catch(() => null);
    const row: CapacityRow = {
      shopDomain: shop.myshopifyDomain,
      nodeCount: [nodes?.discountId, nodes?.deliveryDiscountId].filter(Boolean).length,
      bytesUsed: breakdown.totalBytes,
      limit: MAX_METAFIELD_BYTES,
      pct: pct(breakdown.totalBytes, MAX_METAFIELD_BYTES),
      headroom: MAX_METAFIELD_BYTES - breakdown.totalBytes,
      risk: ratio > 1 ? "block" : ratio >= WARN_AT ? "warn" : "ok",
      offerCount: breakdown.perOffer.length,
      plannedSlots: plan?.ok ? plan.plan.slots : null,
      maxCartSlots: plan?.ok ? plan.plan.maxSlots : null,
      deliveryBytes: breakdown.deliveryBytes,
      budget: plan?.ok ? plan.plan.budget : null,
      blockedBy: plan && !plan.ok ? plan.code : null,
      perOffer: [...breakdown.perOffer].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_OFFERS),
      cartValidation: {
        bytesUsed: breakdown.validationBytes,
        limit: MAX_VALIDATION_CONFIG_BYTES,
        pct: pct(breakdown.validationBytes, MAX_VALIDATION_CONFIG_BYTES),
      },
    };
    if (args.live) {
      try {
        row.live = await liveCheck(db, shop, breakdown.totalBytes, deps);
      } catch {
        row.live = { checked: false, nodes: [], driftBytes: null, error: "The live metafield could not be read from Shopify." };
      }
    }
    return row;
  });

  const rows = results.map((r) => r.value);
  const warnings: Warning[] = [];
  for (const r of rows) {
    if (r.risk !== "ok") {
      warnings.push({
        code: r.risk === "block" ? "CAPACITY_EXCEEDED" : "CAPACITY_HIGH",
        severity: r.risk === "block" ? "block" : "warn",
        message: `${r.shopDomain} uses ${r.bytesUsed} of ${r.limit} bytes (${r.pct}%)${r.risk === "block" ? ": the next publish will fail" : ""}.`,
      });
    }
    if (r.blockedBy) warnings.push({ code: `CAPACITY_${r.blockedBy}`, severity: "block", message: `${r.shopDomain}: the capacity preflight fails with ${r.blockedBy}; the next activation would be refused.` });
    if (r.cartValidation.pct >= WARN_AT * 100) {
      warnings.push({ code: "VALIDATION_CAPACITY_HIGH", severity: r.cartValidation.pct > 100 ? "block" : "warn", message: `${r.shopDomain} cart validation config is at ${r.cartValidation.pct}% of its limit.` });
    }
    if (r.live && !r.live.checked) warnings.push({ code: "LIVE_CHECK_FAILED", severity: "info", message: `${r.shopDomain}: ${r.live.error}` });
    if (r.live?.driftBytes) warnings.push({ code: "LIVE_DRIFT", severity: "warn", message: `${r.shopDomain}: the live metafield differs from the database config by ${r.live.driftBytes} bytes.` });
  }

  const summary = [
    `Shared config capacity (limit ${MAX_METAFIELD_BYTES} bytes per node):`,
    ...rows.map((r) => `- ${r.shopDomain}: ${r.bytesUsed} B (${r.pct}%), headroom ${r.headroom} B, ${r.offerCount} offers, slots ${r.plannedSlots ?? "?"}/${r.maxCartSlots ?? "?"}, ${r.risk}${r.perOffer[0] ? `; heaviest "${r.perOffer[0].name}" ${r.perOffer[0].bytes} B` : ""}`),
  ].join("\n");

  return buildResult(
    {
      summary,
      data: { shops: rows },
      perShop,
      links: selected.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
      warnings,
      nextActions: rows
        .filter((r) => r.risk !== "ok" && r.perOffer[0])
        .map((r) => ({ mcp: "promo-engine" as const, tool: "promos_active", args: { shops: [r.shopDomain] }, why: `Review the offers on ${r.shopDomain}; the heaviest is ${r.perOffer[0]!.offerId}.`, risk: "read" as const })),
    },
    now,
  );
}

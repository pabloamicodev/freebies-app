import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "@promo/db";
import { setTierMode } from "../../offer-rewards.server.js";
import type { AuthoringDeps } from "../../offer-authoring/types.js";
import { giftTierModeSchema } from "../../gift-tier-campaigns.js";
import { buildResult, moneyFromMinor, shopHandle, ToolError, promoRef, type ErrorCode, type Money, type ToolResult } from "../result.server.js";
import { fanOut } from "../multi-shop.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { runWrite, type CallInfo } from "../write-runner.server.js";
import {
  OFFER_STATUSES,
  adminLink,
  loadOffers,
  paginate,
  pagingInput,
  ref,
  resolvePromoRef,
  shopsInput,
  type Paging,
} from "./catalog-shared.server.js";

const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};

export const promoSetTierModeInput = {
  ...refFields,
  mode: giftTierModeSchema.describe("cumulative = a cart that reaches several tiers gets every reached tier's gift; highest = only the highest reached tier's gift."),
  dryRun: z.boolean().optional().describe("true previews the change without writing or publishing. Default false."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};

export const giftTiersGetInput = {
  shops: shopsInput,
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId> to look at one gift offer."),
  status: z.array(z.enum(OFFER_STATUSES)).optional().describe("Default: every non-archived status."),
  ...pagingInput,
};

const deps = (shop: VisibleShop, db: Db): AuthoringDeps => ({
  db,
  shopId: shop.id,
  shopDomain: shop.myshopifyDomain,
  shopCurrency: shop.currencyCode,
  timezone: shop.timezone,
});

type TierModeResult = { ok: boolean; error?: string; code?: string; capacity?: unknown; publishError?: string; value?: Record<string, unknown> };

function failure(result: TierModeResult): ToolError {
  const message = (result.error ?? "Could not change the tier mode.").replace(/\s+/g, " ").slice(0, 300);
  if (result.code === "not_found") return new ToolError("NOT_FOUND", "Offer not found in that shop.");
  if (result.capacity) {
    // CAPACITY_LIMIT is added to ERROR_CODES by package 01; the string is the contract.
    return new ToolError("CAPACITY_LIMIT" as unknown as ErrorCode, message, { details: { capacity: result.capacity as never } });
  }
  if (result.code === "stale") return new ToolError("STATE_CONFLICT", message);
  if (result.code === "publish_failed") return new ToolError("PUBLISH_FAILED", message);
  return new ToolError("VALIDATION", message);
}

export async function setTierModeTool(
  ctx: McpContext,
  call: CallInfo,
  args: { ref?: string; shop?: string; mode: z.infer<typeof giftTierModeSchema>; dryRun?: boolean; idempotencyKey?: string },
): Promise<CallToolResult> {
  const started = performance.now();
  let target: { shop: VisibleShop; offerId: string };
  try {
    target = resolvePromoRef(await visibleShops(ctx.db, ctx.operator), args);
  } catch (error) {
    const response = toErrorCallToolResult(error);
    await logCall(ctx.db, {
      operatorId: ctx.operator.id,
      tool: "promo_set_tier_mode",
      shops: shopsFromArgs(args),
      args,
      outcome: (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL",
      durationMs: performance.now() - started,
    });
    return response;
  }
  const { shop, offerId } = target;
  const offerRef = promoRef(shop.myshopifyDomain, offerId);
  const run = async (opts: { performedBy: string; auditExtra?: Record<string, unknown>; dryRun?: boolean; publish?: McpContext["publish"]; expectedUpdatedAt?: Date | null }) => {
    const result = (await setTierMode(deps(shop, ctx.db), offerId, args.mode, {
      performedBy: opts.performedBy,
      ...(opts.auditExtra ? { auditExtra: opts.auditExtra } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.publish ? { publish: opts.publish } : {}),
      ...(opts.expectedUpdatedAt ? { expectedUpdatedAt: opts.expectedUpdatedAt } : {}),
    })) as unknown as TierModeResult;
    if (!result.ok) throw failure(result);
    return result;
  };
  return runWrite(ctx, call, {
    tool: "promo_set_tier_mode",
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: [shop],
    preview: async () => {
      const result = await run({ performedBy: `mcp:${ctx.operator.id}`, dryRun: true });
      return {
        summary: `Set gift tier mode of ${offerRef} to "${args.mode}".`,
        data: { promoRef: offerRef, offerId, tierMode: args.mode, ...(result.value ?? {}) },
        links: [adminLink(shopHandle(shop.myshopifyDomain))],
        offerUpdatedAt: null,
      };
    },
    apply: async (a) => {
      const result = await run({ performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: a.expectedUpdatedAt });
      return {
        summary: `Gift tier mode of ${offerRef} is now "${args.mode}"${result.publishError ? ` (saved, but publishing failed: ${result.publishError})` : ""}.`,
        data: { promoRef: offerRef, offerId, tierMode: args.mode, ...(result.value ?? {}) },
        links: [adminLink(shopHandle(shop.myshopifyDomain))],
        nextActions: [{ mcp: "promo-engine", tool: "gift_tiers_get", args: { ref: offerRef }, why: "Verify the tiers.", risk: "read" }],
      };
    },
  });
}

export type GiftTierRow = {
  rewardId: string;
  label: string | null;
  minCartSubtotal: Money;
  giftVariants: string[];
  fallbackVariants: string[];
  quantity: number | null;
  autoAdd: boolean;
  customerSelectable: boolean;
};
export type GiftTiersOffer = {
  promoRef: string;
  offerId: string;
  shopDomain: string;
  name: string;
  status: string;
  tierMode: string;
  tierModeMeaning: string;
  mainThreshold: Money | null;
  tiers: GiftTierRow[];
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const MEANING: Record<string, string> = {
  cumulative: "A cart that reaches several tiers gets every reached tier's gift.",
  highest: "A cart that reaches several tiers gets only the highest reached tier's gift.",
};

/** The gift-tier view: every gift offer with cart-subtotal tiers, how reached tiers combine and whether the main threshold blocks lower tiers. */
export async function giftTiersGet(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; ref?: string; status?: string[] } & Paging,
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ offers: GiftTiersOffer[] }>> {
  const target = args.ref ? resolvePromoRef(visible, { ref: args.ref }) : null;
  const selected = target ? [target.shop] : selectShops(visible, args.shops);
  const statuses = args.status?.length ? args.status : [...OFFER_STATUSES];
  const warnings: { code: string; severity: "warn"; message: string }[] = [];
  const { perShop, results } = await fanOut(selected, async (shop) => {
    const loaded = await loadOffers(db, shop, { types: ["gift"], statuses, offerId: target?.offerId });
    const rows: GiftTiersOffer[] = [];
    for (const l of loaded) {
      const tiers = l.rewards
        .filter((r) => r.rewardType === "product_gift" && typeof r.minCartSubtotalCents === "number" && r.minCartSubtotalCents > 0)
        .sort((a, b) => (a.minCartSubtotalCents ?? 0) - (b.minCartSubtotalCents ?? 0))
        .map((r): GiftTierRow => {
          const t = (r.target ?? {}) as Record<string, unknown>;
          return {
            rewardId: r.id,
            label: r.label ?? null,
            minCartSubtotal: moneyFromMinor(r.minCartSubtotalCents!, shop.currencyCode),
            giftVariants: strings(t["variantIds"]),
            fallbackVariants: strings(t["fallbackVariantIds"]),
            quantity: r.quantity ?? null,
            autoAdd: r.isAutoAdd,
            customerSelectable: r.isCustomerSelectable,
          };
        });
      if (tiers.length === 0 && !target) continue;
      const main = l.conditions.find((c) => c.scope === "main" && c.conditionType === "cart_value" && c.isEnabled);
      const threshold = (main?.value as { thresholdCents?: unknown } | undefined)?.thresholdCents;
      const mainThreshold = typeof threshold === "number" ? moneyFromMinor(threshold, shop.currencyCode) : null;
      const lowest = tiers[0]?.minCartSubtotal;
      const lowestCents = l.rewards.flatMap((r) => (r.minCartSubtotalCents ? [r.minCartSubtotalCents] : [])).sort((a, b) => a - b)[0];
      if (typeof threshold === "number" && lowestCents !== undefined && lowest && threshold > lowestCents) {
        warnings.push({ code: "TIER_BELOW_MAIN_THRESHOLD", severity: "warn", message: `${l.offer.internalName}: the main cart-value condition is above the lowest tier, so lower tiers are unreachable.` });
      }
      rows.push({
        promoRef: ref(shop, l.offer.id),
        offerId: l.offer.id,
        shopDomain: shop.myshopifyDomain,
        name: l.offer.internalName,
        status: l.offer.status,
        tierMode: l.offer.tierMode ?? "cumulative",
        tierModeMeaning: MEANING[l.offer.tierMode ?? "cumulative"] ?? "",
        mainThreshold,
        tiers,
      });
    }
    return rows;
  });
  const all = results.flatMap((r) => r.value);
  const { page, hasMore, cursor } = paginate(all, args);
  const summary = [
    `${all.length} gift offer${all.length === 1 ? "" : "s"} with tiers.`,
    ...page.slice(0, 10).map((o) => `- ${o.name} (${o.status}) on ${o.shopDomain}: ${o.tierMode}, ${o.tiers.length} tier(s) from ${o.tiers[0]?.minCartSubtotal.currency ?? ""} ${o.tiers[0]?.minCartSubtotal.amount ?? "-"}`),
  ].join("\n");
  return buildResult(
    {
      summary,
      data: { offers: page },
      perShop,
      links: selected.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
      warnings,
      nextActions: page.slice(0, 3).map((o) => ({ mcp: "promo-engine" as const, tool: "promo_set_tier_mode", args: { ref: o.promoRef, mode: o.tierMode === "highest" ? "cumulative" : "highest", dryRun: true }, why: "Preview switching how reached tiers combine.", risk: "write" as const })),
      meta: { page: { ...(cursor ? { cursor } : {}), hasMore } },
    },
    now,
  );
}

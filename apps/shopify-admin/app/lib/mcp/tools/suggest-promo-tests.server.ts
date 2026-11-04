import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { bundleDefinitions, bundleTiers, offerConditions, offers, shops, type Db } from "@promo/db";
import {
  buildResult,
  moneyFromMinor,
  promoRef,
  shopHandle,
  type ExperimentType,
  type Money,
  type NextAction,
  type TestIdea,
  type ToolResult,
  type Warning,
} from "../result.server.js";
import { fanOut, type ShopRef } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import { getExperimentDirectory } from "../../experiment-directory.server.js";
import { decryptToken } from "../../token-crypto.server.js";
import type { DirectoryExperiment } from "../../experiment-directory.js";
import { clampLimit, encodeCursor, offsetFromCursor, resolveWindow, rate, type Window } from "./insights-common.server.js";
import { moneyOf, queryShopPerformance, ratesOf, type Bucket, type Counts, type Rates } from "./promo-performance.server.js";

export const GOALS = ["aov", "conversion", "retention"] as const;
export type Goal = (typeof GOALS)[number];

export const suggestPromoTestsInput = {
  shops: z.array(z.string()).optional().describe("Shop domains, handles or ids; omitted = every visible shop."),
  goal: z.enum(GOALS).optional().describe("aov | conversion | retention: orders the candidates, never hides the others."),
  lastDays: z.number().int().min(1).max(90).optional().describe("Performance window in days (default 30, max 90)."),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Max candidates (default 25)."),
};

const GAP_KINDS = ["gift_no_limit", "bundle_no_tiers", "gift_threshold_near_aov", "low_add_rate", "offer_no_impressions", "binding_stale", "no_active_offers"] as const;
export type GapKind = (typeof GAP_KINDS)[number];

export type Gap = { kind: GapKind; promoRef?: string; offerName?: string; message: string };

export type ActivePromo = {
  promoRef: string;
  name: string;
  type: string;
  performance: { counts: Counts; rates: Rates };
};

export type DirectoryEntry = {
  shopDomain: string;
  available: boolean;
  experiments: { id: string; name: string; status: string; mode: string; variants: { key: string; name: string; control: boolean }[] }[];
};

export type ExperimentBinding = {
  shopDomain: string;
  promoRef: string;
  offerName: string;
  experimentId: string;
  experimentName: string | null;
  variantKeys: string[];
  inDirectory: boolean | null;
  directoryStatus: string | null;
};

export type TestCandidate = TestIdea & {
  shopDomain: string;
  gap: GapKind;
  promoRef?: string;
  confidence: "low" | "medium" | "high";
  baseline?: { window: { start: string; end: string }; metric: string; value: string };
  nextActions: NextAction[];
};

type ShopSuggestions = {
  activePromos: ActivePromo[];
  baseline: { attributedOrders: number; aov: Money[]; rates: Rates };
  gaps: Gap[];
  directory: DirectoryEntry;
  bindings: ExperimentBinding[];
  candidates: TestCandidate[];
};

const LIMITER_CONDITIONS = new Set(["one_use_per_customer", "product_quantity_limits", "collection_quantity_limits", "vendor_quantity_limits", "product_type_quantity_limits"]);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Which gap kinds each goal cares about most; used only to order candidates. */
const GOAL_PRIORITY: Record<Goal, GapKind[]> = {
  aov: ["gift_threshold_near_aov", "bundle_no_tiers", "gift_no_limit", "low_add_rate"],
  conversion: ["low_add_rate", "gift_threshold_near_aov", "bundle_no_tiers", "gift_no_limit"],
  retention: ["gift_no_limit", "low_add_rate", "bundle_no_tiers", "gift_threshold_near_aov"],
};

async function loadDirectory(db: Db, shop: ShopRef): Promise<DirectoryEntry> {
  const unavailable: DirectoryEntry = { shopDomain: shop.myshopifyDomain, available: false, experiments: [] };
  try {
    const [row] = await db.select({ token: shops.accessTokenEncrypted }).from(shops).where(eq(shops.id, shop.id)).limit(1);
    if (!row) return unavailable;
    const directory = await getExperimentDirectory({ shopDomain: shop.myshopifyDomain, accessToken: await decryptToken(row.token) });
    if (directory.unavailable) return unavailable;
    return {
      shopDomain: shop.myshopifyDomain,
      available: true,
      experiments: directory.experiments.map((e: DirectoryExperiment) => ({ id: e.id, name: e.name, status: e.status, mode: e.mode, variants: e.variants })),
    };
  } catch {
    return unavailable;
  }
}

function experimentArgs(shop: ShopRef, idea: { title: string; hypothesis: string; type: ExperimentType; metric: string; arms: TestIdea["arms"] }) {
  return {
    shop: shop.myshopifyDomain,
    type: idea.type,
    name: idea.title,
    hypothesis: idea.hypothesis,
    primaryMetric: idea.metric,
    variants: idea.arms.map((a, i) => ({ key: a.key, name: a.key, control: i === 0, description: a.description })),
    dryRun: true,
  };
}

function candidateFor(
  shop: ShopRef,
  window: Window,
  gap: Gap,
  extra: { title: string; hypothesis: string; type: ExperimentType; metric: "conversion" | "aov" | "rpv"; arms: TestIdea["arms"]; risks: string[]; confidence: TestCandidate["confidence"]; baseline?: string; evidenceNote: string },
): TestCandidate {
  const actions: NextAction[] = [];
  if (gap.promoRef) {
    actions.push({
      mcp: "promo-engine",
      tool: "promo_duplicate",
      args: { ref: gap.promoRef, name: `${extra.title} (variant)`, dryRun: true },
      why: "Create the variant offer as a draft copy (write tool; only enabled shops).",
      risk: "write",
    });
  }
  actions.push({
    mcp: "experiment-engine",
    tool: "experiments_create",
    args: experimentArgs(shop, { title: extra.title, hypothesis: extra.hypothesis, type: extra.type, metric: extra.metric, arms: extra.arms }),
    why: "Draft the experiment in the Experiment Engine; join by shopDomain.",
    risk: "write",
  });
  if (extra.type === "OFFER_TEST") {
    actions.push({
      mcp: "experiment-engine",
      tool: "experiments_configure_arms",
      args: {
        ref: "<ref returned by experiments_create>",
        arms: extra.arms.slice(1).map((a) => ({ key: a.key, config: { modification: { offerType: "BANNER", headline: a.description } } })),
        dryRun: true,
      },
      why: "Configure the treatment arm(s) once the experiment exists; adjust offerType (BANNER|POPUP|CART_DRAWER|PRODUCT_PAGE) and copy before confirming.",
      risk: "write",
    });
  }
  return {
    title: extra.title,
    hypothesis: extra.hypothesis,
    suggestedExperimentType: extra.type,
    arms: extra.arms,
    primaryMetric: extra.metric,
    shopRefs: [shop.myshopifyDomain],
    evidence: [{ source: "promo-engine", ref: gap.promoRef ?? shop.myshopifyDomain, note: extra.evidenceNote }],
    risks: extra.risks,
    shopDomain: shop.myshopifyDomain,
    gap: gap.kind,
    ...(gap.promoRef ? { promoRef: gap.promoRef } : {}),
    confidence: extra.confidence,
    ...(extra.baseline
      ? { baseline: { window: { start: window.start.toISOString(), end: window.end.toISOString() }, metric: extra.metric, value: extra.baseline } }
      : {}),
    nextActions: actions,
  };
}

async function suggestForShop(db: Db, shop: ShopRef, window: Window): Promise<ShopSuggestions> {
  const [perf, directory, active] = await Promise.all([
    queryShopPerformance(db, shop, window, { groupBy: "offer" }),
    loadDirectory(db, shop),
    db
      .select({ id: offers.id, name: offers.internalName, type: offers.type })
      .from(offers)
      .where(and(eq(offers.shopId, shop.id), eq(offers.status, "active")))
      .orderBy(offers.internalName),
  ]);
  const ids = active.map((o) => o.id);
  const [conditions, bundles] = ids.length
    ? await Promise.all([
        db
          .select({ offerId: offerConditions.offerId, conditionType: offerConditions.conditionType, value: offerConditions.value })
          .from(offerConditions)
          .where(and(eq(offerConditions.shopId, shop.id), eq(offerConditions.isEnabled, true), inArray(offerConditions.offerId, ids))),
        db
          .select({ id: bundleDefinitions.id, offerId: bundleDefinitions.offerId })
          .from(bundleDefinitions)
          .where(and(eq(bundleDefinitions.shopId, shop.id), inArray(bundleDefinitions.offerId, ids))),
      ])
    : [[], []];
  const tierRows = bundles.length
    ? await db
        .select({ bundleId: bundleTiers.bundleId })
        .from(bundleTiers)
        .where(and(eq(bundleTiers.shopId, shop.id), inArray(bundleTiers.bundleId, bundles.map((b) => b.id))))
    : [];
  const tiered = new Set(tierRows.map((t) => t.bundleId));
  const bundleByOffer = new Map(bundles.map((b) => [b.offerId, b]));

  const condsByOffer = new Map<string, typeof conditions>();
  for (const c of conditions) condsByOffer.set(c.offerId, [...(condsByOffer.get(c.offerId) ?? []), c]);

  const directoryById = new Map(directory.experiments.map((e) => [e.id, e]));
  const bindings: ExperimentBinding[] = [];
  const bound = new Set<string>();
  for (const o of active) {
    for (const c of condsByOffer.get(o.id) ?? []) {
      if (c.conditionType !== "experiment") continue;
      const v = asRecord(c.value);
      if (typeof v["experimentId"] !== "string" || !v["experimentId"]) continue;
      const entry = directoryById.get(v["experimentId"]);
      bound.add(o.id);
      bindings.push({
        shopDomain: shop.myshopifyDomain,
        promoRef: promoRef(shop.myshopifyDomain, o.id),
        offerName: o.name,
        experimentId: v["experimentId"],
        experimentName: typeof v["experimentName"] === "string" ? v["experimentName"] : null,
        variantKeys: Array.isArray(v["variantKeys"]) ? v["variantKeys"].filter((k): k is string => typeof k === "string") : [],
        inDirectory: directory.available ? Boolean(entry) : null,
        directoryStatus: entry?.status ?? null,
      });
    }
  }

  const rateOf = (id: string) => perf.buckets.get(id);
  const activePromos: ActivePromo[] = active.slice(0, 50).map((o) => {
    const b: Bucket | undefined = rateOf(o.id);
    const counts: Counts = b
      ? { views: b.views, qualified: b.qualified, adds: b.adds, checkouts: b.checkouts, cartErrors: b.cartErrors, orders: b.orders }
      : { views: 0, qualified: 0, adds: 0, checkouts: 0, cartErrors: 0, orders: 0 };
    return { promoRef: promoRef(shop.myshopifyDomain, o.id), name: o.name, type: o.type, performance: { counts, rates: ratesOf(counts) } };
  });

  const money = moneyOf(perf.total);
  const shopCurrency = shop.currencyCode.toUpperCase();
  const aovOrders = perf.total.revenueOrders.get(shopCurrency) ?? 0;
  const aovMinor = aovOrders > 0 ? Math.round(perf.total.revenue.get(shopCurrency) / aovOrders) : null;
  const shopAov = aovMinor !== null ? moneyFromMinor(aovMinor, shopCurrency) : null;
  const totalCounts: Counts = { views: perf.total.views, qualified: perf.total.qualified, adds: perf.total.adds, checkouts: perf.total.checkouts, cartErrors: perf.total.cartErrors, orders: perf.total.orders };

  const gaps: Gap[] = [];
  const candidates: TestCandidate[] = [];
  if (active.length === 0) gaps.push({ kind: "no_active_offers", message: "The shop has no active offers, so there is nothing to test yet." });

  for (const o of active) {
    const ref = promoRef(shop.myshopifyDomain, o.id);
    const conds = condsByOffer.get(o.id) ?? [];
    const counts = activePromos.find((p) => p.promoRef === ref)?.performance;
    const base = { promoRef: ref, offerName: o.name };

    if (counts && counts.counts.views === 0 && counts.counts.adds === 0 && perf.quality.eventCounts.views > 0) {
      gaps.push({ ...base, kind: "offer_no_impressions", message: `"${o.name}" has no views or adds in the window while other offers do.` });
    }
    if (bound.has(o.id)) continue;

    if (o.type === "gift" && !conds.some((c) => LIMITER_CONDITIONS.has(c.conditionType))) {
      const gap: Gap = { ...base, kind: "gift_no_limit", message: `Gift offer "${o.name}" has no per-customer or quantity limit.` };
      gaps.push(gap);
      candidates.push(
        candidateFor(shop, window, gap, {
          title: `Limit "${o.name}" to one use per customer`,
          hypothesis: "Capping the free gift per customer protects margin without reducing conversion or AOV.",
          type: "OFFER_TEST",
          metric: "rpv",
          arms: [
            { key: "control", description: "Current gift offer, no limit.", promoRef: ref },
            { key: "limited", description: "Same gift with one use per customer." },
          ],
          risks: ["A limit can lower conversion for repeat buyers.", "Needs a sample large enough for repeat customers."],
          confidence: counts && counts.counts.orders >= 30 ? "medium" : "low",
          evidenceNote: "Active gift offer with no limiting condition.",
        }),
      );
    }

    if (o.type === "gift" && aovMinor !== null && aovMinor > 0) {
      const threshold = conds
        .filter((c) => c.conditionType === "cart_value")
        .map((c) => asRecord(c.value))
        .find((v) => typeof v["thresholdCents"] === "number" && String(v["currencyCode"] ?? shop.currencyCode).toUpperCase() === shop.currencyCode.toUpperCase());
      const cents = threshold ? Number(threshold["thresholdCents"]) : null;
      if (cents && cents / aovMinor >= 0.8 && cents / aovMinor <= 1.25) {
        const gap: Gap = { ...base, kind: "gift_threshold_near_aov", message: `Gift threshold ${moneyFromMinor(cents, shop.currencyCode).amount} is within 20-25% of the AOV (${shopAov!.amount}).` };
        gaps.push(gap);
        const raised = Math.round((aovMinor * 1.2) / 100) * 100;
        candidates.push(
          candidateFor(shop, window, gap, {
            title: `Raise the "${o.name}" gift threshold above the AOV`,
            hypothesis: `A threshold of about ${moneyFromMinor(raised, shop.currencyCode).amount} nudges buyers just under it to add items, lifting AOV.`,
            type: "OFFER_TEST",
            metric: "aov",
            arms: [
              { key: "control", description: `Current threshold ${moneyFromMinor(cents, shop.currencyCode).amount}.`, promoRef: ref },
              { key: "higher_threshold", description: `Threshold ${moneyFromMinor(raised, shop.currencyCode).amount}.` },
            ],
            risks: ["A higher threshold can reduce the share of buyers who qualify.", "AOV here is attributed-order subtotal, not total store AOV."],
            confidence: perf.total.orders >= 30 ? "medium" : "low",
            baseline: `${shopAov!.amount} ${shopAov!.currency}`,
            evidenceNote: `Threshold/AOV ratio ${(cents / aovMinor).toFixed(2)}.`,
          }),
        );
      }
    }

    const bundle = bundleByOffer.get(o.id);
    if (o.type === "bundle" && bundle && !tiered.has(bundle.id)) {
      const gap: Gap = { ...base, kind: "bundle_no_tiers", message: `Bundle "${o.name}" has no quantity tiers.` };
      gaps.push(gap);
      candidates.push(
        candidateFor(shop, window, gap, {
          title: `Add quantity tiers to "${o.name}"`,
          hypothesis: "Tiered discounts (buy more, save more) raise units per order compared with a flat bundle.",
          type: "OFFER_TEST",
          metric: "aov",
          arms: [
            { key: "control", description: "Current bundle without tiers.", promoRef: ref },
            { key: "tiered", description: "Same bundle with 2-3 quantity tiers." },
          ],
          risks: ["Deeper discounts at higher tiers reduce margin per unit."],
          confidence: "low",
          evidenceNote: "Bundle definition has zero bundle_tiers rows.",
        }),
      );
    }

    if (counts && counts.counts.views >= 100) {
      const addRate = rate(counts.counts.adds, counts.counts.views);
      if (addRate !== null && addRate < 0.02) {
        const gap: Gap = { ...base, kind: "low_add_rate", message: `"${o.name}" is seen (${counts.counts.views} views) but only ${(addRate * 100).toFixed(1)}% add it.` };
        gaps.push(gap);
        candidates.push(
          candidateFor(shop, window, gap, {
            title: `Test the widget copy of "${o.name}"`,
            hypothesis: "A clearer headline and benefit in the offer widget increases the add rate.",
            type: "CONTENT_TEST",
            metric: "conversion",
            arms: [
              { key: "control", description: "Current widget copy.", promoRef: ref },
              { key: "clearer_copy", description: "Benefit-led headline and button label." },
            ],
            risks: ["Views are browser events and can undercount; confirm in the Experiment Engine results."],
            confidence: counts.counts.views >= 500 ? "medium" : "low",
            baseline: `${(addRate * 100).toFixed(2)}% add rate`,
            evidenceNote: `${counts.counts.adds} adds from ${counts.counts.views} views.`,
          }),
        );
      }
    }
  }

  for (const b of bindings) {
    if (b.inDirectory === false) {
      gaps.push({ kind: "binding_stale", promoRef: b.promoRef, offerName: b.offerName, message: `"${b.offerName}" depends on experiment ${b.experimentId}, which is not in the Experiment Engine directory.` });
    }
  }

  return {
    activePromos,
    baseline: { attributedOrders: perf.total.orders, aov: money.aov, rates: ratesOf(totalCounts) },
    gaps,
    directory,
    bindings,
    candidates,
  };
}

export type SuggestPromoTestsData = {
  goal: Goal | null;
  window: { start: string; end: string };
  shops: {
    shopDomain: string;
    shopHandle: string;
    currency: string;
    timezone: string;
    activePromos: ActivePromo[];
    baseline: ShopSuggestions["baseline"];
    gaps: Gap[];
  }[];
  experimentDirectory: DirectoryEntry[];
  experimentBindings: ExperimentBinding[];
  candidates: TestCandidate[];
};

export async function suggestPromoTests(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; goal?: Goal; lastDays?: number; cursor?: string; limit?: number },
  now: () => Date = () => new Date(),
): Promise<ToolResult<SuggestPromoTestsData>> {
  const window = resolveWindow({ lastDays: args.lastDays }, now());
  const limit = clampLimit(args.limit);
  const offset = offsetFromCursor(args.cursor);
  const selected = selectShops(visible, args.shops);

  const { perShop, results } = await fanOut(selected, (shop) => suggestForShop(db, shop, window), {
    cacheKey: `suggest_promo_tests:${args.lastDays ?? 30}`,
    timeoutMs: 25_000,
    now: () => now().getTime(),
  });

  const priority = args.goal ? GOAL_PRIORITY[args.goal] : [];
  const rank = (c: TestCandidate) => {
    const i = priority.indexOf(c.gap);
    return i === -1 ? priority.length : i;
  };
  const confidenceRank = { high: 0, medium: 1, low: 2 } as const;
  const allCandidates = results
    .flatMap((r) => r.value.candidates)
    .sort((a, z) => rank(a) - rank(z) || confidenceRank[a.confidence] - confidenceRank[z.confidence] || a.shopDomain.localeCompare(z.shopDomain) || a.title.localeCompare(z.title));
  const page = allCandidates.slice(offset, offset + limit);
  const hasMore = offset + limit < allCandidates.length;

  const warnings: Warning[] = [];
  for (const { shop, value } of results) {
    if (!value.directory.available) {
      warnings.push({ code: "EE_DIRECTORY_UNAVAILABLE", severity: "info", message: `${shopHandle(shop.myshopifyDomain)}: the Experiment Engine directory metafield is missing or unreadable; existing experiments are unknown.` });
    }
    for (const g of value.gaps.filter((x) => x.kind === "binding_stale")) {
      warnings.push({ code: "BINDING_STALE", severity: "warn", message: g.message });
    }
  }
  for (const p of perShop.filter((s) => s.status === "error")) {
    warnings.push({ code: "SHOP_FAILED", severity: "warn", message: `${p.shopDomain}: suggestions could not be built (${p.reason ?? "error"}).` });
  }

  const gapCount = results.reduce((n, r) => n + r.value.gaps.length, 0);
  const summary = [
    `${allCandidates.length} test candidate(s) and ${gapCount} gap(s) across ${results.length} shop(s), last ${args.lastDays ?? 30} days${args.goal ? `, goal ${args.goal}` : ""}.`,
    ...page.slice(0, 6).map((c) => `- [${c.confidence}] ${c.shopDomain}: ${c.title} (${c.suggestedExperimentType}, ${c.primaryMetric})`),
    "Join with the Experiment Engine MCP by shopDomain (experiments_list, results_get); nothing here calls it.",
    hasMore ? "More candidates are available with the cursor." : "",
  ].filter(Boolean).join("\n");

  const nextActions: NextAction[] = [
    {
      mcp: "experiment-engine",
      tool: "experiments_list",
      args: { shops: results.map((r) => r.shop.myshopifyDomain) },
      why: "See which experiments already run before creating a new one.",
      risk: "read",
    },
    {
      mcp: "promo-engine",
      tool: "promo_performance",
      args: { shops: results.map((r) => r.shop.myshopifyDomain), lastDays: args.lastDays ?? 30, groupBy: "offer" },
      why: "Per-offer numbers behind these suggestions.",
      risk: "read",
    },
  ];

  return buildResult(
    {
      summary,
      data: {
        goal: args.goal ?? null,
        window: { start: window.start.toISOString(), end: window.end.toISOString() },
        shops: results.map(({ shop, value }) => ({
          shopDomain: shop.myshopifyDomain,
          shopHandle: shopHandle(shop.myshopifyDomain),
          currency: shop.currencyCode,
          timezone: shop.timezone,
          activePromos: value.activePromos,
          baseline: value.baseline,
          gaps: value.gaps,
        })),
        experimentDirectory: results.map((r) => r.value.directory),
        experimentBindings: results.flatMap((r) => r.value.bindings),
        candidates: page,
      },
      perShop,
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

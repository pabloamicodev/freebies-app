import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { auditLogs, offerVersions, type Db } from "@promo/db";
import { conditionTypeLabel, rewardSummary, targetSummaryParts } from "../../offer-summaries.js";
import { readExcludeUrls, readPageTypes, readPageUrls } from "../../page-types.js";
import { ToolError, buildResult, shopHandle, type ToolResult } from "../result.server.js";
import type { VisibleShop } from "../shops.server.js";
import {
  adminLink,
  combinesWith,
  getOfferPublishErrors,
  iso,
  loadOffers,
  maskCode,
  ref,
  resolvePromoRef,
  safeConditionSummary,
  subtypeOf,
} from "./catalog-shared.server.js";

export const promoDetailInput = {
  ref: z.string().optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Audit rows carry free-form before/after blobs; only the action, time and a coarse actor leave the server. */
function actorOf(performedBy: string | null): string {
  if (!performedBy) return "system";
  return performedBy.startsWith("mcp:") ? performedBy : "merchant";
}

export async function promoDetail(
  db: Db,
  visible: VisibleShop[],
  args: { ref?: string; shop?: string },
  now: () => Date = () => new Date(),
): Promise<ToolResult<Record<string, unknown>>> {
  const { shop, offerId } = resolvePromoRef(visible, { ref: args.ref, shop: args.shop });
  const [loaded] = await loadOffers(db, shop, { offerId });
  if (!loaded) throw new ToolError("NOT_FOUND", "Offer not found in that shop.", {
    suggestedAction: { mcp: "promo-engine", tool: "promos_active", args: { shops: [shop.myshopifyDomain], status: ["active", "scheduled", "paused", "draft"] }, why: "List the offers of that shop." },
  });
  const { offer, conditions, rewards, policy } = loaded;

  const [versions, events, errors] = await Promise.all([
    db
      .select({ versionNumber: offerVersions.versionNumber, createdAt: offerVersions.createdAt })
      .from(offerVersions)
      .where(and(eq(offerVersions.shopId, shop.id), eq(offerVersions.offerId, offer.id)))
      .orderBy(desc(offerVersions.versionNumber))
      .limit(10),
    db
      .select({ action: auditLogs.action, performedBy: auditLogs.performedBy, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(and(eq(auditLogs.shopId, shop.id), eq(auditLogs.entityId, offer.id)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(10),
    getOfferPublishErrors(shop.id, db),
  ]);

  const enabled = conditions.filter((c) => c.isEnabled);
  const pick = (type: string) => enabled.filter((c) => c.conditionType === type).map((c) => (c.value ?? {}) as Record<string, unknown>);
  const pageTypesValue = pick("page_types");
  const experimentBindings = pick("experiment").map((v) => ({
    experimentId: typeof v["experimentId"] === "string" ? v["experimentId"] : null,
    experimentName: typeof v["experimentName"] === "string" ? v["experimentName"] : null,
    variantKeys: strings(v["variantKeys"]),
  }));
  const pageConditions = {
    pageTypes: pageTypesValue.flatMap((v) => readPageTypes(v["pageTypes"])),
    pageUrls: pageTypesValue.flatMap((v) => readPageUrls(v["pageUrls"])),
    excludeUrls: pageTypesValue.flatMap((v) => readExcludeUrls(v["excludeUrls"])),
    templates: pick("template").flatMap((v) => strings(v["templates"])),
    sections: pick("section_shown").flatMap((v) =>
      (Array.isArray(v["sections"]) ? (v["sections"] as Array<Record<string, unknown>>) : []).map((s) => `${String(s["template"] ?? "?")}/${String(s["key"] ?? "?")}`),
    ),
    pageUrlPatterns: pick("page_url").flatMap((v) => strings(v["patterns"])),
    testGroups: experimentBindings,
  };

  const data = {
    promoRef: ref(shop, offer.id),
    offerId: offer.id,
    shopDomain: shop.myshopifyDomain,
    name: offer.internalName,
    publicTitle: offer.publicTitle,
    description: offer.description,
    type: offer.type,
    subtype: subtypeOf(loaded),
    status: offer.status,
    priority: offer.priority,
    schedule: { startsAt: iso(offer.startsAt), endsAt: iso(offer.endsAt), timezone: offer.timezone ?? shop.timezone, shopTimezone: shop.timezone },
    conditions: conditions.map((c) => ({
      type: c.conditionType,
      label: conditionTypeLabel(c.conditionType),
      scope: c.scope,
      operator: c.operator,
      enabled: c.isEnabled,
      summary: safeConditionSummary(c),
    })),
    pageConditions,
    rewards: rewards.map((r) => ({
      rewardType: r.rewardType,
      discountType: r.discountType,
      summary: rewardSummary(r),
      quantity: r.quantity,
      autoAdd: r.isAutoAdd,
      customerSelectable: r.isCustomerSelectable,
      target: targetSummaryParts(r.target),
    })),
    combinationPolicy: {
      ...combinesWith(policy),
      canStackWithGiftOffers: policy?.canStackWithGiftOffers ?? true,
      giftValueCountsForOtherOffers: policy?.giftValueCountsForOtherOffers ?? false,
    },
    limits: {
      maxApplicationsPerCart: policy?.maxApplicationsPerCart ?? null,
      maxApplicationsPerCustomer: policy?.maxApplicationsPerCustomer ?? null,
      requireIdentifiedCustomer: policy?.requireIdentifiedCustomer ?? false,
      oncePerCustomer: enabled.some((c) => c.conditionType === "one_use_per_customer"),
    },
    codes: {
      requiresCode: offer.requiresCode,
      redemption: offer.codeRedemption,
      requiredCodeMasked: offer.requiredDiscountCode ? maskCode(offer.requiredDiscountCode) : null,
    },
    versions: versions.map((v) => ({ versionNumber: v.versionNumber, createdAt: v.createdAt.toISOString() })),
    experimentBindings,
    publishErrors: errors[offer.id] ? [errors[offer.id]!] : [],
    recentEvents: events.map((e) => ({ action: e.action, actor: actorOf(e.performedBy), at: e.createdAt.toISOString() })),
  };

  const summary = [
    `${offer.internalName} (${offer.type}${data.subtype ? `/${data.subtype}` : ""}) on ${shop.myshopifyDomain}: ${offer.status}, priority ${offer.priority}.`,
    `Rewards: ${data.rewards.map((r) => r.summary).join("; ") || "none"}.`,
    `Conditions: ${data.conditions.filter((c) => c.enabled).map((c) => `${c.label} ${c.summary}`).join("; ") || "none"}.`,
    data.schedule.startsAt || data.schedule.endsAt ? `Schedule: ${data.schedule.startsAt ?? "now"} to ${data.schedule.endsAt ?? "no end"} (${data.schedule.timezone}).` : "No schedule.",
    data.publishErrors.length ? `Publish error: ${data.publishErrors[0]}` : "",
  ].filter(Boolean).join("\n");

  return buildResult(
    {
      summary,
      data,
      perShop: [{ shopDomain: shop.myshopifyDomain, shopHandle: shopHandle(shop.myshopifyDomain), shopTimezone: shop.timezone, currency: shop.currencyCode, status: "ok" }],
      links: [adminLink(shopHandle(shop.myshopifyDomain))],
      warnings: data.publishErrors.map((m) => ({ code: "PUBLISH_ERROR", severity: "warn" as const, message: m })),
      nextActions: pageConditions.pageTypes.length || pageConditions.pageUrls.length || pageConditions.templates.length
        ? [{ mcp: "promo-engine" as const, tool: "page_conditions_explain", args: { ref: data.promoRef, pageUrl: "/" }, why: "Check why this offer does or does not apply on a given page.", risk: "read" as const }]
        : [],
    },
    now,
  );
}

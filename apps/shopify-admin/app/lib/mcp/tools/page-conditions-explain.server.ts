import { z } from "zod";
import { classifyPageType, isPageConditionType } from "@promo/rule-engine";
import {
  PROMO_EXPERIMENT_KEY,
  PROMO_LANDING_URL_KEY,
  PROMO_PAGE_URL_KEY,
  PROMO_SECTIONS_KEY,
  PROMO_TEMPLATE_KEY,
  PAGE_TYPES,
  sanitizeProspective,
} from "@promo/shared-types";
import type { Db } from "@promo/db";
import { conditionTypeLabel } from "../../offer-summaries.js";
import { pageGateVerdict } from "../../page-gate.server.js";
import { cleanExcludeUrl, readExcludeUrls, readPageTypes } from "../../page-types.js";
import { ToolError, buildResult, shopHandle, type ToolResult } from "../result.server.js";
import type { VisibleShop } from "../shops.server.js";
import { adminLink, loadOffers, ref, resolvePromoRef, safeConditionSummary } from "./catalog-shared.server.js";

export const pageConditionsExplainInput = {
  ref: z.string().describe("promo:<shopHandle>:<offerId>"),
  pageUrl: z.string().max(1000).optional().describe("Storefront path or URL where the shopper adds the product, e.g. /products/mug?utm_source=x."),
  pageType: z.enum(PAGE_TYPES).optional().describe("Used with a representative path when pageUrl is not known."),
  ctx: z
    .object({
      template: z.string().max(100).optional().describe("Theme template of the page, e.g. product or product.alt."),
      sections: z.array(z.string().max(120)).max(8).optional().describe("Sections shown, as template/sectionKey."),
      experiments: z.array(z.string().max(120)).max(4).optional().describe("Test group entries, as experimentId:variantKey."),
      landingUrl: z.string().max(1000).optional().describe("Landing URL of the visit (visit-scoped UTM conditions)."),
    })
    .optional(),
};

type Args = {
  ref: string;
  pageUrl?: string;
  pageType?: (typeof PAGE_TYPES)[number];
  ctx?: { template?: string; sections?: string[]; experiments?: string[]; landingUrl?: string };
};

export type ConditionVerdict = {
  type: string;
  label: string;
  summary: string;
  passes: boolean;
  hint: string | null;
};

const REPRESENTATIVE_PATH: Record<string, string> = { home: "/", collection: "/collections/all", product: "/products/example", search: "/search", page: "/pages/example", blog: "/blogs/news", cart: "/cart" };

/** The page is the one the line is added from, so stamps count as seen on it (`@`). */
const onThisPage = (entries: string[]) => entries.map((e) => (e.startsWith("@") ? e : `@${e}`)).join(",");

function hintFor(type: string, value: Record<string, unknown>, path: string, pageType: string | null): string {
  switch (type) {
    case "page_types": {
      const allowed = readPageTypes(value["pageTypes"]);
      const excluded = readExcludeUrls(value["excludeUrls"]).map((u) => cleanExcludeUrl(u, true).toLowerCase());
      const normalized = path.replace(/\/+$/, "").toLowerCase() || "/";
      if (excluded.includes(normalized)) return `The path ${normalized} is in excludeUrls: remove it from "Exclude these pages".`;
      if (!pageType) return `This URL is not a home/collection/product/search/page/blog/cart page; the allowed types are ${allowed.join(", ") || "none"}.`;
      if (!allowed.includes(pageType as never)) return `This is a ${pageType} page but only ${allowed.join(", ") || "no page types"} are allowed: add ${pageType} to Store pages.`;
      return `The "page" type is limited to specific pages; add ${normalized} to the page list.`;
    }
    case "page_url":
      return "None of the page URL patterns matches this path: add a matching pattern.";
    case "template":
      return "The page template is not in the offer's template list (or was not seen on this page).";
    case "section_shown":
      return "None of the required sections was shown on this page.";
    case "experiment":
      return "The shopper is not in one of the selected test group variants on this page.";
    case "utm_parameters":
      return "The URL (or landing URL when visit-scoped) lacks the required UTM parameters.";
    case "specific_link":
      return "The page URL does not carry the required link parameter.";
    default:
      return "This condition does not match the context.";
  }
}

export async function pageConditionsExplain(
  db: Db,
  visible: VisibleShop[],
  args: Args,
  now: () => Date = () => new Date(),
): Promise<ToolResult<Record<string, unknown>>> {
  const { shop, offerId } = resolvePromoRef(visible, { ref: args.ref });
  const pageUrl = args.pageUrl?.trim() || (args.pageType ? REPRESENTATIVE_PATH[args.pageType] : undefined);
  if (!pageUrl) throw new ToolError("VALIDATION", "Pass pageUrl (or pageType) to evaluate the page conditions against.");

  const [loaded] = await loadOffers(db, shop, { offerId });
  if (!loaded) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");

  const stamps: Record<string, string> = { [PROMO_PAGE_URL_KEY]: pageUrl };
  const ctx = args.ctx ?? {};
  if (ctx.template) stamps[PROMO_TEMPLATE_KEY] = onThisPage([ctx.template]);
  if (ctx.sections?.length) stamps[PROMO_SECTIONS_KEY] = onThisPage(ctx.sections);
  if (ctx.experiments?.length) stamps[PROMO_EXPERIMENT_KEY] = onThisPage(ctx.experiments);
  stamps[PROMO_LANDING_URL_KEY] = ctx.landingUrl ?? pageUrl;
  const prospective = sanitizeProspective(stamps);

  const enabled = loaded.conditions.filter((c) => c.isEnabled);
  const gated = enabled.filter((c) => isPageConditionType(c.conditionType));
  const ignored = loaded.conditions.filter((c) => !c.isEnabled && isPageConditionType(c.conditionType));
  const overall = pageGateVerdict(enabled, prospective);
  const path = cleanExcludeUrl(pageUrl, true) || "/";
  const pageType = classifyPageType(pageUrl);

  const conditions: ConditionVerdict[] = gated.map((c) => {
    const passes = pageGateVerdict([c], prospective) === true;
    return {
      type: c.conditionType,
      label: conditionTypeLabel(c.conditionType),
      summary: safeConditionSummary(c),
      passes,
      hint: passes ? null : hintFor(c.conditionType, (c.value ?? {}) as Record<string, unknown>, path, pageType),
    };
  });
  const deciding = conditions.filter((c) => !c.passes);

  const verdict = overall === null ? "not_gated" : overall ? "applies" : "does_not_apply";
  const data = {
    promoRef: ref(shop, loaded.offer.id),
    offerName: loaded.offer.internalName,
    offerStatus: loaded.offer.status,
    verdict,
    evaluated: { pageUrl, normalizedPath: path, pageType, stamps: prospective },
    conditions,
    decidingConditions: deciding.map((c) => c.type),
    ignoredDisabledConditions: ignored.map((c) => c.conditionType),
    whatToChange: deciding.map((c) => c.hint).filter((h): h is string => !!h),
    note: "Page conditions are only one gate: cart, customer, schedule and status conditions are not evaluated here.",
  };

  const summary = [
    verdict === "not_gated"
      ? `${loaded.offer.internalName} has no page conditions: it is not restricted by page.`
      : `${loaded.offer.internalName} ${verdict === "applies" ? "applies" : "does NOT apply"} on ${pageUrl} (${pageType ?? "unclassified page"}).`,
    ...conditions.map((c) => `- ${c.passes ? "pass" : "FAIL"} ${c.label}: ${c.summary}${c.hint ? ` -> ${c.hint}` : ""}`),
    loaded.offer.status !== "active" ? `Note: the offer is ${loaded.offer.status}.` : "",
  ].filter(Boolean).join("\n");

  return buildResult(
    {
      summary,
      data,
      perShop: [{ shopDomain: shop.myshopifyDomain, shopHandle: shopHandle(shop.myshopifyDomain), shopTimezone: shop.timezone, currency: shop.currencyCode, status: "ok" }],
      links: [adminLink(shopHandle(shop.myshopifyDomain))],
      warnings: loaded.offer.status !== "active" ? [{ code: "OFFER_NOT_ACTIVE", severity: "info", message: `The offer is ${loaded.offer.status}; it will not apply regardless of page.` }] : [],
      nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref: data.promoRef }, why: "Full definition including every condition.", risk: "read" }],
    },
    now,
  );
}

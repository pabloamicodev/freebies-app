import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WidgetTypeSchema } from "@promo/shared-types";
import type { Db } from "@promo/db";
import {
  BOOSTER_WIDGET_TYPES,
  WIDGET_PLACEMENT_TYPES,
  addOfferWidget,
  deleteOfferWidget,
  listBoosterOffers,
  listBoosterWidgets,
  listOfferWidgets,
  loadMarketOverrides,
  setBoosterWidgetEnabled,
  setMarketOverrides,
  setOfferWidgetEnabled,
  type WidgetFailure,
  type WidgetResult,
} from "../../offer-widgets.server.js";
import type { AuthoringDeps, WriteServiceOptions } from "../../offer-authoring/types.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, ref as promoRefOf, resolvePromoRef } from "./catalog-shared.server.js";

const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};
const controls = {
  dryRun: z.boolean().optional().describe("Default false. true validates and previews the change without writing or publishing anything."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/, "must be a hex color like #ff0000 or #f00")
  .describe("Hex color like #ff0000.");

const WIDGET_TYPE_DOCS = `Widget types: gift_slider (gift picker slider), gift_popup, cart_message, today_offer_widget (floating booster), today_offer_block (inline booster), progress_bar (booster progress toward the threshold), gift_icon, gift_thumbnail, classic_bundle, mix_match_bundle, bundle_page, checkout_upsell, fbt (frequently bought together), thank_you_upsell, volume_discount (volume tiers block). Placement types: ${WIDGET_PLACEMENT_TYPES.join(", ")}.`;

export const promoWidgetsListInput = { ...refFields };
export const promoWidgetUpsertInput = {
  ...refFields,
  widgetType: WidgetTypeSchema.describe("Which storefront widget to add."),
  title: z.string().trim().max(200).optional().describe("Heading shown by the widget."),
  subtitle: z.string().trim().max(300).optional().describe("Sub-heading shown by the widget."),
  buttonText: z.string().trim().max(60).optional().describe('Call-to-action label. Default "Add to Cart".'),
  maxSelectable: z.number().int().min(1).max(50).optional().describe("Gift sliders/popups: how many gifts the customer may pick. Default 1."),
  layout: z.string().trim().max(40).optional().describe('Layout keyword understood by the widget (e.g. "popup", "slider"). Default "popup".'),
  showPrice: z.boolean().optional().describe("Show product prices in the widget. Default false."),
  showOutOfStock: z.boolean().optional().describe("Keep sold-out products visible. Default false."),
  primaryColor: hex.optional().describe("Accent color. Default #111111."),
  buttonColor: hex.optional().describe("Button background. Default: primaryColor."),
  textColor: hex.optional().describe("Button text color. Default #ffffff."),
  backgroundColor: hex.optional().describe("Widget background. Default #ffffff."),
  placementType: z.enum(WIDGET_PLACEMENT_TYPES).optional().describe("Where it renders. Omit to create the widget without a placement (it then renders nowhere)."),
  cssSelector: z.string().trim().max(300).optional().describe("Optional CSS selector the widget is injected into (placement)."),
  pageType: z.string().trim().max(40).optional().describe('Placement page rule: "all" (default), "product", "cart", or "custom" together with urlPattern.'),
  urlPattern: z.string().trim().max(300).optional().describe('Used when pageType is "custom".'),
  ...controls,
};
export const promoWidgetSetEnabledInput = {
  ...refFields,
  widgetId: z.string().uuid().describe("From promo_widgets_list."),
  enabled: z.boolean().describe("true shows the widget, false hides it."),
  ...controls,
};
export const promoWidgetDeleteInput = {
  ...refFields,
  widgetId: z.string().uuid().describe("From promo_widgets_list. The widget and its placements are removed."),
  ...controls,
};
const marketOverride = z.strictObject({
  marketId: z.string().trim().min(1).max(200).describe('Shopify Market id, e.g. "gid://shopify/Market/123" (see markets_list).'),
  thresholdCents: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("Custom threshold in this market, in stored units: x100 on two-decimal shops (50.00 -> 5000), the currency's own unit on zero-decimal shops. null/omitted = auto-convert the base threshold."),
  widgetTitle: z.string().trim().max(200).nullable().optional().describe("Market-specific widget title; null/omitted keeps the widget's own."),
  enabled: z.boolean().optional().describe("false hides the widget in this market. Default true."),
});
export const promoWidgetSetMarketOverridesInput = {
  ...refFields,
  overrides: z
    .array(marketOverride)
    .max(250)
    .describe("REPLACES the whole per-market override list of the offer's widget; [] clears it. At most one entry per marketId."),
  ...controls,
};
export const boostersListInput = { shops: z.array(z.string()).optional().describe("Shop domains, handles or ids; omitted = every visible shop.") };
export const boostersSetInput = {
  shop: z.string().max(200).describe("Shop domain or handle."),
  widgetId: z.string().uuid().describe("A booster widget id from boosters_list."),
  enabled: z.boolean().describe("true enables, false disables."),
  ...controls,
};

export const WIDGET_TOOL_DOCS = {
  list: `Lists the storefront widgets of one offer (type, copy, config, theme, placements, enabled) plus its per-market overrides. ${WIDGET_TYPE_DOCS} Example: {"ref":"promo:hpn:<offerId>"}.`,
  upsert: `Adds a widget (and its first placement, atomically) to an offer, validated like the admin widget editor; a live offer is republished (a failed publish keeps the saved widget but is reported as PUBLISH_FAILED). The editor has no edit-in-place: to change a widget delete it and add it again. ${WIDGET_TYPE_DOCS} Example: {"ref":"promo:hpn:<offerId>","widgetType":"gift_slider","title":"Pick your free gift","placementType":"cart_drawer","maxSelectable":2,"primaryColor":"#0a7d3b"}. Limit: shop Function config must stay under the Shopify metafield cap (CAPACITY blocks surface in the error).`,
  setEnabled: "Shows or hides one widget of an offer without deleting it; a live offer is republished. Example: {\"ref\":\"promo:hpn:<offerId>\",\"widgetId\":\"<uuid>\",\"enabled\":false}.",
  delete: "Deletes one widget (and its placements) from an offer; a live offer is republished. Example: {\"ref\":\"promo:hpn:<offerId>\",\"widgetId\":\"<uuid>\"}.",
  setMarketOverrides:
    'Replaces the per-market overrides of the offer\'s widget: a custom threshold, a market title or a hidden flag per Shopify Market (stored like the admin "Markets" page; read live by the storefront, no publish). Example: {"ref":"promo:hpn:<offerId>","overrides":[{"marketId":"gid://shopify/Market/123","thresholdCents":7500,"widgetTitle":"Free gift over 75 EUR"},{"marketId":"gid://shopify/Market/456","enabled":false}]}.',
  boostersList: "Boosters per shop: the offers of type booster and the booster widgets (today_offer_widget, today_offer_block, progress_bar) with their enabled state. Example: {\"shops\":[\"hpn\"]}.",
  boostersSet: `Enables or disables one booster widget (${BOOSTER_WIDGET_TYPES.join(", ")}); same as the Boosters page toggle, no publish. Example: {"shop":"hpn","widgetId":"<uuid>","enabled":true}.`,
} as const;

const safeText = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);

function widgetToolError(failure: WidgetFailure): ToolError {
  switch (failure.code) {
    case "not_found":
      return new ToolError("NOT_FOUND", safeText(failure.error));
    case "validation":
      return new ToolError("VALIDATION", safeText(failure.error));
    case "publish_failed":
      return new ToolError("PUBLISH_FAILED", `The widget change was saved but publishing to Shopify failed (${safeText(failure.error)}). The offer may have been paused so the shop stays consistent.`);
  }
}

function expectOk<T>(result: WidgetResult<T>): T {
  if (!result.ok) throw widgetToolError(result);
  return result.value;
}

const depsFor = (db: Db, shop: VisibleShop): AuthoringDeps => ({
  db,
  shopId: shop.id,
  shopDomain: shop.myshopifyDomain,
  shopCurrency: shop.currencyCode,
  timezone: shop.timezone,
});

type Built = { tool: string; shops: VisibleShop[]; preview: () => Promise<WritePreview>; apply: (apply: ApplyContext) => Promise<WriteBody> };

/** Resolves refs/shops (a failure is logged and returned as a tool error), then hands the spec to runWrite. */
async function widgetWrite(
  ctx: McpContext,
  call: CallInfo,
  tool: string,
  args: { dryRun?: boolean; idempotencyKey?: string } & Record<string, unknown>,
  build: (visible: VisibleShop[]) => Promise<Built>,
): Promise<CallToolResult> {
  const started = performance.now();
  let built: Built;
  try {
    built = await build(await visibleShops(ctx.db, ctx.operator));
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool, shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
  return runWrite(ctx, call, {
    tool: built.tool,
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: built.shops,
    preview: built.preview,
    apply: built.apply,
  });
}

const optionsOf = (a: ApplyContext): WriteServiceOptions => ({ performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish });
const previewOptions = (ctx: McpContext): WriteServiceOptions => ({ performedBy: `mcp:${ctx.operator.id}`, dryRun: true });

const offerLinks = (shop: VisibleShop) => [adminLink(shopHandle(shop.myshopifyDomain))];
const detailNext = (ref: string) => [{ mcp: "promo-engine" as const, tool: "promo_widgets_list", args: { ref }, why: "Verify the offer's widgets.", risk: "read" as const }];

type OfferArgs = { ref?: string; shop?: string };
type Controls = { dryRun?: boolean; idempotencyKey?: string };

export async function promoWidgetsList(ctx: McpContext, args: OfferArgs): Promise<ToolResult<unknown>> {
  const { shop, offerId } = resolvePromoRef(await visibleShops(ctx.db, ctx.operator), args);
  const deps = depsFor(ctx.db, shop);
  const [rows, marketOverrides] = await Promise.all([listOfferWidgets(deps, offerId), loadMarketOverrides(deps, offerId)]);
  const promoRef = promoRefOf(shop, offerId);
  return buildResult(
    {
      summary: `${rows.length} widget(s) on ${promoRef}; ${marketOverrides.length} market override(s).`,
      data: {
        promoRef,
        widgets: rows.map((w) => ({
          widgetId: w.id,
          type: w.type,
          internalName: w.internalName,
          title: w.title,
          subtitle: w.subtitle,
          isEnabled: w.isEnabled,
          config: w.config,
          theme: w.theme,
          placements: w.placements.map((p) => ({ placementId: p.id, placementType: p.placementType, selector: p.selector, pageRule: p.pageRule, isEnabled: p.isEnabled })),
        })),
        marketOverrides,
      },
      links: offerLinks(shop),
    },
    ctx.now,
  );
}

export function promoWidgetUpsert(ctx: McpContext, call: CallInfo, args: OfferArgs & Controls & Record<string, unknown> & { widgetType: string }): Promise<CallToolResult> {
  return widgetWrite(ctx, call, "promo_widget_upsert", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const promoRef = promoRefOf(shop, offerId);
    const deps = depsFor(ctx.db, shop);
    const input = {
      offerId,
      widgetType: args.widgetType,
      title: args.title as string | undefined,
      subtitle: args.subtitle as string | undefined,
      buttonText: args.buttonText as string | undefined,
      maxSelectable: args.maxSelectable as number | undefined,
      layout: args.layout as string | undefined,
      showPrice: args.showPrice as boolean | undefined,
      showOutOfStock: args.showOutOfStock as boolean | undefined,
      primaryColor: args.primaryColor as string | undefined,
      buttonColor: args.buttonColor as string | undefined,
      textColor: args.textColor as string | undefined,
      backgroundColor: args.backgroundColor as string | undefined,
      placementType: args.placementType as string | undefined,
      cssSelector: args.cssSelector as string | undefined,
      pageType: args.pageType as string | undefined,
      urlPattern: args.urlPattern as string | undefined,
    };
    return {
      tool: "promo_widget_upsert",
      shops: [shop],
      preview: async () => {
        const v = expectOk(await addOfferWidget(deps, input, previewOptions(ctx)));
        return {
          summary: `Add a ${v.type} widget to ${promoRef}${v.placementType ? ` placed in ${v.placementType}` : " without a placement"}; the offer is ${v.offerStatus}${v.offerStatus === "active" ? " and will be republished" : ""}.`,
          data: { promoRef, ...v },
          links: offerLinks(shop),
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const v = expectOk(await addOfferWidget(deps, input, optionsOf(a)));
        return {
          summary: `Added a ${v.type} widget to ${promoRef}.`,
          data: { promoRef, ...v },
          links: offerLinks(shop),
          nextActions: detailNext(promoRef),
        };
      },
    };
  });
}

export function promoWidgetSetEnabled(ctx: McpContext, call: CallInfo, args: OfferArgs & Controls & { widgetId: string; enabled: boolean }): Promise<CallToolResult> {
  return widgetWrite(ctx, call, "promo_widget_set_enabled", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const promoRef = promoRefOf(shop, offerId);
    const deps = depsFor(ctx.db, shop);
    const input = { offerId, widgetId: args.widgetId, enabled: args.enabled };
    return {
      tool: "promo_widget_set_enabled",
      shops: [shop],
      preview: async () => {
        const v = expectOk(await setOfferWidgetEnabled(deps, input, previewOptions(ctx)));
        return { summary: `Widget ${v.widgetId} (${v.type}) of ${promoRef}: enabled ${v.enabledBefore} -> ${v.enabled}.`, data: { promoRef, ...v }, links: offerLinks(shop), offerUpdatedAt: null };
      },
      apply: async (a) => {
        const v = expectOk(await setOfferWidgetEnabled(deps, input, optionsOf(a)));
        return { summary: `Widget ${v.widgetId} of ${promoRef} is now ${v.enabled ? "enabled" : "disabled"}.`, data: { promoRef, ...v }, links: offerLinks(shop), nextActions: detailNext(promoRef) };
      },
    };
  });
}

export function promoWidgetDelete(ctx: McpContext, call: CallInfo, args: OfferArgs & Controls & { widgetId: string }): Promise<CallToolResult> {
  return widgetWrite(ctx, call, "promo_widget_delete", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const promoRef = promoRefOf(shop, offerId);
    const deps = depsFor(ctx.db, shop);
    const input = { offerId, widgetId: args.widgetId };
    return {
      tool: "promo_widget_delete",
      shops: [shop],
      preview: async () => {
        const v = expectOk(await deleteOfferWidget(deps, input, previewOptions(ctx)));
        return { summary: `Delete widget ${v.widgetId} (${v.type}) from ${promoRef}.`, data: { promoRef, ...v }, links: offerLinks(shop), offerUpdatedAt: null };
      },
      apply: async (a) => {
        const v = expectOk(await deleteOfferWidget(deps, input, optionsOf(a)));
        return { summary: `Deleted widget ${v.widgetId} (${v.type}) from ${promoRef}.`, data: { promoRef, ...v }, links: offerLinks(shop), nextActions: detailNext(promoRef) };
      },
    };
  });
}

export function promoWidgetSetMarketOverrides(
  ctx: McpContext,
  call: CallInfo,
  args: OfferArgs & Controls & { overrides: { marketId: string; thresholdCents?: number | null; widgetTitle?: string | null; enabled?: boolean }[] },
): Promise<CallToolResult> {
  return widgetWrite(ctx, call, "promo_widget_set_market_overrides", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const promoRef = promoRefOf(shop, offerId);
    const deps = depsFor(ctx.db, shop);
    const ids = args.overrides.map((o) => o.marketId);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new ToolError("VALIDATION", `marketId ${duplicate} appears more than once; send one override per market.`);
    const input = { offerId, overrides: args.overrides as unknown[] };
    return {
      tool: "promo_widget_set_market_overrides",
      shops: [shop],
      preview: async () => {
        const v = expectOk(await setMarketOverrides(deps, input, previewOptions(ctx)));
        return { summary: `Replace the market overrides of ${promoRef} with ${v.savedCount} entr${v.savedCount === 1 ? "y" : "ies"}.`, data: { promoRef, ...v }, links: offerLinks(shop), offerUpdatedAt: null };
      },
      apply: async (a) => {
        const v = expectOk(await setMarketOverrides(deps, input, optionsOf(a)));
        return { summary: `Saved ${v.savedCount} market override(s) for ${promoRef}.`, data: { promoRef, ...v }, links: offerLinks(shop), nextActions: detailNext(promoRef) };
      },
    };
  });
}

export async function boostersList(ctx: McpContext, args: { shops?: string[] }): Promise<ToolResult<unknown>> {
  const selected = selectShops(await visibleShops(ctx.db, ctx.operator), args.shops);
  const perShop = await Promise.all(
    selected.map(async (shop) => {
      const deps = depsFor(ctx.db, shop);
      const [offers, widgets] = await Promise.all([listBoosterOffers(deps), listBoosterWidgets(deps)]);
      return {
        shop: shop.myshopifyDomain,
        offers: offers.map((o) => ({ promoRef: promoRefOf(shop, o.id), offerId: o.id, name: o.internalName, publicTitle: o.publicTitle, status: o.status, priority: o.priority, updatedAt: o.updatedAt.toISOString() })),
        widgets: widgets.map((w) => ({ widgetId: w.id, type: w.type, name: w.internalName, isEnabled: w.isEnabled, offerId: w.offerId })),
      };
    }),
  );
  const total = perShop.reduce((n, s) => n + s.widgets.length, 0);
  return buildResult({ summary: `${total} booster widget(s) across ${perShop.length} shop(s).`, data: { shops: perShop } }, ctx.now);
}

export function boostersSet(ctx: McpContext, call: CallInfo, args: Controls & { shop: string; widgetId: string; enabled: boolean }): Promise<CallToolResult> {
  return widgetWrite(ctx, call, "boosters_set", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const deps = depsFor(ctx.db, shop!);
    const input = { widgetId: args.widgetId, enabled: args.enabled, boosterTypesOnly: true };
    return {
      tool: "boosters_set",
      shops: [shop!],
      preview: async () => {
        const v = expectOk(await setBoosterWidgetEnabled(deps, input, previewOptions(ctx)));
        return { summary: `Booster ${v.widgetId} (${v.type}): enabled ${v.enabledBefore} -> ${v.enabled}.`, data: v, links: offerLinks(shop!), offerUpdatedAt: null };
      },
      apply: async (a) => {
        const v = expectOk(await setBoosterWidgetEnabled(deps, input, optionsOf(a)));
        return {
          summary: `Booster ${v.widgetId} (${v.type}) is now ${v.enabled ? "enabled" : "disabled"}.`,
          data: v,
          links: offerLinks(shop!),
          nextActions: [{ mcp: "promo-engine", tool: "boosters_list", args: { shops: [shop!.myshopifyDomain] }, why: "Verify the boosters.", risk: "read" }],
        };
      },
    };
  });
}

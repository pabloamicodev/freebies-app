/**
 * Typed services behind the widget editor (`app.offers.$id.widget`), the per-market widget overrides
 * (`app.offers.$id.widget.market`) and the Boosters page (`app.boosters`). The admin routes are FormData adapters and the
 * MCP widget tools are zod adapters; both call these functions, so validation, publish and audit are one path.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { appSettings, offers, widgetPlacements, widgets, type Widget, type WidgetPlacement } from "@promo/db";
import { insertAuditLog } from "./audit-log.server.js";
import { republishIfActive, tryPublishShop } from "./offer-publish-flow.server.js";
import type { AuthoringDeps, WriteServiceOptions } from "./offer-authoring/types.js";

export const WIDGET_TYPES = [
  "gift_slider",
  "gift_popup",
  "cart_message",
  "today_offer_widget",
  "today_offer_block",
  "progress_bar",
  "gift_icon",
  "gift_thumbnail",
  "classic_bundle",
  "mix_match_bundle",
  "bundle_page",
  "checkout_upsell",
  "fbt",
  "thank_you_upsell",
  "volume_discount",
] as const;
export type OfferWidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_PLACEMENT_TYPES = ["cart_drawer", "cart_page", "product_page", "global", "product_page_inline", "checkout"] as const;

/** The widget types the Boosters page lists and toggles. */
export const BOOSTER_WIDGET_TYPES = ["today_offer_widget", "today_offer_block", "progress_bar"] as const;

export type WidgetFailure = {
  ok: false;
  code: "not_found" | "validation" | "publish_failed";
  error: string;
  /** publish_failed only: the widget change itself is saved. */
  saved?: boolean;
};
export type WidgetResult<T> = { ok: true; value: T } | WidgetFailure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidHex = (c: string) => /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c);
const fail = (code: WidgetFailure["code"], error: string): WidgetFailure => ({ ok: false, code, error });

export type AddWidgetInput = {
  offerId: string;
  widgetType: string;
  title?: string | null;
  subtitle?: string | null;
  /** Default #111111. */
  primaryColor?: string | null;
  /** Default: primaryColor. */
  buttonColor?: string | null;
  /** Default #ffffff. */
  textColor?: string | null;
  /** Default #ffffff. */
  backgroundColor?: string | null;
  /** Default "Add to Cart". */
  buttonText?: string | null;
  /** Default 1. */
  maxSelectable?: number | null;
  /** Default "popup". */
  layout?: string | null;
  showPrice?: boolean;
  showOutOfStock?: boolean;
  /** Empty/omitted: the widget is created without a placement (the UI always sends one). */
  placementType?: string | null;
  cssSelector?: string | null;
  /** Default "all". */
  pageType?: string | null;
  urlPattern?: string | null;
};

export type AddWidgetValue = {
  widgetId: string | null;
  type: OfferWidgetType;
  internalName: string;
  placementType: string | null;
  offerStatus: string;
};

async function loadOffer(deps: AuthoringDeps, offerId: string) {
  if (!UUID.test(offerId)) return null;
  const [offer] = await deps.db
    .select({ id: offers.id, status: offers.status, internalName: offers.internalName })
    .from(offers)
    .where(and(eq(offers.shopId, deps.shopId), eq(offers.id, offerId)))
    .limit(1);
  return offer ?? null;
}

async function audit(deps: AuthoringDeps, opts: WriteServiceOptions, entityId: string, action: string, after: Record<string, unknown>, before?: Record<string, unknown>) {
  await insertAuditLog(deps.db, {
    shopId: deps.shopId,
    entityType: "widget",
    entityId,
    action,
    before,
    after: { ...after, ...opts.auditExtra },
    performedBy: opts.performedBy,
  });
}

async function republish(deps: AuthoringDeps, opts: WriteServiceOptions, offer: { id: string; status: string }): Promise<WidgetFailure | null> {
  const error = await republishIfActive(deps.db, deps.shopId, deps.shopDomain, offer.id, offer.status === "active", opts.publish ?? tryPublishShop);
  return error ? { ok: false, code: "publish_failed", error, saved: true } : null;
}

/** `add_widget`: the widget and its first placement are written atomically, then a live offer is republished. */
export async function addOfferWidget(deps: AuthoringDeps, input: AddWidgetInput, opts: WriteServiceOptions): Promise<WidgetResult<AddWidgetValue>> {
  const offer = await loadOffer(deps, input.offerId);
  if (!offer) return fail("not_found", "Offer not found in that shop.");

  if (!(WIDGET_TYPES as readonly string[]).includes(input.widgetType)) return fail("validation", `Invalid widget type: ${input.widgetType}`);
  const placementType = input.placementType || null;
  if (placementType && !(WIDGET_PLACEMENT_TYPES as readonly string[]).includes(placementType)) return fail("validation", `Invalid placement type: ${placementType}`);

  const primaryColor = input.primaryColor || "#111111";
  const buttonColor = input.buttonColor || primaryColor;
  const textColor = input.textColor || "#ffffff";
  const backgroundColor = input.backgroundColor || "#ffffff";
  for (const [field, val] of [["primaryColor", primaryColor], ["buttonColor", buttonColor], ["textColor", textColor], ["backgroundColor", backgroundColor]] as const) {
    if (val && !isValidHex(val)) return fail("validation", `${field} must be a valid hex color (e.g. #ff0000).`);
  }

  const type = input.widgetType as OfferWidgetType;
  const internalName = `${type}-${offer.id.slice(0, 8)}`;
  if (opts.dryRun) return { ok: true, value: { widgetId: null, type, internalName, placementType, offerStatus: offer.status } };

  // Widget + its first placement must be atomic: an orphaned widget with no placement would be invisible in the
  // storefront but still appear in the list.
  const widgetId = await deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(widgets)
      .values({
        shopId: deps.shopId,
        offerId: offer.id,
        type,
        internalName,
        title: input.title || null,
        subtitle: input.subtitle || null,
        config: {
          buttonText: input.buttonText || "Add to Cart",
          maxSelectableCount: input.maxSelectable || 1,
          layout: input.layout || "popup",
          showPrice: input.showPrice === true,
          showOutOfStock: input.showOutOfStock === true,
        },
        theme: { primaryColor, buttonColor, textColor, backgroundColor },
        isEnabled: true,
      })
      .returning({ id: widgets.id });

    if (created && placementType) {
      await tx.insert(widgetPlacements).values({
        shopId: deps.shopId,
        widgetId: created.id,
        placementType,
        selector: input.cssSelector || null,
        pageRule: { pageType: input.pageType || "all", urlPattern: input.urlPattern || undefined },
        sortOrder: 0,
        isEnabled: true,
      });
    }
    return created?.id ?? null;
  });

  if (widgetId) await audit(deps, opts, widgetId, "widget_add", { offerId: offer.id, type, placementType });
  const failure = await republish(deps, opts, offer);
  if (failure) return failure;
  return { ok: true, value: { widgetId, type, internalName, placementType, offerStatus: offer.status } };
}

export type SetWidgetEnabledValue = { widgetId: string; type: string; enabledBefore: boolean; enabled: boolean };

/** `toggle_widget`: sets the widget's enabled flag, then republishes a live offer. */
export async function setOfferWidgetEnabled(
  deps: AuthoringDeps,
  input: { offerId: string; widgetId: string; enabled: boolean },
  opts: WriteServiceOptions,
): Promise<WidgetResult<SetWidgetEnabledValue>> {
  const offer = await loadOffer(deps, input.offerId);
  if (!offer) return fail("not_found", "Offer not found in that shop.");
  const widget = await findOfferWidget(deps, offer.id, input.widgetId);
  if (!widget) return fail("not_found", "Widget not found on that offer.");
  const value = { widgetId: widget.id, type: widget.type, enabledBefore: widget.isEnabled, enabled: input.enabled };
  if (opts.dryRun) return { ok: true, value };

  await deps.db
    .update(widgets)
    .set({ isEnabled: input.enabled })
    .where(and(eq(widgets.shopId, deps.shopId), eq(widgets.offerId, offer.id), eq(widgets.id, widget.id)));
  await audit(deps, opts, widget.id, "widget_toggle", { offerId: offer.id, enabled: input.enabled }, { enabled: widget.isEnabled });
  const failure = await republish(deps, opts, offer);
  return failure ?? { ok: true, value };
}

/** `delete_widget`: removes the widget (its placements cascade), then republishes a live offer. */
export async function deleteOfferWidget(
  deps: AuthoringDeps,
  input: { offerId: string; widgetId: string },
  opts: WriteServiceOptions,
): Promise<WidgetResult<{ widgetId: string; type: string }>> {
  if (!input.widgetId) return fail("validation", "Widget ID missing.");
  const offer = await loadOffer(deps, input.offerId);
  if (!offer) return fail("not_found", "Offer not found in that shop.");
  const widget = await findOfferWidget(deps, offer.id, input.widgetId);
  if (!widget) return fail("not_found", "Widget not found on that offer.");
  const value = { widgetId: widget.id, type: widget.type };
  if (opts.dryRun) return { ok: true, value };

  await deps.db.delete(widgets).where(and(eq(widgets.shopId, deps.shopId), eq(widgets.offerId, offer.id), eq(widgets.id, widget.id)));
  await audit(deps, opts, widget.id, "widget_delete", { offerId: offer.id }, { type: widget.type, title: widget.title });
  const failure = await republish(deps, opts, offer);
  return failure ?? { ok: true, value };
}

async function findOfferWidget(deps: AuthoringDeps, offerId: string, widgetId: string): Promise<Widget | null> {
  if (!UUID.test(widgetId)) return null;
  const [row] = await deps.db
    .select()
    .from(widgets)
    .where(and(eq(widgets.shopId, deps.shopId), eq(widgets.offerId, offerId), eq(widgets.id, widgetId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-market overrides
// ---------------------------------------------------------------------------------------------------------------------

export type StoredMarketOverride = {
  marketId: string;
  thresholdCents: number | null;
  widgetTitle: string | null;
  enabled: boolean;
};

export const marketOverridesKey = (offerId: string) => `widget.market_overrides.${offerId}`;

export function normalizeMarketOverrides(items: unknown[]): StoredMarketOverride[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const override = item as { marketId?: unknown; thresholdCents?: unknown; widgetTitle?: unknown; enabled?: unknown };
    if (typeof override.marketId !== "string") return [];
    const thresholdCents =
      typeof override.thresholdCents === "number" && Number.isFinite(override.thresholdCents) ? override.thresholdCents : null;
    const widgetTitle = typeof override.widgetTitle === "string" && override.widgetTitle.trim() ? override.widgetTitle.trim() : null;
    const enabled = typeof override.enabled === "boolean" ? override.enabled : true;
    return [{ marketId: override.marketId, thresholdCents, widgetTitle, enabled }];
  });
}

/** Stored overrides of an offer, or [] when none are saved or the saved JSON is not an array. */
export async function loadMarketOverrides(deps: Pick<AuthoringDeps, "db" | "shopId">, offerId: string): Promise<StoredMarketOverride[]> {
  const [row] = await deps.db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, deps.shopId), eq(appSettings.key, marketOverridesKey(offerId))))
    .limit(1);
  try {
    const parsed = JSON.parse(row?.value || "[]") as unknown;
    return Array.isArray(parsed) ? normalizeMarketOverrides(parsed) : [];
  } catch {
    return [];
  }
}

/** `app.offers.$id.widget.market` save: replaces the offer's whole override list (no publish: the storefront reads it live). */
export async function setMarketOverrides(
  deps: AuthoringDeps,
  input: { offerId: string; overrides: unknown[] },
  opts: WriteServiceOptions,
): Promise<WidgetResult<{ overrides: StoredMarketOverride[]; savedCount: number }>> {
  const offer = await loadOffer(deps, input.offerId);
  if (!offer) return fail("not_found", "Offer not found in that shop.");
  const overrides = normalizeMarketOverrides(input.overrides);
  const value = { overrides, savedCount: overrides.length };
  if (opts.dryRun) return { ok: true, value };

  const json = JSON.stringify(overrides);
  await deps.db
    .insert(appSettings)
    .values({ shopId: deps.shopId, key: marketOverridesKey(offer.id), value: json })
    .onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value: json, updatedAt: new Date() } });
  await audit(deps, opts, offer.id, "widget_market_overrides_set", { offerId: offer.id, count: overrides.length });
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------

export type OfferWidgetRow = Widget & { placements: WidgetPlacement[] };

export async function listOfferWidgets(deps: Pick<AuthoringDeps, "db" | "shopId">, offerId: string): Promise<OfferWidgetRow[]> {
  const rows = await deps.db
    .select()
    .from(widgets)
    .where(and(eq(widgets.shopId, deps.shopId), eq(widgets.offerId, offerId)))
    .orderBy(asc(widgets.createdAt));
  if (rows.length === 0) return [];
  const placements = await deps.db
    .select()
    .from(widgetPlacements)
    .where(and(eq(widgetPlacements.shopId, deps.shopId), inArray(widgetPlacements.widgetId, rows.map((w) => w.id))))
    .orderBy(asc(widgetPlacements.sortOrder));
  return rows.map((w) => ({ ...w, placements: placements.filter((p) => p.widgetId === w.id) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Boosters
// ---------------------------------------------------------------------------------------------------------------------

export type BoosterRow = { id: string; type: string; internalName: string; isEnabled: boolean; offerId: string | null };

/** Booster-type widgets of the shop (the Boosters page list). */
export async function listBoosterWidgets(deps: Pick<AuthoringDeps, "db" | "shopId">): Promise<BoosterRow[]> {
  const rows = await deps.db.select().from(widgets).where(eq(widgets.shopId, deps.shopId));
  return rows.flatMap((w) =>
    (BOOSTER_WIDGET_TYPES as readonly string[]).includes(w.type)
      ? [{ id: w.id, type: w.type, internalName: w.internalName, isEnabled: w.isEnabled, offerId: w.offerId }]
      : [],
  );
}

/**
 * Boosters page `toggle_widget`. Like the page it does not republish. `boosterTypesOnly` (MCP) refuses widgets the page
 * does not list; the admin route keeps its historical any-widget-of-the-shop behaviour.
 */
export async function setBoosterWidgetEnabled(
  deps: AuthoringDeps,
  input: { widgetId: string; enabled: boolean; boosterTypesOnly?: boolean },
  opts: WriteServiceOptions,
): Promise<WidgetResult<SetWidgetEnabledValue>> {
  if (!UUID.test(input.widgetId)) return fail("not_found", "Widget not found in that shop.");
  const [widget] = await deps.db
    .select()
    .from(widgets)
    .where(and(eq(widgets.shopId, deps.shopId), eq(widgets.id, input.widgetId)))
    .limit(1);
  if (!widget) return fail("not_found", "Widget not found in that shop.");
  if (input.boosterTypesOnly && !(BOOSTER_WIDGET_TYPES as readonly string[]).includes(widget.type)) {
    return fail("validation", `Widget type ${widget.type} is not a booster (${BOOSTER_WIDGET_TYPES.join(", ")}); use promo_widget_set_enabled.`);
  }
  const value = { widgetId: widget.id, type: widget.type, enabledBefore: widget.isEnabled, enabled: input.enabled };
  if (opts.dryRun) return { ok: true, value };

  await deps.db
    .update(widgets)
    .set({ isEnabled: input.enabled, updatedAt: new Date() })
    .where(and(eq(widgets.shopId, deps.shopId), eq(widgets.id, widget.id)));
  await audit(deps, opts, widget.id, "booster_toggle", { enabled: input.enabled }, { enabled: widget.isEnabled });
  return { ok: true, value };
}

export type BoosterOfferRow = { id: string; internalName: string; publicTitle: string | null; status: string; priority: number; updatedAt: Date };

/** Offers of type booster, by priority (the Boosters page list). */
export async function listBoosterOffers(deps: Pick<AuthoringDeps, "db" | "shopId">): Promise<BoosterOfferRow[]> {
  const rows = await deps.db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, deps.shopId), eq(offers.type, "booster")))
    .orderBy(offers.priority);
  return rows.map((o) => ({ id: o.id, internalName: o.internalName, publicTitle: o.publicTitle, status: o.status, priority: o.priority, updatedAt: o.updatedAt }));
}

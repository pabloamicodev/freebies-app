import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SUPPORTED_LOCALES } from "@promo/shared-types";
import { CUSTOMIZE_DEFAULTS, getCustomizeSettings, setCustomizeSettings } from "../../customize-settings.server.js";
import { getMulticurrency, setMulticurrency, type MulticurrencyFailure } from "../../offer-multicurrency.server.js";
import { getTranslations, setTranslations } from "../../translations.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, buildResult, promoRef, shopHandle, type ToolResult } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";

const writeControls = {
  dryRun: z.boolean().optional().describe("Default false. true previews the outcome (validation included) without writing anything."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
const shopField = z.string().max(200).describe("Shop domain or handle (see shops_list).");
const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};
const locale = z.enum(SUPPORTED_LOCALES);
const MODE = z.enum(["patch", "replace"]);

export const translationsGetInput = {
  shop: shopField,
  locale: locale.optional().describe(`Locale to read; default "en". One of ${SUPPORTED_LOCALES.join(", ")}.`),
};
export const translationsSetInput = {
  shop: shopField,
  locale: locale.describe("Locale to write."),
  strings: z
    .record(z.string().max(60), z.string().max(2000).nullable())
    .describe(
      'Storefront widget strings, key -> text, e.g. {"progress.before_goal":"Gasta {{remaining_amount}} mas para un regalo"}. Keys: see translations_get (progress.before_goal, progress.after_goal, progress.gift_tier_before_goal, progress.gift_tier_after_goal, gift_slider.*, today_offer.*, volume_discount.title, fbt.*, upsell.no_thanks). null or "" removes the key (the widget falls back to English). Max 300 chars per string. Placeholders are {{name}} with no spaces and only the variables listed per key; anything else is rejected.',
    ),
  mode: MODE.optional().describe("patch (default): merge into the stored strings of that locale. replace: the locale's strings become exactly `strings`."),
  ...writeControls,
};

const themeKeys = Object.keys(CUSTOMIZE_DEFAULTS) as Array<keyof typeof CUSTOMIZE_DEFAULTS>;
const themeShape = Object.fromEntries(themeKeys.map((k) => [k, z.string().max(300).optional()])) as Record<(typeof themeKeys)[number], z.ZodOptional<z.ZodString>>;
export const customizeGetInput = { shop: shopField };
export const customizeSetInput = {
  shop: shopField,
  values: z
    .strictObject(themeShape)
    .describe(
      `Global widget theme and default copy. Known keys (defaults): ${themeKeys.map((k) => `${k}="${CUSTOMIZE_DEFAULTS[k]}"`).join(", ")}. Colors are CSS values (#111111), borderRadius is pixels as text.`,
    ),
  mode: MODE.optional().describe("patch (default): merge over the stored theme. replace: the stored theme becomes exactly `values` (omitted keys fall back to the defaults)."),
  ...writeControls,
};

export const multicurrencyGetInput = { ...refFields };
const money = z.number().finite().min(0).max(100_000_000);
export const setMulticurrencyInput = {
  ...refFields,
  overrides: z
    .array(
      z.strictObject({
        currency: z.string().trim().length(3).describe("ISO 4217 code of the market currency, e.g. EUR, JPY."),
        threshold: money.nullable().optional().describe("Cart value threshold in this currency, in MAJOR units (5000 JPY = 5000, 25.50 EUR = 25.5). null or 0 removes it; omitted keeps it (patch mode)."),
        max: money.nullable().optional().describe("Cart value maximum (only for offers whose base condition has a maximum); must be >= threshold."),
        fixed: money.nullable().optional().describe("Fixed discount amount in this currency, in major units."),
      }),
    )
    .min(1)
    .max(60)
    .describe(
      'Per-currency overrides on the offer\'s Cart Value condition, e.g. [{"currency":"EUR","threshold":25,"fixed":5},{"currency":"JPY","threshold":3000}]. Amounts are major units: send 3000 for 3000 yen, never x100. Storage matches the admin page: a zero-decimal shop (JPY, KRW, ...) stores whole units; every other shop stores x100 for all of its markets, JPY market included, because the Functions read overrides that way. The offer needs a Cart Value condition.',
    ),
  mode: MODE.optional().describe("patch (default): merge per currency over the stored overrides. replace: the stored overrides become exactly `overrides`."),
  ...writeControls,
};

type Controls = { dryRun?: boolean; idempotencyKey?: string };

function failure(f: MulticurrencyFailure, offerRef: string): ToolError {
  const text = f.error.replace(/\s+/g, " ").slice(0, 300);
  switch (f.code) {
    case "not_found":
      return new ToolError("NOT_FOUND", "Offer not found in that shop.");
    case "validation":
      return new ToolError("VALIDATION", text);
    case "state":
      return new ToolError("STATE_CONFLICT", text);
    case "publish_failed":
      return new ToolError("PUBLISH_FAILED", `The overrides were saved but publishing to Shopify failed (${text}).`, {
        suggestedAction: { mcp: "promo-engine", tool: "promo_detail", args: { ref: offerRef }, why: "Check the offer's status and publish errors, then retry." },
      });
  }
}

type Built = { shops: VisibleShop[]; preview: () => Promise<WritePreview>; apply: (a: ApplyContext) => Promise<WriteBody> };

/** Resolves refs/shops (a failure is logged and returned as a tool error), then hands the spec to runWrite. */
async function write(
  ctx: McpContext,
  call: CallInfo,
  tool: string,
  args: Controls & Record<string, unknown>,
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
    tool,
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: built.shops,
    preview: built.preview,
    apply: built.apply,
  });
}

async function read(ctx: McpContext, fn: (visible: VisibleShop[]) => Promise<ToolResult<unknown>>): Promise<ToolResult<unknown>> {
  return fn(await visibleShops(ctx.db, ctx.operator));
}

// ---- translations ----

export async function translationsGetTool(ctx: McpContext, args: { shop: string; locale?: string }): Promise<ToolResult<unknown>> {
  return read(ctx, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const loc = args.locale ?? "en";
    const data = await getTranslations(ctx.db, shop!.id, loc);
    const set = data.keys.filter((k) => k.value !== null).length;
    return buildResult(
      {
        summary: `${shopHandle(shop!.myshopifyDomain)} translations for "${loc}": ${set} of ${data.keys.length} widget strings customized (the rest use the English defaults).`,
        data,
        links: [adminLink(shopHandle(shop!.myshopifyDomain))],
        nextActions: [{ mcp: "promo-engine", tool: "translations_set", args: { shop: shop!.myshopifyDomain, locale: loc, strings: {} }, why: "Change one or more strings.", risk: "write" }],
      },
      ctx.now,
    );
  });
}

export function translationsSetTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { shop: string; locale: string; strings: Record<string, string | null>; mode?: "patch" | "replace" },
): Promise<CallToolResult> {
  return write(ctx, call, "translations_set", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const input = { locale: args.locale, strings: args.strings, mode: args.mode ?? "patch" };
    const run = async (opts: { dryRun?: boolean; performedBy?: string; auditExtra?: Record<string, unknown> }) => {
      const result = await setTranslations({ db: ctx.db, shopId: shop!.id }, input, opts);
      if (!result.ok) throw new ToolError("VALIDATION", result.error.slice(0, 300));
      return result.value;
    };
    const links = [adminLink(shopHandle(shop!.myshopifyDomain))];
    return {
      shops: [shop!],
      preview: async () => {
        const v = await run({ dryRun: true });
        return {
          summary: `Set ${v.changedKeys.length} widget string(s) for "${v.locale}" on ${shop!.myshopifyDomain}.`,
          data: { shopDomain: shop!.myshopifyDomain, locale: v.locale, changedKeys: v.changedKeys, resulting: v.strings },
          links,
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const v = await run({ performedBy: a.performedBy, auditExtra: a.auditExtra });
        return {
          summary: `Saved ${v.changedKeys.length} changed widget string(s) for "${v.locale}" on ${shop!.myshopifyDomain}.`,
          data: { shopDomain: shop!.myshopifyDomain, locale: v.locale, changedKeys: v.changedKeys, strings: v.strings },
          links,
          nextActions: [{ mcp: "promo-engine", tool: "translations_get", args: { shop: shop!.myshopifyDomain, locale: v.locale }, why: "Verify.", risk: "read" }],
        };
      },
    };
  });
}

// ---- customize ----

export async function customizeGetTool(ctx: McpContext, args: { shop: string }): Promise<ToolResult<unknown>> {
  return read(ctx, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const { theme, stored } = await getCustomizeSettings(ctx.db, shop!.id);
    return buildResult(
      {
        summary: `${shopHandle(shop!.myshopifyDomain)} widget theme: ${Object.keys(stored).length} setting(s) customized, the rest use the defaults.`,
        data: { shopDomain: shop!.myshopifyDomain, theme, customizedKeys: Object.keys(stored), defaults: CUSTOMIZE_DEFAULTS },
        links: [adminLink(shopHandle(shop!.myshopifyDomain))],
      },
      ctx.now,
    );
  });
}

export function customizeSetTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { shop: string; values: Record<string, string | undefined>; mode?: "patch" | "replace" },
): Promise<CallToolResult> {
  return write(ctx, call, "customize_set", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const values = Object.fromEntries(Object.entries(args.values).filter((e): e is [string, string] => typeof e[1] === "string"));
    const input = { values, mode: args.mode ?? "patch" } as const;
    const links = [adminLink(shopHandle(shop!.myshopifyDomain))];
    return {
      shops: [shop!],
      preview: async () => {
        const r = await setCustomizeSettings({ db: ctx.db, shopId: shop!.id }, input, { dryRun: true });
        if (!r.ok) throw new ToolError("VALIDATION", r.error);
        return { summary: `Change ${r.value.changedKeys.length} widget theme setting(s) on ${shop!.myshopifyDomain}.`, data: { shopDomain: shop!.myshopifyDomain, changedKeys: r.value.changedKeys, resulting: r.value.theme }, links, offerUpdatedAt: null };
      },
      apply: async (a) => {
        const r = await setCustomizeSettings({ db: ctx.db, shopId: shop!.id }, input, { performedBy: a.performedBy, auditExtra: a.auditExtra });
        if (!r.ok) throw new ToolError("VALIDATION", r.error);
        return {
          summary: `Saved the widget theme of ${shop!.myshopifyDomain} (${r.value.changedKeys.length} setting(s) changed). Storefront widgets pick it up on the next page load.`,
          data: { shopDomain: shop!.myshopifyDomain, changedKeys: r.value.changedKeys, theme: r.value.theme },
          links,
          nextActions: [{ mcp: "promo-engine", tool: "customize_get", args: { shop: shop!.myshopifyDomain }, why: "Verify.", risk: "read" }],
        };
      },
    };
  });
}

// ---- multicurrency ----

export async function multicurrencyGetTool(ctx: McpContext, args: { ref?: string; shop?: string }): Promise<ToolResult<unknown>> {
  return read(ctx, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const r = await getMulticurrency({ db: ctx.db, shopId: shop.id, shopCurrency: shop.currencyCode }, offerId);
    if (!r.ok) throw failure(r, promoRef(shop.myshopifyDomain, offerId));
    const offerRef = promoRef(shop.myshopifyDomain, offerId);
    return buildResult(
      {
        summary: r.value
          ? `${offerRef}: ${Object.keys(r.value.major).length} currency override(s) on the Cart Value condition (base ${r.value.baseCurrency}). Shop currency ${shop.currencyCode}.`
          : `${offerRef} has no Cart Value condition, so multicurrency overrides cannot be set yet.`,
        data: { promoRef: offerRef, shopCurrency: shop.currencyCode, hasCartValueCondition: r.value !== null, ...(r.value ?? {}) },
        links: [adminLink(shopHandle(shop.myshopifyDomain))],
      },
      ctx.now,
    );
  });
}

export function setMulticurrencyTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { ref?: string; shop?: string; overrides: Array<{ currency: string; threshold?: number | null; max?: number | null; fixed?: number | null }>; mode?: "patch" | "replace" },
): Promise<CallToolResult> {
  return write(ctx, call, "promo_set_multicurrency", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const offerRef = promoRef(shop.myshopifyDomain, offerId);
    const input = { overrides: args.overrides, mode: args.mode ?? "patch" } as const;
    const base = { db: ctx.db, shopId: shop.id, shopDomain: shop.myshopifyDomain, shopCurrency: shop.currencyCode, timezone: shop.timezone };
    const links = [adminLink(shopHandle(shop.myshopifyDomain))];
    return {
      shops: [shop],
      preview: async () => {
        const r = await setMulticurrency(base, offerId, input, { dryRun: true });
        if (!r.ok) throw failure(r, offerRef);
        const live = r.value.offerStatus === "active";
        return {
          summary: `Set currency overrides on ${offerRef}: thresholds ${JSON.stringify(r.value.currencyOverrides)}, maximums ${JSON.stringify(r.value.maxCurrencyOverrides)}, fixed ${JSON.stringify(r.value.fixedAmountOverrides)} (stored units). ${live ? "The offer is active: the shop config is republished." : "The offer is not active: nothing is published until it is."}`,
          data: { promoRef: offerRef, ...r.value, willPublish: live },
          links,
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const r = await setMulticurrency(base, offerId, input, {
          performedBy: a.performedBy,
          auditExtra: a.auditExtra,
          publish: a.publish,
          expectedUpdatedAt: a.expectedUpdatedAt ?? undefined,
        });
        if (!r.ok) throw failure(r, offerRef);
        return {
          summary: `Saved currency overrides on ${offerRef}.${r.value.republished ? " Shopify config republished." : ""}`,
          data: { promoRef: offerRef, ...r.value },
          links,
          nextActions: [{ mcp: "promo-engine", tool: "promo_multicurrency_get", args: { ref: offerRef }, why: "Verify.", risk: "read" }],
        };
      },
    };
  });
}

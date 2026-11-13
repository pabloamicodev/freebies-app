/**
 * Authoring input for discount codes: a typed code or a generated batch, the discount message and the redemption mode.
 * `AuthoringCodesSchema` + `createCodesForOffer` serve promo_create (requiresCode offers, like the discount wizard's
 * initial code); `AuthoringCodeOfferSchema` + `toCodeOfferDraft` serve promo_create_code_offer (the Discount Codes wizard).
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { offers, type Db } from "@promo/db";
import { PAGE_TYPES, type PageType } from "@promo/shared-types";
import { buildCodeOfferDraft, type CodeOfferDraft } from "../code-offer-wizard.server.js";
import { createDiscountCode, createDiscountCodeBatch, validateBatchEntropy, type CodeSettings } from "../discount-codes.server.js";
import { CODE_CHARSETS, MAX_BATCH_SIZE, validateBatchSpec, type BatchSpec } from "../discount-code-generation.js";
import { DISCOUNT_MESSAGE_MAX_LENGTH, resolveDiscountMessage } from "../discount-message.js";
import { parseLocalDateTimeInZone } from "../offer-validation.server.js";
import { DEFAULT_CODE_PAGE_TYPES } from "../page-types.js";
import type { AuthoringDeps, AuthoringResult } from "./types.js";

const when = z.string().trim().min(1).max(40);
const WHEN_DOC = "Shop-local 'YYYY-MM-DDTHH:mm' (shop timezone) or an ISO instant.";

const batchShape = {
  count: z.number().int().min(1).max(MAX_BATCH_SIZE).describe(`How many codes to generate (1-${MAX_BATCH_SIZE} per call).`),
  prefix: z.string().trim().max(40).optional().describe("Optional prefix, e.g. 'VIP-'. Upper-cased; only A-Z, 0-9, '-' and '_' are kept."),
  length: z.number().int().min(4).max(32).optional().describe("Random part length, 4-32 (default 8). Must be long enough that guessing a code is hopeless."),
  charset: z.enum(Object.keys(CODE_CHARSETS) as [keyof typeof CODE_CHARSETS, ...(keyof typeof CODE_CHARSETS)[]]).optional().describe("unambiguous (default, no 0/O/1/I), alphanumeric, letters or numbers."),
};

/** Per-code limits and window, shared by promo_create's `codes` section and the code tools. */
export const codeSettingsShape = {
  usageLimit: z.number().int().min(1).optional().describe("Total uses allowed per code; omitted = unlimited."),
  oncePerCustomer: z.boolean().optional().describe("One use per customer (default false). A offer can't mix codes with and without it."),
  codeStartsAt: when.optional().describe(`When the codes start working. ${WHEN_DOC}`),
  codeEndsAt: when.optional().describe(`When the codes stop working. ${WHEN_DOC}`),
};

export const AuthoringCodesSchema = z
  .strictObject({
    code: z.string().trim().min(1).max(255).optional().describe("One typed code customers enter, e.g. 'SUMMER10' (letters, digits, '-' and '_'; stored upper-case). Not with batch."),
    batch: z.strictObject(batchShape).optional().describe("Generate unique codes instead of typing one: { count: 100, prefix: 'VIP-', length: 8 }. Not with code."),
    discountMessage: z.string().trim().max(DISCOUNT_MESSAGE_MAX_LENGTH).optional().describe(`Message customers see at checkout (max ${DISCOUNT_MESSAGE_MAX_LENGTH} chars); default: the offer's internal name.`),
    redemption: z.enum(["checkout_code", "automatic"]).optional().describe("checkout_code (default): customers enter a code. automatic: no codes, the offer applies on its conditions alone."),
    ...codeSettingsShape,
  })
  .refine((v) => !(v.code && v.batch), { message: "Pass either code or batch, not both." })
  .refine((v) => v.redemption === "automatic" || Boolean(v.code || v.batch), { message: "Pass a typed code or a batch (or redemption: 'automatic')." });
export type AuthoringCodes = z.infer<typeof AuthoringCodesSchema>;

function codeSettings(input: { usageLimit?: number; oncePerCustomer?: boolean; codeStartsAt?: string; codeEndsAt?: string }, timezone: string): AuthoringResult<CodeSettings> {
  const startsAt = input.codeStartsAt ? parseLocalDateTimeInZone(input.codeStartsAt, timezone) : null;
  const endsAt = input.codeEndsAt ? parseLocalDateTimeInZone(input.codeEndsAt, timezone) : null;
  if (input.codeStartsAt && !startsAt) return { ok: false, error: "Code start date is invalid.", path: "codeStartsAt" };
  if (input.codeEndsAt && !endsAt) return { ok: false, error: "Code end date is invalid.", path: "codeEndsAt" };
  if (startsAt && endsAt && endsAt <= startsAt) return { ok: false, error: "Code dates: End date must be after start date.", path: "codeEndsAt" };
  return { ok: true, value: { startsAt, endsAt, usageLimit: input.usageLimit ?? null, oncePerCustomer: input.oncePerCustomer ?? false } };
}

const toSpec = (batch: NonNullable<AuthoringCodes["batch"]>): BatchSpec => ({
  prefix: batch.prefix ?? "",
  length: batch.length ?? 8,
  charset: batch.charset ?? "unambiguous",
  count: batch.count,
});

/**
 * Creates the codes (and applies discountMessage / redemption) of an offer inside the caller's transaction, the way the
 * discount wizard creates its initial code. Returns ok:false for any invalid or taken code: the caller must then throw so the
 * surrounding transaction rolls back and no half-made offer is left behind.
 */
export async function createCodesForOffer(
  tx: Db,
  deps: AuthoringDeps,
  offerId: string,
  codes: AuthoringCodes,
): Promise<AuthoringResult<{ created: number; warning?: string }>> {
  const { shopId } = deps;
  const where = and(eq(offers.shopId, shopId), eq(offers.id, offerId));
  const [offer] = await tx.select({ internalName: offers.internalName }).from(offers).where(where).limit(1);
  if (!offer) return { ok: false, error: "Offer not found." };
  const settings = codeSettings(codes, deps.timezone);
  if (!settings.ok) return settings;

  if (codes.discountMessage !== undefined) {
    const message = resolveDiscountMessage(codes.discountMessage, offer.internalName);
    if (!message.ok) return { ok: false, error: message.error, path: "discountMessage" };
    await tx.update(offers).set({ publicTitle: message.value, updatedAt: new Date() }).where(where);
  }

  if (codes.redemption === "automatic") {
    if (codes.code || codes.batch) return { ok: false, error: "Automatic redemption creates no codes: remove the code or batch." };
    await tx.update(offers).set({ codeRedemption: "automatic", requiresCode: false, updatedAt: new Date() }).where(where);
    return { ok: true, value: { created: 0 } };
  }

  if (codes.batch) {
    const spec = toSpec(codes.batch);
    const specError = validateBatchSpec(spec) ?? validateBatchEntropy(spec);
    if (specError) return { ok: false, error: specError, path: "batch" };
    const result = await createDiscountCodeBatch(tx, { shopId, offerId, spec, ...settings.value });
    return result.ok ? { ok: true, value: { created: result.created } } : { ok: false, error: result.error, path: "batch" };
  }
  const result = await createDiscountCode(tx, { shopId, offerId, code: codes.code, ...settings.value });
  if (!result.ok) return { ok: false, error: result.error, path: "code" };
  return { ok: true, value: { created: 1, ...(result.warning ? { warning: result.warning } : {}) } };
}

// ---- Code offers (the Discount Codes wizard) ----

const productGid = (raw: string) => (/^\d+$/.test(raw) ? `gid://shopify/Product/${raw}` : raw);
const utmField = z.string().trim().max(200).optional();

export const AuthoringCodeOfferSchema = z.strictObject({
  internalName: z.string().trim().min(1).max(120).describe("Offer name in the admin (made unique in the shop)."),
  discountMessage: z.string().trim().max(DISCOUNT_MESSAGE_MAX_LENGTH).optional().describe(`Message customers see at checkout (max ${DISCOUNT_MESSAGE_MAX_LENGTH} chars); default: internalName.`),
  status: z.enum(["draft", "active"]).optional().describe("draft (default) saves only; active publishes to Shopify (scheduled if startsAt is in the future)."),
  startsAt: when.optional().describe(`Offer start. ${WHEN_DOC} Default: now.`),
  endsAt: when.optional().describe(`Offer end (needs startsAt). ${WHEN_DOC}`),
  redemption: z.enum(["checkout_code", "automatic"]).optional().describe("checkout_code (default): customers enter a code. automatic: no codes are created; the offer applies on its conditions."),
  code: z.string().trim().min(1).max(255).optional().describe("One typed code, e.g. 'SUMMER10'. Exactly one of code / batch unless redemption is automatic."),
  batch: z.strictObject(batchShape).optional().describe("Generated codes: { count: 100, prefix: 'VIP-', length: 8, charset: 'unambiguous' }."),
  ...codeSettingsShape,
  target: z.enum(["order", "products", "shipping"]).optional().describe("What the code discounts: the whole order (default), selected products, or free shipping."),
  discountType: z.enum(["percentage", "fixed_amount"]).optional().describe("percentage (default) or fixed_amount. Ignored for shipping (always free)."),
  value: z.number().positive().optional().describe("Percent (1-100) or amount in the shop currency's major units (19.99). Required unless target is shipping."),
  productIds: z.array(z.string().trim().min(1).max(100)).max(250).optional().describe("target 'products': Shopify product ids (numeric or gid://shopify/Product/...); find them with catalog_search. Collections are not supported over MCP: pass the products. The code's Function config holds a limited number of products and the error says how many fit."),
  subscriptionMode: z.enum(["any", "subscription_only", "one_time_only"]).optional().describe("Which purchases qualify (default any)."),
  pageTypes: z.array(z.enum(PAGE_TYPES)).min(1).optional().describe(`Pages where the code works (default ${DEFAULT_CODE_PAGE_TYPES.join(", ")}).`),
  mixedCart: z.enum(["only_matched", "reject"]).optional().describe("Mixed carts: only_matched (default) discounts matching lines; reject refuses the code when other lines are present."),
  utm: z
    .strictObject({
      source: utmField,
      medium: utmField,
      campaign: utmField,
      term: utmField,
      content: utmField,
      scope: z.enum(["visit", "page"]).optional().describe("visit (default): the session's landing UTMs; page: the current page's."),
    })
    .optional()
    .describe("Only visitors from a tagged link: { source: 'amazon', medium: 'cpc', campaign: 'primeday2026' }. At least one field."),
  subconditions: z.record(z.string(), z.unknown()).optional().describe("Extra conditions keyed by condition type, same payloads as the wizard's builder, e.g. { cart_value: { thresholdCents: 5000 } }."),
  combines: z
    .strictObject({
      order: z.boolean().optional(),
      product: z.boolean().optional(),
      shipping: z.boolean().optional(),
    })
    .optional()
    .describe("Stacking with other Shopify discounts. Defaults like the wizard: order false, product true, shipping true."),
});
export type AuthoringCodeOffer = z.infer<typeof AuthoringCodeOfferSchema>;

function offerWindow(input: AuthoringCodeOffer, timezone: string): AuthoringResult<{ startsAt: Date | null; endsAt: Date | null }> {
  const startsAt = input.startsAt ? parseLocalDateTimeInZone(input.startsAt, timezone) : null;
  const endsAt = input.endsAt ? parseLocalDateTimeInZone(input.endsAt, timezone) : null;
  if (input.startsAt && !startsAt) return { ok: false, error: "Start date is invalid.", path: "startsAt" };
  if (input.endsAt && !endsAt) return { ok: false, error: "End date is invalid.", path: "endsAt" };
  return { ok: true, value: { startsAt, endsAt } };
}

/** The Discount Codes wizard's CodeOfferDraft from authoring input; every validation message is the wizard's. */
export function toCodeOfferDraft(input: AuthoringCodeOffer, deps: AuthoringDeps, now?: Date): AuthoringResult<CodeOfferDraft> {
  const window = offerWindow(input, deps.timezone);
  if (!window.ok) return window;
  const settings = codeSettings(input, deps.timezone);
  if (!settings.ok) return settings;
  const utm = input.utm
    ? {
        fields: { utmSource: input.utm.source ?? "", utmMedium: input.utm.medium ?? "", utmCampaign: input.utm.campaign ?? "", utmTerm: input.utm.term ?? "", utmContent: input.utm.content ?? "" },
        scope: input.utm.scope ?? "visit",
      }
    : null;
  const built = buildCodeOfferDraft(
    {
      internalName: input.internalName,
      publicTitle: input.discountMessage,
      intent: input.status === "active" ? "publish" : "draft",
      startsAt: window.value.startsAt,
      endsAt: window.value.endsAt,
      redemption: input.redemption ?? "checkout_code",
      code: input.code,
      batch: input.batch ? toSpec(input.batch) : undefined,
      codeSettings: settings.value,
      target: input.target ?? "order",
      discountType: input.discountType ?? "percentage",
      value: input.value ?? 0,
      productIds: (input.productIds ?? []).map(productGid),
      subscriptionMode: input.subscriptionMode ?? "any",
      pageTypes: (input.pageTypes ?? DEFAULT_CODE_PAGE_TYPES) as PageType[],
      rejectUnmatchedLines: input.mixedCart === "reject",
      utm,
      subconditions: input.subconditions ?? {},
      combines: { order: input.combines?.order ?? false, product: input.combines?.product ?? true, shipping: input.combines?.shipping ?? true },
    },
    { currencyCode: deps.shopCurrency, now },
  );
  return built.ok ? { ok: true, value: built.data } : { ok: false, error: built.error };
}

/**
 * Server side of the "Discount Codes" creation wizard
 * (routes/app.offers.new.codes.$template.tsx): parses and validates the form,
 * then creates the offer, its codes, conditions, reward and combination policy
 * in one transaction.
 */

import {
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  type Db,
} from "@promo/db";
import {
  PAGE_TYPES,
  ShippingDiscountRewardPayloadSchema,
  validateRewardPayload,
  type PageType,
} from "@promo/shared-types";
import { createDiscountCode, createDiscountCodeBatch, type CodeSettings } from "./discount-codes.server.js";
import { CODE_CHARSETS, type BatchSpec, type CodeCharset } from "./discount-code-generation.js";
import { normalizeOfferSubconditions, type NormalizedOfferSubcondition } from "./gift-subconditions.js";
import {
  parseDateRange,
  parseInteger,
  parseJsonRecord,
  parseJsonStringArray,
  requiredText,
} from "./offer-validation.server.js";
import { statusForSubmit } from "./offer-scheduling.server.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "./unique-offer-name.server.js";

export type DiscountTarget = "order" | "products" | "shipping";
export const UTM_FIELDS = ["utmSource", "utmMedium", "utmCampaign", "utmTerm", "utmContent"] as const;
/** Condition types that match cart lines by the page they were added from. */
const PAGE_MATCHING_TYPES = new Set(["page_types", "utm_parameters", "page_url", "specific_link"]);
const MAX_COLLECTION_PRODUCTS = 500;

type RewardDraft = {
  rewardType: "order_discount" | "product_discount" | "shipping_discount";
  discountType: "percentage" | "fixed_amount" | "free";
  value: Record<string, unknown>;
  target: Record<string, unknown>;
};

export interface CodeOfferDraft {
  internalName: string;
  publicTitle: string;
  status: "draft" | "active" | "scheduled";
  startsAt: Date | null;
  endsAt: Date | null;
  codes:
    | { mode: "single"; code: string; settings: CodeSettings }
    | { mode: "bulk"; spec: BatchSpec; settings: CodeSettings };
  target: DiscountTarget;
  reward: RewardDraft;
  /** Collections whose products get the discount; expanded to product ids on save. */
  collectionIds: string[];
  conditions: Array<NormalizedOfferSubcondition & { scope: "main" | "sub" }>;
  combines: { order: boolean; product: boolean; shipping: boolean };
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

function parseCodeSettings(formData: FormData, timezone: string): Result<CodeSettings> {
  // parseDateRange reads startsAt/endsAt; the code window posts under its own names.
  const window = new FormData();
  window.set("startsAt", String(formData.get("codeStartsAt") ?? ""));
  window.set("endsAt", String(formData.get("codeEndsAt") ?? ""));
  const dates = parseDateRange(window, timezone);
  if (dates.error) return fail(`Code dates: ${dates.error}`);
  const rawLimit = String(formData.get("usageLimit") ?? "").trim();
  const limit = parseInteger(formData, "usageLimit", 0, { min: 1, label: "Usage limit" });
  if (limit.error) return fail(limit.error);
  return {
    ok: true,
    data: {
      startsAt: dates.data!.startsAt,
      endsAt: dates.data!.endsAt,
      usageLimit: rawLimit ? limit.data! : null,
      oncePerCustomer: formData.get("oncePerCustomer") === "on",
    },
  };
}

function parseCodes(formData: FormData, timezone: string): Result<CodeOfferDraft["codes"]> {
  const settings = parseCodeSettings(formData, timezone);
  if (!settings.ok) return settings;
  if (formData.get("codeMode") === "bulk") {
    const count = parseInteger(formData, "batchCount", 0, { min: 1, label: "Number of codes" });
    if (count.error) return fail(count.error);
    if (count.data === 0) return fail("Enter how many codes to generate.");
    const length = parseInteger(formData, "batchLength", 8, { min: 4, max: 32, label: "Code length" });
    if (length.error) return fail(length.error);
    const charset = String(formData.get("batchCharset") ?? "unambiguous");
    if (!(charset in CODE_CHARSETS)) return fail("Choose a valid character set.");
    return {
      ok: true,
      data: {
        mode: "bulk",
        spec: {
          prefix: String(formData.get("batchPrefix") ?? ""),
          length: length.data!,
          charset: charset as CodeCharset,
          count: count.data!,
        },
        settings: settings.data,
      },
    };
  }
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return fail("Enter the discount code customers will type.");
  return { ok: true, data: { mode: "single", code, settings: settings.data } };
}

function parseReward(formData: FormData, currencyCode: string): Result<{ target: DiscountTarget; reward: RewardDraft; productIds: string[]; collectionIds: string[] }> {
  const target = String(formData.get("discountTarget") ?? "order");
  if (target !== "order" && target !== "products" && target !== "shipping") return fail("Choose what the code discounts.");

  if (target === "shipping") {
    const payload = ShippingDiscountRewardPayloadSchema.safeParse({
      discountType: "free",
      value: {
        amount: 100,
        currencyCode,
        tiers: [{ minimumSubtotalCents: 0, discountType: "percentage", discountValue: 100 }],
      },
      target: { deliveryGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"], scopeMode: "sitewide" },
    });
    if (!payload.success) return fail(payload.error.issues[0]?.message ?? "Invalid free shipping setup.");
    return {
      ok: true,
      data: {
        target,
        reward: { rewardType: "shipping_discount", ...payload.data } as RewardDraft,
        productIds: [],
        collectionIds: [],
      },
    };
  }

  const discountType = formData.get("discountType") === "fixed_amount" ? "fixed_amount" : "percentage";
  const amount = Number.parseFloat(String(formData.get("discountValue") ?? ""));
  if (!Number.isFinite(amount) || amount <= 0) return fail("Enter a discount greater than zero.");
  if (discountType === "percentage" && amount > 100) return fail("A percentage discount can't be more than 100%.");
  const value = {
    amount: discountType === "percentage" ? amount : Math.round(amount * 100),
    currencyCode,
  };

  if (target === "order") {
    return {
      ok: true,
      data: {
        target,
        reward: { rewardType: "order_discount", discountType, value, target: { scope: "cart" } },
        productIds: [],
        collectionIds: [],
      },
    };
  }

  const productIds = parseJsonStringArray(formData, "productIds");
  if (productIds.error) return fail(productIds.error);
  const collectionIds = parseJsonStringArray(formData, "collectionIds");
  if (collectionIds.error) return fail(collectionIds.error);
  const products = productIds.data!.filter((id) => id.startsWith("gid://shopify/Product/"));
  const collections = collectionIds.data!.filter((id) => id.startsWith("gid://shopify/Collection/"));
  if (products.length === 0 && collections.length === 0) {
    return fail("Select at least one product or collection to discount.");
  }
  return {
    ok: true,
    data: {
      target,
      reward: {
        rewardType: "product_discount",
        discountType,
        value,
        target: { scopeMode: "sitewide", productIds: products },
      },
      productIds: products,
      collectionIds: collections,
    },
  };
}

function parseConditions(formData: FormData): Result<CodeOfferDraft["conditions"]> {
  const pageTypes = formData
    .getAll("pageTypes")
    .map(String)
    .filter((type): type is PageType => (PAGE_TYPES as readonly string[]).includes(type));
  if (pageTypes.length === 0) return fail("Choose at least one kind of page where the code works.");

  // Written onto every page-matching condition so they all agree on mixed carts.
  const flags = { onlyMatchedLines: true, rejectUnmatchedLines: formData.get("mixedCart") === "reject" };

  const extras = parseJsonRecord(formData, "subconditions");
  if (extras.error) return fail(extras.error);
  // The dedicated steps own these two; never let a stray builder value override them.
  const payload: Record<string, unknown> = { ...extras.data! };
  delete payload["page_types"];
  delete payload["utm_parameters"];
  payload["page_types"] = { pageTypes, ...flags };

  if (formData.get("utmEnabled") === "on") {
    const fields = Object.fromEntries(UTM_FIELDS.map((key) => [key, String(formData.get(key) ?? "").trim()]));
    if (!Object.values(fields).some(Boolean)) {
      return fail("Fill in at least one UTM parameter, or turn off UTM validation.");
    }
    payload["utm_parameters"] = {
      ...fields,
      scope: formData.get("utmScope") === "page" ? "page" : "visit",
      ...flags,
    };
  }

  const normalized = normalizeOfferSubconditions(payload);
  if (!normalized.success) return fail(normalized.error);
  return {
    ok: true,
    data: normalized.data.map((condition) => ({
      ...condition,
      ...(PAGE_MATCHING_TYPES.has(condition.conditionType)
        ? { value: { ...condition.value, ...flags } }
        : {}),
      scope: condition.conditionType === "page_types" ? "main" : "sub",
    })),
  };
}

export function parseCodeOfferForm(
  formData: FormData,
  context: { timezone: string; currencyCode: string },
): Result<CodeOfferDraft> {
  const internalName = requiredText(formData, "internalName", "Offer name");
  if (internalName.error) return fail(internalName.error);
  const publicTitle = requiredText(formData, "publicTitle", "Title customers see");
  if (publicTitle.error) return fail(publicTitle.error);
  const schedule = parseDateRange(formData, context.timezone);
  if (schedule.error) return fail(schedule.error);

  const codes = parseCodes(formData, context.timezone);
  if (!codes.ok) return codes;
  const reward = parseReward(formData, context.currencyCode);
  if (!reward.ok) return reward;

  // Free shipping runs in Shopify's delivery Function, which can't yet check
  // where products were added from, so shipping codes carry no page rules.
  let conditions: CodeOfferDraft["conditions"] = [];
  if (reward.data.target !== "shipping") {
    const parsed = parseConditions(formData);
    if (!parsed.ok) return parsed;
    conditions = parsed.data;
  }

  const startsAt = schedule.data!.startsAt;
  return {
    ok: true,
    data: {
      internalName: internalName.data!,
      publicTitle: publicTitle.data!,
      status: statusForSubmit(String(formData.get("intent") ?? "draft"), startsAt),
      startsAt,
      endsAt: schedule.data!.endsAt,
      codes: codes.data,
      target: reward.data.target,
      reward: reward.data.reward,
      collectionIds: reward.data.collectionIds,
      conditions,
      combines: {
        order: formData.get("combinesOrderDiscounts") === "on",
        product: formData.get("combinesProductDiscounts") === "on",
        shipping: formData.get("combinesShippingDiscounts") === "on",
      },
    },
  };
}

class CodeCreationError extends Error {}

/**
 * Creates everything in one transaction, so a taken code or a failed batch
 * leaves no half-made offer behind. `resolveCollectionProducts` turns the
 * chosen collections into product ids (a snapshot, like Shopify's own picker).
 */
export async function insertCodeOffer(
  db: Db,
  shopId: string,
  timezone: string,
  draft: CodeOfferDraft,
  resolveCollectionProducts: (collectionIds: string[]) => Promise<string[]> = async () => [],
): Promise<Result<{ offerId: string; codesCreated: number }>> {
  let reward = draft.reward;
  if (draft.collectionIds.length > 0) {
    const fromCollections = await resolveCollectionProducts(draft.collectionIds);
    const productIds = [...new Set([...((reward.target["productIds"] as string[]) ?? []), ...fromCollections])];
    if (productIds.length === 0) return fail("The selected collections have no products.");
    if (productIds.length > MAX_COLLECTION_PRODUCTS) {
      return fail(`That's ${productIds.length} products; a code can discount up to ${MAX_COLLECTION_PRODUCTS}. Pick smaller collections.`);
    }
    reward = { ...reward, target: { ...reward.target, productIds } };
  }
  const rewardCheck = validateRewardPayload(reward.rewardType, reward.discountType, reward.value, reward.target);
  if (!rewardCheck.success) return fail(rewardCheck.error.issues[0]?.message ?? "The discount setup is invalid.");

  const create = (internalName: string) =>
    db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [offer] = await tx
        .insert(offers)
        .values({
          shopId,
          type: "discount",
          status: draft.status,
          internalName,
          publicTitle: draft.publicTitle,
          priority: 100,
          startsAt: draft.startsAt ?? new Date(),
          endsAt: draft.endsAt,
          timezone,
          requiresCode: true,
        })
        .returning({ id: offers.id });
      if (!offer) throw new Error("Failed to create offer");

      const codes =
        draft.codes.mode === "single"
          ? await createDiscountCode(txDb, { shopId, offerId: offer.id, code: draft.codes.code, ...draft.codes.settings })
          : await createDiscountCodeBatch(txDb, { shopId, offerId: offer.id, spec: draft.codes.spec, ...draft.codes.settings });
      if (!codes.ok) throw new CodeCreationError(codes.error);

      if (draft.conditions.length > 0) {
        await tx.insert(offerConditions).values(
          draft.conditions.map((condition, index) => ({
            shopId,
            offerId: offer.id,
            scope: condition.scope,
            conditionType: condition.conditionType,
            operator: condition.operator,
            value: condition.value,
            sortOrder: index,
            isEnabled: true,
          })),
        );
      }
      await tx.insert(offerRewards).values({
        shopId,
        offerId: offer.id,
        rewardType: reward.rewardType,
        discountType: reward.discountType,
        value: reward.value,
        target: reward.target,
        sortOrder: 0,
        trackMode: "product",
        isAutoAdd: false,
        isCustomerSelectable: false,
      });
      await tx.insert(offerCombinationPolicies).values({
        shopId,
        offerId: offer.id,
        combinesWithOrderDiscounts: draft.combines.order,
        combinesWithProductDiscounts: draft.combines.product,
        combinesWithShippingDiscounts: draft.combines.shipping,
        combinesWithOtherAppOffers: true,
        stopLowerPriority: false,
        giftValueCountsForOtherOffers: false,
      });
      return { offerId: offer.id, codesCreated: "created" in codes ? codes.created : 1 };
    });

  try {
    try {
      return { ok: true, data: await create(draft.internalName) };
    } catch (err) {
      if (err instanceof CodeCreationError || !isUniqueViolation(err)) throw err;
      return { ok: true, data: await create(withUniqueOfferSuffix(draft.internalName)) };
    }
  } catch (err) {
    if (err instanceof CodeCreationError) return fail(err.message);
    throw err;
  }
}

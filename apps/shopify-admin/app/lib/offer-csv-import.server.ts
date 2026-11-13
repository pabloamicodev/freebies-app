/**
 * CSV import service shared by the admin page (app.offers.import) and the MCP `offers_import_csv` tool.
 * Parses and validates every row (same messages as the page), then inserts each valid offer as a draft.
 * `dryRun` stops after validation and writes nothing. Drafts are never published, so there is no publish step.
 */

import { and, eq, inArray } from "drizzle-orm";
import { offerCombinationPolicies, offerConditions, offerRewards, offers, variantCache, type Db } from "@promo/db";
import {
  ConditionTypeSchema,
  DiscountTypeSchema,
  RewardTypeSchema,
  validateConditionValue,
  validateRewardPayload,
  type ConditionType,
  type DiscountType,
  type RewardType,
} from "@promo/shared-types";
import { insertAuditLog } from "./audit-log.server.js";
import { MAX_CSV_BYTES, MAX_CSV_COLUMNS, MAX_CSV_ROWS, parseCSV } from "./csv.js";
import { resolveDiscountMessage } from "./discount-message.js";
import { toStoredAmount } from "./money.js";
import { groupTierRows, parseTierGroup, SHOP_CURRENCY_COLUMN, type TierGroupResult } from "./offer-csv-tiers.js";
import { CSV_PARSE_ERRORS, safeErrorMessage } from "./safe-error.js";

const VALID_OFFER_TYPES = new Set(["gift", "bundle", "upsell", "discount", "booster"]);
const VALID_OFFER_TYPE_LABELS = Array.from(VALID_OFFER_TYPES).join(", ");
const ROW_FAILED = "This row could not be imported.";

export type CsvImportDeps = { db: Db; shopId: string; shopCurrency: string; timezone: string };
export type CsvImportRowError = { row: number; message: string };
export type CsvImportOffer = {
  /** 1-based CSV row (header = row 1); the first row of a gift-tier group. */
  row: number;
  internalName: string;
  type: string;
  /** Set once inserted; null in a dry run. */
  offerId: string | null;
};
export type CsvImportReport = {
  /** A file-level failure (size, parse, headers); no row was processed. */
  error: string | null;
  created: string[];
  errors: CsvImportRowError[];
  /** Per-offer detail of the valid rows (inserted, or would be inserted in a dry run). */
  offers: CsvImportOffer[];
  dryRun: boolean;
};
export type CsvImportOptions = {
  dryRun?: boolean;
  /** When set, every inserted offer gets an audit row (the admin page writes none). */
  performedBy?: string;
  auditExtra?: Record<string, unknown>;
};

const fileError = (error: string, dryRun: boolean): CsvImportReport => ({ error, created: [], errors: [], offers: [], dryRun });

/** The page's size/emptiness guards, run before anything else (also used by the route before it looks up the shop). */
export function checkCsvInput(csvContent: string): string | null {
  if (!csvContent) return "No CSV content provided";
  if (new TextEncoder().encode(csvContent).byteLength > MAX_CSV_BYTES) {
    return `CSV must be smaller than ${MAX_CSV_BYTES.toLocaleString()} bytes`;
  }
  return null;
}

type RowOutcome = { error: CsvImportRowError } | { offer: CsvImportOffer };

export async function importOffersCsv(deps: CsvImportDeps, csvContent: string, opts: CsvImportOptions = {}): Promise<CsvImportReport> {
  const { db, shopId, shopCurrency, timezone: shopTimezone } = deps;
  const dryRun = opts.dryRun === true;

  const inputError = checkCsvInput(csvContent);
  if (inputError) return fileError(inputError, dryRun);

  let parsedRows: string[][];
  try {
    parsedRows = parseCSV(csvContent, true);
  } catch (error) {
    return fileError(safeErrorMessage(error, "Invalid CSV", CSV_PARSE_ERRORS), dryRun);
  }
  if (parsedRows.length < 2) return fileError("CSV must have a header row and at least one data row", dryRun);
  if (parsedRows.length - 1 > MAX_CSV_ROWS) {
    return fileError(`CSV cannot contain more than ${MAX_CSV_ROWS.toLocaleString()} data rows`, dryRun);
  }

  const headerRow = parsedRows[0]!.map((h) => h.trim());
  if (headerRow.length > MAX_CSV_COLUMNS) return fileError(`CSV cannot contain more than ${MAX_CSV_COLUMNS} columns`, dryRun);
  if (headerRow.some((header) => !header)) return fileError("CSV headers cannot be blank", dryRun);
  if (new Set(headerRow).size !== headerRow.length) return fileError("CSV headers must be unique", dryRun);

  const dataRows = parsedRows.slice(1);
  const toRecord = (values: string[]) => {
    const record: Record<string, string> = {};
    headerRow.forEach((h, idx) => { record[h] = (values[idx] ?? "").trim(); });
    return record;
  };
  // Gift tiers are one offer spread over several rows (one per tier); files without the tier column never group.
  const tierGroups = groupTierRows(dataRows.map(toRecord));
  const seenNames = new Set<string>();

  const processRow = async (values: string[], i: number, groupIndices?: number[]): Promise<RowOutcome> => {
    if (values.length > headerRow.length) {
      return { error: { row: i + 2, message: "Row has more columns than the header" } };
    }
    const row = toRecord(values);
    const exportedCurrency = (row[SHOP_CURRENCY_COLUMN] ?? "").toUpperCase();
    if (exportedCurrency && exportedCurrency !== shopCurrency.toUpperCase()) {
      return { error: { row: i + 2, message: `${SHOP_CURRENCY_COLUMN} ${exportedCurrency} differs from this shop's currency ${shopCurrency}; amounts would be wrong` } };
    }

    const internalName = row["internal_name"];
    const rawPublicTitle = row["public_title"];
    const offerType = row["type"] as "gift" | "bundle" | "upsell" | "discount" | "booster";

    const rowNumber = i + 2; // +1 for header, +1 for 1-based indexing

    if (!internalName || !offerType) {
      return { error: { row: rowNumber, message: "Missing required fields: internal_name, type" } };
    }
    const message = resolveDiscountMessage(rawPublicTitle, internalName);
    if (!message.ok) return { error: { row: rowNumber, message: message.error } };
    const publicTitle = message.value;

    if (!VALID_OFFER_TYPES.has(offerType)) {
      return { error: { row: rowNumber, message: `Invalid type "${offerType}". Must be one of: ${VALID_OFFER_TYPE_LABELS}` } };
    }

    const priority = parseInt(row["priority"] ?? "100", 10);
    if (!Number.isInteger(priority) || priority < 0) {
      return { error: { row: rowNumber, message: "Priority must be a non-negative integer" } };
    }

    // A code offer re-imported from an export keeps its gate (codes themselves are not
    // exported with the offer): it stays inert until codes are added on the Codes tab.
    const requiresCodeRaw = (row["requires_code"] ?? "").toLowerCase();
    if (requiresCodeRaw && requiresCodeRaw !== "true" && requiresCodeRaw !== "false") {
      return { error: { row: rowNumber, message: "requires_code must be true or false" } };
    }
    const requiresCode = requiresCodeRaw === "true";
    const codeRedemption = (row["code_redemption"] ?? "").toLowerCase() || "checkout_code";
    if (codeRedemption !== "checkout_code" && codeRedemption !== "automatic") {
      return { error: { row: rowNumber, message: "code_redemption must be checkout_code or automatic" } };
    }

    let tiered: Exclude<TierGroupResult, { error: string }> | null = null;
    if (groupIndices) {
      // One bad row (too wide to read safely, another currency, an unknown variant) invalidates the whole offer.
      const tooWide = groupIndices.find((index) => dataRows[index]!.length > headerRow.length);
      if (tooWide !== undefined) return { error: { row: tooWide + 2, message: "Row has more columns than the header" } };
      const groupRecords = groupIndices.map((index) => toRecord(dataRows[index]!));
      const foreign = groupIndices.find((_, position) => {
        const code = (groupRecords[position]![SHOP_CURRENCY_COLUMN] ?? "").toUpperCase();
        return code !== "" && code !== shopCurrency.toUpperCase();
      });
      if (foreign !== undefined) return { error: { row: foreign + 2, message: `${SHOP_CURRENCY_COLUMN} differs from this shop's currency ${shopCurrency}; amounts would be wrong` } };
      const tierResult = parseTierGroup(groupRecords, shopCurrency);
      if ("error" in tierResult) return { error: { row: groupIndices[tierResult.rowIndex]! + 2, message: tierResult.error } };
      const wanted = [...new Set(tierResult.rewards.flatMap((reward) => [...((reward.target.variantIds as string[]) ?? []), ...((reward.target.fallbackVariantIds as string[] | undefined) ?? [])]))];
      const known = new Set((await db.select({ gid: variantCache.variantGid }).from(variantCache).where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, wanted)))).map((variant) => variant.gid));
      const missingGid = wanted.find((gid) => !known.has(gid));
      if (missingGid !== undefined) {
        const at = groupRecords.findIndex((record) => (record["gift_variant_gids"] ?? "").includes(missingGid) || (record["gift_fallback_variant_gids"] ?? "").includes(missingGid));
        return { error: { row: groupIndices[Math.max(0, at)]! + 2, message: `Variant ${missingGid} is not in this shop's catalog; sync the catalog or fix the GID` } };
      }
      tiered = tierResult;
    }

    let validatedCondition: { conditionType: ConditionType; value: Record<string, unknown> } | null = tiered
      ? { conditionType: "cart_value", value: tiered.condition }
      : null;
    if (!tiered && row["condition_type"] && row["condition_value_threshold_cents"]) {
      const conditionType = row["condition_type"] ?? "";
      const conditionTypeResult = ConditionTypeSchema.safeParse(conditionType);
      if (!conditionTypeResult.success) {
        return { error: { row: rowNumber, message: `Invalid condition_type "${conditionType}"` } };
      }
      if (conditionTypeResult.data === "discount_code") {
        return { error: { row: rowNumber, message: "Discount codes are managed on the offer's Codes tab, not as a condition." } };
      }
      const thresholdCents = parseInt(row["condition_value_threshold_cents"], 10);
      if (!Number.isInteger(thresholdCents) || thresholdCents < 0) {
        return { error: { row: rowNumber, message: "condition_value_threshold_cents must be a non-negative integer" } };
      }
      const conditionValue = { thresholdCents, currencyCode: "USD", includeGiftValues: false };
      const conditionValueResult = validateConditionValue(conditionType, conditionValue);
      if (!conditionValueResult.success) {
        return { error: { row: rowNumber, message: conditionValueResult.error.issues[0]?.message ?? "Invalid condition value" } };
      }
      validatedCondition = { conditionType: conditionTypeResult.data, value: conditionValue };
    }

    let validatedReward: {
      rewardType: RewardType;
      discountType: DiscountType;
      value: Record<string, unknown>;
      target: Record<string, unknown>;
    } | null = null;
    if (!tiered && row["reward_type"] && row["discount_type"]) {
      const rewardTypeResult = RewardTypeSchema.safeParse(row["reward_type"]);
      if (!rewardTypeResult.success) {
        return { error: { row: rowNumber, message: `Invalid reward_type "${row["reward_type"]}"` } };
      }
      const discountTypeResult = DiscountTypeSchema.safeParse(row["discount_type"]);
      if (!discountTypeResult.success) {
        return { error: { row: rowNumber, message: `Invalid discount_type "${row["discount_type"]}"` } };
      }
      const variantIds = row["gift_variant_gids"] ? row["gift_variant_gids"].split("|").filter(Boolean) : [];
      const rewardValueRaw = parseFloat(row["reward_value"] ?? "0");
      const rewardValue = Number.isFinite(rewardValueRaw) ? rewardValueRaw : 0;
      const rewardTarget = variantIds.length ? { variantIds } : { scope: "cart" };
      const rewardValuePayload = { amount: discountTypeResult.data === "percentage" ? rewardValue : toStoredAmount(rewardValue, shopCurrency), currencyCode: shopCurrency };
      const rewardPayloadResult = validateRewardPayload(rewardTypeResult.data, discountTypeResult.data, rewardValuePayload, rewardTarget);
      if (!rewardPayloadResult.success) {
        return { error: { row: rowNumber, message: rewardPayloadResult.error.issues[0]?.message ?? "Invalid reward payload" } };
      }
      validatedReward = {
        rewardType: rewardTypeResult.data,
        discountType: discountTypeResult.data,
        value: rewardValuePayload,
        target: rewardTarget,
      };
    }

    // The page surfaced these three only as its generic row failure (they were thrown inside the insert transaction).
    let giftQuantity = 1;
    let trackMode = "product";
    if (validatedReward) {
      // Blank means the default: export leaves gift_quantity empty on non-gift rewards, and re-importing them must work.
      giftQuantity = parseInt(row["gift_quantity"] || "1", 10);
      trackMode = row["track_mode"] || "product";
      const invalid =
        !Number.isInteger(giftQuantity) || giftQuantity < 1
          ? "gift_quantity must be a positive integer"
          : trackMode !== "product" && trackMode !== "variant"
            ? "track_mode must be product or variant"
            : row["is_auto_add"] && row["is_auto_add"] !== "true" && row["is_auto_add"] !== "false"
              ? "is_auto_add must be true or false"
              : null;
      if (invalid) return { error: { row: rowNumber, message: safeErrorMessage(new Error(invalid), ROW_FAILED) } };
    }

    const planned: CsvImportOffer = { row: rowNumber, internalName, type: offerType, offerId: null };

    if (dryRun) {
      // The apply would hit the (shop, internal_name) unique key and report only the generic failure; the preview can say why.
      const clash =
        seenNames.has(internalName) ||
        (await db.select({ id: offers.id }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.internalName, internalName))).limit(1)).length > 0;
      if (clash) return { error: { row: rowNumber, message: `An offer named "${internalName}" already exists in this shop (or earlier in this file)` } };
      seenNames.add(internalName);
      return { offer: planned };
    }

    try {
      const createdId = await db.transaction(async (tx) => {
        const [newOffer] = await tx.insert(offers).values({
          shopId,
          internalName,
          publicTitle,
          type: offerType,
          status: "draft",
          priority,
          timezone: shopTimezone,
          requiresCode,
          codeRedemption,
          discountTags: row["discount_tags"] ? row["discount_tags"].split("|") : [],
          ...(tiered ? { tierMode: tiered.tierMode } : {}),
        }).returning({ id: offers.id });

        if (!newOffer) throw new Error("Failed to create offer");

        await tx.insert(offerCombinationPolicies).values({
          shopId, offerId: newOffer.id,
          combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true,
          combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true,
          stopLowerPriority: false, giftValueCountsForOtherOffers: false,
        });

        if (validatedCondition) {
          await tx.insert(offerConditions).values({
            shopId,
            offerId: newOffer.id,
            scope: "main",
            conditionType: validatedCondition.conditionType,
            operator: "gte",
            value: validatedCondition.value,
            sortOrder: 0,
            isEnabled: true,
          });
        }

        if (tiered) {
          await tx.insert(offerRewards).values(tiered.rewards.map((reward) => ({ shopId, offerId: newOffer.id, ...reward })));
        }

        if (validatedReward) {
          await tx.insert(offerRewards).values({
            shopId,
            offerId: newOffer.id,
            rewardType: validatedReward.rewardType,
            discountType: validatedReward.discountType,
            value: validatedReward.value,
            target: validatedReward.target,
            quantity: giftQuantity,
            isAutoAdd: row["is_auto_add"] === "true",
            isCustomerSelectable: false,
            trackMode: trackMode as "product" | "variant",
            sortOrder: 0,
            label: null,
          });
        }

        return newOffer.id;
      });
      if (opts.performedBy) {
        await insertAuditLog(db, {
          shopId,
          entityType: "offer",
          entityId: createdId,
          action: "csv_import",
          before: null,
          after: { status: "draft", name: internalName, type: offerType, ...opts.auditExtra },
          performedBy: opts.performedBy,
        });
      }
      return { offer: { ...planned, offerId: createdId } };
    } catch (e) {
      return { error: { row: rowNumber, message: safeErrorMessage(e, ROW_FAILED) } };
    }
  };

  const rowResults: RowOutcome[] = [];
  const grouped = new Set<number>();
  for (const [index, values] of dataRows.entries()) {
    if (grouped.has(index)) continue;
    const indices = tierGroups.get(index);
    indices?.forEach((groupIndex) => grouped.add(groupIndex));
    rowResults.push(await processRow(values, index, indices));
  }

  const importedOffers = rowResults.flatMap((result) => ("offer" in result ? [result.offer] : []));
  return {
    error: null,
    created: importedOffers.flatMap((offer) => (offer.offerId ? [offer.offerId] : [])),
    errors: rowResults.flatMap((result) => ("error" in result ? [result.error] : [])),
    offers: importedOffers,
    dryRun,
  };
}

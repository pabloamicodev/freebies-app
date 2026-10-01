/**
 * One-off, idempotent move of the two legacy ways to gate an offer on a code
 * onto the discount_codes table: enabled `discount_code` conditions, and
 * `offers.requiredDiscountCode`. Disabled condition rows never gated anything,
 * so they are just dropped. Archived offers are left alone.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { discountCodes, offerConditions, offers, type Db } from "@promo/db";
import { normalizeTypedCode } from "./discount-codes.server.js";

interface OfferRef {
  shopId: string;
  offerId: string;
  internalName: string;
  status: string;
}

export interface DiscountCodeMigrationReport {
  conditionOffers: Array<OfferRef & { code: string }>;
  requiredCodeOffers: Array<OfferRef & { code: string; codeDiscountId: string | null }>;
  disabledConditionRowsDropped: number;
  skippedArchived: number;
  conflicts: Array<OfferRef & { error: string }>;
}

export async function migrateLegacyDiscountCodes(
  db: Db,
  opts: { apply: boolean; shopId?: string },
): Promise<DiscountCodeMigrationReport> {
  const report: DiscountCodeMigrationReport = {
    conditionOffers: [],
    requiredCodeOffers: [],
    disabledConditionRowsDropped: 0,
    skippedArchived: 0,
    conflicts: [],
  };

  const scope = opts.shopId ? [eq(offers.shopId, opts.shopId)] : [];
  const conditionFilter = [eq(offerConditions.conditionType, "discount_code")];
  if (opts.shopId) conditionFilter.push(eq(offerConditions.shopId, opts.shopId));
  const conditionRows = await db
    .select({
      id: offerConditions.id,
      offerId: offerConditions.offerId,
      value: offerConditions.value,
      isEnabled: offerConditions.isEnabled,
    })
    .from(offerConditions)
    .where(and(...conditionFilter));
  const requiredRows = await db
    .select()
    .from(offers)
    .where(and(...scope, ne(offers.requiredDiscountCode, "")));

  const offerIds = [...new Set([...conditionRows.map((r) => r.offerId), ...requiredRows.map((o) => o.id)])];
  if (offerIds.length === 0) return report;
  const offerRows = await db.select().from(offers).where(inArray(offers.id, offerIds));
  // A dry run can precede the migration that creates the table.
  // postgres.js returns the rows themselves; other drivers wrap them in { rows }.
  const checkResult = (await db.execute(sql`select to_regclass('public.discount_codes') as name`)) as unknown as
    | Array<{ name: string | null }>
    | { rows: Array<{ name: string | null }> };
  const [tableCheck] = Array.isArray(checkResult) ? checkResult : checkResult.rows;
  if (!tableCheck?.name && opts.apply) throw new Error("Run the database migrations first: discount_codes does not exist.");
  const allCodes = tableCheck?.name
    ? await db
        .select({ shopId: discountCodes.shopId, code: discountCodes.code, offerId: discountCodes.offerId })
        .from(discountCodes)
    : [];
  const existingCodes = allCodes;
  const takenElsewhere = new Set(allCodes.map((row) => `${row.shopId}:${row.code}`));

  for (const offer of offerRows) {
    const ref: OfferRef = {
      shopId: offer.shopId,
      offerId: offer.id,
      internalName: offer.internalName,
      status: offer.status,
    };
    const ownRows = conditionRows.filter((row) => row.offerId === offer.id);
    if (offer.status === "archived") {
      report.skippedArchived += 1;
      continue;
    }
    const codes = new Set<string>();
    let invalid: string | null = null;
    for (const row of ownRows.filter((r) => r.isEnabled)) {
      const parsed = normalizeTypedCode((row.value as { code?: unknown } | null)?.code, false);
      if (parsed.ok) codes.add(parsed.code);
      else invalid = parsed.error;
    }
    const fromCondition = [...codes];
    if (offer.requiredDiscountCode) {
      const parsed = normalizeTypedCode(offer.requiredDiscountCode, false);
      if (parsed.ok) codes.add(parsed.code);
      else invalid = parsed.error;
    }
    report.disabledConditionRowsDropped += ownRows.filter((r) => !r.isEnabled).length;
    if (invalid) {
      report.conflicts.push({ ...ref, error: `Invalid code: ${invalid}` });
      continue;
    }
    if (codes.size > 1) {
      report.conflicts.push({
        ...ref,
        error: `Several different codes (${[...codes].join(", ")}); the old rules needed all of them entered together, which the new model doesn't express. Resolve by hand.`,
      });
      continue;
    }
    const [code] = codes;
    const alreadyMigrated = code && existingCodes.some((row) => row.offerId === offer.id && row.code === code);
    if (code && !alreadyMigrated && takenElsewhere.has(`${offer.shopId}:${code}`)) {
      report.conflicts.push({ ...ref, error: `Code ${code} is already used by another offer's codes.` });
      continue;
    }

    if (code && !alreadyMigrated) {
      takenElsewhere.add(`${offer.shopId}:${code}`);
      if (fromCondition.length > 0) report.conditionOffers.push({ ...ref, code });
      if (offer.requiredDiscountCode) {
        report.requiredCodeOffers.push({ ...ref, code, codeDiscountId: offer.codeDiscountId });
      }
    } else if (offer.requiredDiscountCode) {
      report.requiredCodeOffers.push({
        ...ref,
        code: offer.requiredDiscountCode,
        codeDiscountId: offer.codeDiscountId,
      });
    }

    if (!opts.apply) continue;
    await db.transaction(async (tx) => {
      if (code && !alreadyMigrated) {
        await tx.insert(discountCodes).values({
          shopId: offer.shopId,
          offerId: offer.id,
          code,
          // The existing Shopify node already carries this code as its primary one.
          shopifySyncedAt: offer.requiredDiscountCode && offer.codeDiscountId ? new Date() : null,
        });
      }
      await tx
        .update(offers)
        .set({ requiredDiscountCode: null, requiresCode: true })
        .where(eq(offers.id, offer.id));
      if (ownRows.length > 0) {
        await tx.delete(offerConditions).where(
          inArray(
            offerConditions.id,
            ownRows.map((row) => row.id),
          ),
        );
      }
    });
  }
  return report;
}

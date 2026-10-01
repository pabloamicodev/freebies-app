import { and, asc, desc, eq, ilike, inArray, ne, sql } from "drizzle-orm";
import {
  discountCodeBatches,
  discountCodeRedemptions,
  discountCodes,
  offers,
  type Db,
  type DiscountCode,
} from "@promo/db";
import { RequiredDiscountCodeSchema } from "@promo/shared-types";
import {
  generateUniqueCodes,
  isCodeRedeemable,
  validateBatchSpec,
  type BatchSpec,
} from "./discount-code-generation.js";
import { isConstraintViolation } from "./unique-offer-name.server.js";

export const DISCOUNT_CODE_INDEX = "discount_codes_shop_code_idx";
export const CODE_TAKEN_MESSAGE = "That code is already used. Choose a different code.";
const TYPED_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
const INSERT_CHUNK = 500;

/** Whether an offer is code-gated: its flag, a legacy required code, or any codes. Used when copying an offer. */
export async function offerRequiresCode(
  db: Db,
  shopId: string,
  offer: { id: string; requiresCode: boolean; requiredDiscountCode: string | null },
): Promise<boolean> {
  if (offer.requiresCode || offer.requiredDiscountCode) return true;
  const [row] = await db
    .select({ id: discountCodes.id })
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offer.id)))
    .limit(1);
  return Boolean(row);
}

async function markRequiresCode(db: Db, shopId: string, offerId: string): Promise<void> {
  await db
    .update(offers)
    .set({ requiresCode: true })
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
}

export interface CodeSettings {
  startsAt?: Date | null;
  endsAt?: Date | null;
  usageLimit?: number | null;
  oncePerCustomer?: boolean;
}

export function validateCodeSettings(settings: CodeSettings): string | null {
  if (settings.usageLimit != null && (!Number.isInteger(settings.usageLimit) || settings.usageLimit < 1)) {
    return "Usage limit must be a whole number of at least 1.";
  }
  if (settings.startsAt && settings.endsAt && settings.endsAt <= settings.startsAt) {
    return "The end date must be after the start date.";
  }
  return null;
}

/** Normalizes a typed code. `strict` (UI input) also limits it to letters, digits, "-" and "_". */
export function normalizeTypedCode(
  raw: unknown,
  strict = true,
): { ok: true; code: string } | { ok: false; error: string } {
  const parsed = RequiredDiscountCodeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter a discount code." };
  if (strict && !TYPED_CODE_PATTERN.test(parsed.data)) {
    return { ok: false, error: "Use only letters, numbers, dashes and underscores, starting with a letter or number." };
  }
  return { ok: true, code: parsed.data };
}

async function legacyCodeHolder(db: Db, shopId: string, offerId: string, codes: string[]): Promise<string | null> {
  if (codes.length === 0) return null;
  const rows = await db
    .select({ code: offers.requiredDiscountCode })
    .from(offers)
    .where(
      and(
        eq(offers.shopId, shopId),
        inArray(offers.requiredDiscountCode, codes),
        ne(offers.id, offerId),
        ne(offers.status, "archived"),
      ),
    )
    .limit(1);
  return rows[0]?.code ?? null;
}

export async function createDiscountCode(
  db: Db,
  input: { shopId: string; offerId: string; code: unknown } & CodeSettings,
): Promise<{ ok: true; code: DiscountCode } | { ok: false; error: string }> {
  const normalized = normalizeTypedCode(input.code);
  if (!normalized.ok) return normalized;
  const settingsError = validateCodeSettings(input);
  if (settingsError) return { ok: false, error: settingsError };
  if (await legacyCodeHolder(db, input.shopId, input.offerId, [normalized.code])) {
    return { ok: false, error: CODE_TAKEN_MESSAGE };
  }
  try {
    const [row] = await db
      .insert(discountCodes)
      .values({
        shopId: input.shopId,
        offerId: input.offerId,
        code: normalized.code,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        usageLimit: input.usageLimit ?? null,
        oncePerCustomer: input.oncePerCustomer ?? false,
      })
      .returning();
    if (!row) return { ok: false, error: "Could not create the code." };
    await markRequiresCode(db, input.shopId, input.offerId);
    return { ok: true, code: row };
  } catch (err) {
    if (isConstraintViolation(err, DISCOUNT_CODE_INDEX)) return { ok: false, error: CODE_TAKEN_MESSAGE };
    throw err;
  }
}

export async function createDiscountCodeBatch(
  db: Db,
  input: { shopId: string; offerId: string; spec: BatchSpec } & CodeSettings,
): Promise<{ ok: true; created: number; batchId: string } | { ok: false; error: string }> {
  const specError = validateBatchSpec(input.spec);
  if (specError) return { ok: false, error: specError };
  const settingsError = validateCodeSettings(input);
  if (settingsError) return { ok: false, error: settingsError };

  const [batch] = await db
    .insert(discountCodeBatches)
    .values({
      shopId: input.shopId,
      offerId: input.offerId,
      prefix: input.spec.prefix,
      length: input.spec.length,
      charset: input.spec.charset,
      count: input.spec.count,
    })
    .returning({ id: discountCodeBatches.id });
  if (!batch) return { ok: false, error: "Could not create the batch." };

  let created = 0;
  // Uniqueness is decided by the (shop, code) index, so concurrent batches and
  // existing codes just lose the conflict and the loop tops the batch back up.
  // Candidates are over-generated and inserted in chunks no larger than what is
  // still missing, so the batch never overshoots its count.
  for (let round = 0; round < 12 && created < input.spec.count; round += 1) {
    const missing = input.spec.count - created;
    const candidates = generateUniqueCodes({ ...input.spec, count: missing * 2 + 20 });
    const legacy = await db
      .select({ code: offers.requiredDiscountCode })
      .from(offers)
      .where(and(eq(offers.shopId, input.shopId), inArray(offers.requiredDiscountCode, candidates)));
    const blocked = new Set(legacy.map((row) => row.code));
    const fresh = candidates.filter((code) => !blocked.has(code));
    for (let i = 0; i < fresh.length && created < input.spec.count; ) {
      const size = Math.min(INSERT_CHUNK, input.spec.count - created);
      const inserted = await db
        .insert(discountCodes)
        .values(
          fresh.slice(i, i + size).map((code) => ({
            shopId: input.shopId,
            offerId: input.offerId,
            batchId: batch.id,
            code,
            startsAt: input.startsAt ?? null,
            endsAt: input.endsAt ?? null,
            usageLimit: input.usageLimit ?? null,
            oncePerCustomer: input.oncePerCustomer ?? false,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: discountCodes.id });
      created += inserted.length;
      i += size;
    }
  }
  if (created < input.spec.count) {
    return {
      ok: false,
      error: `Only ${created} of ${input.spec.count} unique codes could be generated. Increase the code length.`,
    };
  }
  await markRequiresCode(db, input.shopId, input.offerId);
  return { ok: true, created, batchId: batch.id };
}

export interface CodeListQuery {
  search?: string;
  status?: "active" | "disabled" | "exhausted";
  batchId?: string;
  page?: number;
  pageSize?: number;
}

function codeFilter(shopId: string, offerId: string, query: CodeListQuery) {
  const filters = [eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offerId)];
  if (query.status) filters.push(eq(discountCodes.status, query.status));
  if (query.batchId) filters.push(eq(discountCodes.batchId, query.batchId));
  const search = query.search?.trim();
  if (search) filters.push(ilike(discountCodes.code, `%${search.replace(/[\\%_]/g, "\\$&")}%`));
  return and(...filters);
}

export async function listDiscountCodes(
  db: Db,
  shopId: string,
  offerId: string,
  query: CodeListQuery = {},
): Promise<{ rows: DiscountCode[]; total: number }> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const where = codeFilter(shopId, offerId, query);
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(discountCodes)
      .where(where)
      .orderBy(desc(discountCodes.createdAt), asc(discountCodes.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(discountCodes).where(where),
  ]);
  return { rows, total: totals?.total ?? 0 };
}

export async function exportDiscountCodes(
  db: Db,
  shopId: string,
  offerId: string,
  query: CodeListQuery = {},
): Promise<DiscountCode[]> {
  return db
    .select()
    .from(discountCodes)
    .where(codeFilter(shopId, offerId, query))
    .orderBy(asc(discountCodes.createdAt), asc(discountCodes.code));
}

/** Deactivating (or reactivating) takes effect on Shopify at the next publish. */
export async function setDiscountCodesStatus(
  db: Db,
  shopId: string,
  offerId: string,
  target: { ids?: string[]; batchId?: string; all?: boolean },
  status: "active" | "disabled",
): Promise<number> {
  const filters = [eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offerId)];
  if (target.ids) filters.push(inArray(discountCodes.id, target.ids));
  else if (target.batchId) filters.push(eq(discountCodes.batchId, target.batchId));
  else if (!target.all) return 0;
  // An exhausted code stays exhausted until its limit is raised; toggling it would hide that.
  filters.push(ne(discountCodes.status, "exhausted"));
  const rows = await db
    .update(discountCodes)
    .set({ status, updatedAt: new Date() })
    .where(and(...filters))
    .returning({ id: discountCodes.id });
  return rows.length;
}

/** Only codes already removed from Shopify can be deleted, so a deleted row never leaves a live code behind. */
export async function deleteDiscountCodes(
  db: Db,
  shopId: string,
  offerId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .delete(discountCodes)
    .where(
      and(
        eq(discountCodes.shopId, shopId),
        eq(discountCodes.offerId, offerId),
        inArray(discountCodes.id, ids),
        sql`${discountCodes.shopifySyncedAt} is null`,
      ),
    )
    .returning({ id: discountCodes.id });
  return rows.length;
}

export interface OrderCodePayload {
  id: number | string;
  customer?: { id: number | string } | null;
  discount_codes?: Array<{ code?: string | null }> | null;
}

/**
 * Counts one redemption per (order, code), only for codes this app manages.
 * Redelivered webhooks hit the unique (shop, order, code) index and change
 * nothing. Returns the offers whose codes just reached their usage limit, so
 * the caller can republish and pull them off Shopify.
 *
 * Race: a code is exhausted only after the paid webhook lands, so orders that
 * were already in checkout when the limit was reached can still redeem it.
 */
export async function recordDiscountCodeRedemptions(
  db: Db,
  shopId: string,
  order: OrderCodePayload,
): Promise<{ redeemed: number; exhaustedOfferIds: string[] }> {
  const entered = [
    ...new Set(
      (order.discount_codes ?? []).flatMap((entry) =>
        typeof entry.code === "string" && entry.code.trim() ? [entry.code.trim().toUpperCase()] : [],
      ),
    ),
  ];
  if (entered.length === 0) return { redeemed: 0, exhaustedOfferIds: [] };
  const known = await db
    .select()
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.code, entered)));
  if (known.length === 0) return { redeemed: 0, exhaustedOfferIds: [] };

  const orderId = String(order.id);
  const customerId = order.customer?.id != null ? `gid://shopify/Customer/${order.customer.id}` : null;
  let redeemed = 0;
  await db.transaction(async (tx) => {
    for (const code of known) {
      const inserted = await tx
        .insert(discountCodeRedemptions)
        .values({ shopId, offerId: code.offerId, codeId: code.id, code: code.code, orderId, customerId })
        .onConflictDoNothing()
        .returning({ id: discountCodeRedemptions.id });
      if (inserted.length === 0) continue;
      redeemed += 1;
      await tx
        .update(discountCodes)
        .set({
          usageCount: sql`${discountCodes.usageCount} + 1`,
          status: sql`case when ${discountCodes.usageLimit} is not null and ${discountCodes.usageCount} + 1 >= ${discountCodes.usageLimit} and ${discountCodes.status} = 'active' then 'exhausted'::discount_code_status else ${discountCodes.status} end`,
          updatedAt: new Date(),
        })
        .where(eq(discountCodes.id, code.id));
    }
  });
  // Derived from stored state (not from this call's inserts) so a redelivered
  // webhook retries a republish that failed the first time.
  const after = await db
    .select({ offerId: discountCodes.offerId, status: discountCodes.status, synced: discountCodes.shopifySyncedAt })
    .from(discountCodes)
    .where(
      and(
        eq(discountCodes.shopId, shopId),
        inArray(
          discountCodes.id,
          known.map((code) => code.id),
        ),
      ),
    );
  const exhaustedOfferIds = [
    ...new Set(after.filter((row) => row.status === "exhausted" && row.synced).map((row) => row.offerId)),
  ];
  return { redeemed, exhaustedOfferIds };
}

export interface CodeNotices {
  /** The offer is code-gated but has no code that can be redeemed right now, so it publishes nothing. */
  inert: boolean;
  /** Codes published under a suffixed variant because the requested one already exists in Shopify. */
  collisions: Array<{ id: string; code: string; requestedCode: string; existingDiscount: string | null }>;
}

export async function getCodeNotices(
  db: Db,
  shopId: string,
  offer: { id: string; requiresCode: boolean; requiredDiscountCode: string | null },
  now: Date = new Date(),
): Promise<CodeNotices> {
  const rows = await db
    .select()
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offer.id)));
  const gated = offer.requiresCode || Boolean(offer.requiredDiscountCode) || rows.length > 0;
  const live = rows.some((row) => isCodeRedeemable(row, now)) || (rows.length === 0 && Boolean(offer.requiredDiscountCode));
  return {
    inert: gated && !live,
    collisions: rows
      .filter((row) => row.requestedCode)
      .slice(0, 20)
      .map((row) => ({
        id: row.id,
        code: row.code,
        requestedCode: row.requestedCode as string,
        existingDiscount: row.collisionNote,
      })),
  };
}

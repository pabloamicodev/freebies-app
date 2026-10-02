import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
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
  CODE_CHARSETS,
  discountCodesToCsv,
  generateUniqueCodes,
  validateBatchSpec,
  type BatchSpec,
} from "./discount-code-generation.js";
import { isConstraintViolation } from "./unique-offer-name.server.js";

export const DISCOUNT_CODE_INDEX = "discount_codes_shop_code_idx";
export const CODE_TAKEN_MESSAGE = "That code is already used. Choose a different code.";
/** A typed code shorter than this is easy to guess; it is allowed but flagged. */
export const TYPED_CODE_MIN_SAFE_LENGTH = 6;
/** A batch must leave at most a 1-in-a-million chance that one random guess hits a live code. */
export const MIN_BATCH_GUESS_ODDS = 1_000_000;
export const MIXED_ONCE_PER_CUSTOMER_ERROR =
  "This offer's active codes must all be once-per-customer, or none of them: Shopify applies that rule to a whole code discount. Change the existing codes first, or create the new code with the same setting.";
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

type DbOrTx = Pick<Db, "update">;

async function markRequiresCode(db: DbOrTx, shopId: string, offerId: string): Promise<void> {
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

export function typedCodeWarning(code: string): string | null {
  return code.length < TYPED_CODE_MIN_SAFE_LENGTH
    ? `Codes shorter than ${TYPED_CODE_MIN_SAFE_LENGTH} characters are easy to guess. Anyone could try them at checkout; use a longer code, or limit its usage.`
    : null;
}

/** Entropy check for generated batches: the random part must be big enough that guessing is hopeless. */
export function validateBatchEntropy(
  spec: Pick<BatchSpec, "length" | "charset" | "count">,
  minGuessOdds: number = MIN_BATCH_GUESS_ODDS,
): string | null {
  const alphabet = CODE_CHARSETS[spec.charset];
  if (!alphabet) return "Choose a valid character set.";
  const space = alphabet.length ** spec.length;
  if (space / spec.count < minGuessOdds) {
    return `These codes are too easy to guess (${spec.count.toLocaleString("en-US")} codes out of ${Math.floor(space).toLocaleString("en-US")} possible). Use a longer code or a larger character set, or generate fewer codes.`;
  }
  return null;
}

/**
 * Whether the offer's live-or-about-to-be-live codes already commit to once-per-customer (true), its
 * absence (false), or have none (null). Scheduled codes (startsAt in the future) count: they will share
 * the node the moment they start, so mixing with them now would only fail at that publish.
 */
async function existingOncePerCustomer(db: Db, shopId: string, offerId: string): Promise<boolean | null> {
  const rows = await db
    .selectDistinct({ oncePerCustomer: discountCodes.oncePerCustomer })
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offerId), redeemableCondition(new Date(), { includeScheduled: true })));
  if (rows.length !== 1) return rows.length === 0 ? null : false;
  return rows[0]!.oncePerCustomer;
}

/** SQL twin of `isCodeRedeemable`. */
function redeemableCondition(now: Date, options: { includeScheduled?: boolean } = {}) {
  return and(
    eq(discountCodes.status, "active"),
    options.includeScheduled ? undefined : or(isNull(discountCodes.startsAt), lte(discountCodes.startsAt, now)),
    or(isNull(discountCodes.endsAt), gt(discountCodes.endsAt, now)),
    or(isNull(discountCodes.usageLimit), sql`${discountCodes.usageCount} < ${discountCodes.usageLimit}`),
  );
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
): Promise<{ ok: true; code: DiscountCode; warning?: string } | { ok: false; error: string }> {
  const normalized = normalizeTypedCode(input.code);
  if (!normalized.ok) return normalized;
  const settingsError = validateCodeSettings(input);
  if (settingsError) return { ok: false, error: settingsError };
  const existingOnce = await existingOncePerCustomer(db, input.shopId, input.offerId);
  if (existingOnce !== null && existingOnce !== (input.oncePerCustomer ?? false)) {
    return { ok: false, error: MIXED_ONCE_PER_CUSTOMER_ERROR };
  }
  if (await legacyCodeHolder(db, input.shopId, input.offerId, [normalized.code])) {
    return { ok: false, error: CODE_TAKEN_MESSAGE };
  }
  try {
    // One transaction: a code row without the offer's requiresCode flag would publish ungated.
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
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
      if (inserted) await markRequiresCode(tx, input.shopId, input.offerId);
      return inserted;
    });
    if (!row) return { ok: false, error: "Could not create the code." };
    const warning = typedCodeWarning(row.code);
    return { ok: true, code: row, ...(warning ? { warning } : {}) };
  } catch (err) {
    if (isConstraintViolation(err, DISCOUNT_CODE_INDEX)) return { ok: false, error: CODE_TAKEN_MESSAGE };
    throw err;
  }
}

export async function createDiscountCodeBatch(
  db: Db,
  input: {
    shopId: string;
    offerId: string;
    spec: BatchSpec;
    /** Lowers the guessing-odds floor; only for tests that need a tiny code space. */
    minGuessOdds?: number;
  } & CodeSettings,
): Promise<{ ok: true; created: number; batchId: string } | { ok: false; error: string }> {
  const specError = validateBatchSpec(input.spec) ?? validateBatchEntropy(input.spec, input.minGuessOdds);
  if (specError) return { ok: false, error: specError };
  const settingsError = validateCodeSettings(input);
  if (settingsError) return { ok: false, error: settingsError };
  const existingOnce = await existingOncePerCustomer(db, input.shopId, input.offerId);
  if (existingOnce !== null && existingOnce !== (input.oncePerCustomer ?? false)) {
    return { ok: false, error: MIXED_ONCE_PER_CUSTOMER_ERROR };
  }

  // Batch row, codes and the requiresCode flag commit together. A short batch rolls everything back,
  // so no partial batch (and no code rows on an ungated offer) is left behind.
  class ShortBatch extends Error {
    constructor(readonly created: number) {
      super("short batch");
    }
  }
  try {
    return await db.transaction(async (tx) => {
      const [batch] = await tx
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
      if (!batch) throw new Error("Could not create the batch.");

      let created = 0;
      // Uniqueness is decided by the (shop, code) index, so concurrent batches and
      // existing codes just lose the conflict and the loop tops the batch back up.
      // Candidates are over-generated and inserted in chunks no larger than what is
      // still missing, so the batch never overshoots its count.
      for (let round = 0; round < 12 && created < input.spec.count; round += 1) {
        const missing = input.spec.count - created;
        const candidates = generateUniqueCodes({ ...input.spec, count: missing * 2 + 20 });
        const legacy = await tx
          .select({ code: offers.requiredDiscountCode })
          .from(offers)
          .where(and(eq(offers.shopId, input.shopId), inArray(offers.requiredDiscountCode, candidates)));
        const blocked = new Set(legacy.map((row) => row.code));
        const fresh = candidates.filter((code) => !blocked.has(code));
        for (let i = 0; i < fresh.length && created < input.spec.count; ) {
          const size = Math.min(INSERT_CHUNK, input.spec.count - created);
          const inserted = await tx
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
      if (created < input.spec.count) throw new ShortBatch(created);
      await markRequiresCode(tx, input.shopId, input.offerId);
      return { ok: true as const, created, batchId: batch.id };
    });
  } catch (err) {
    if (err instanceof ShortBatch) {
      return {
        ok: false,
        error: `Only ${err.created} of ${input.spec.count} unique codes could be generated. Increase the code length.`,
      };
    }
    if (err instanceof Error && err.message === "Could not create the batch.") return { ok: false, error: err.message };
    throw err;
  }
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

/**
 * CSV of an offer's codes as a stream: one keyset-paginated page in memory at a time, so a
 * 100k-code export never builds the whole file (or the whole row list) in the function's memory.
 */
export function streamDiscountCodesCsv(
  db: Db,
  shopId: string,
  offerId: string,
  query: CodeListQuery = {},
  pageSize = 1_000,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Keyed on the timestamp as Postgres prints it: a JS Date keeps only milliseconds, and a
  // truncated key re-selects (duplicates) or skips rows that share the millisecond.
  let after: { createdAtText: string; code: string } | null = null;
  let first = true;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const found = await db
          .select({ row: discountCodes, createdAtText: sql<string>`${discountCodes.createdAt}::text` })
          .from(discountCodes)
          .where(
            and(
              codeFilter(shopId, offerId, query),
              after
                ? sql`(${discountCodes.createdAt}, ${discountCodes.code}) > (${after.createdAtText}::timestamptz, ${after.code})`
                : undefined,
            ),
          )
          .orderBy(asc(discountCodes.createdAt), asc(discountCodes.code))
          .limit(pageSize);
        const rows: DiscountCode[] = found.map((entry) => entry.row);
        const csv = discountCodesToCsv(rows);
        // discountCodesToCsv always starts with the header line; only the first page keeps it.
        const chunkText = first ? csv : csv.slice(csv.indexOf("\n") + 1);
        first = false;
        if (chunkText.length > 0) controller.enqueue(encoder.encode(chunkText));
        const last = found.at(-1);
        if (found.length < pageSize || !last) {
          finished = true;
          controller.close();
          return;
        }
        after = { createdAtText: last.createdAtText, code: last.row.code };
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
  });
}

export async function countDiscountCodes(
  db: Db,
  shopId: string,
  offerId: string,
  query: CodeListQuery = {},
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(discountCodes)
    .where(codeFilter(shopId, offerId, query));
  return row?.total ?? 0;
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

/**
 * Only codes already removed from Shopify can be deleted, so a deleted row never leaves a live code
 * behind. A code still flagged in flight to Shopify may be live even though it isn't marked synced yet.
 */
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
        sql`${discountCodes.shopifySyncPendingAt} is null`,
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
  const own = and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offer.id));
  // exists / limited reads: an offer with 100k codes must not load them all to render one banner.
  const [anyRow, liveRow, collisionRows] = await Promise.all([
    db.select({ id: discountCodes.id }).from(discountCodes).where(own).limit(1),
    db
      .select({ id: discountCodes.id })
      .from(discountCodes)
      .where(and(own, redeemableCondition(now)))
      .limit(1),
    db
      .select()
      .from(discountCodes)
      .where(and(own, sql`${discountCodes.requestedCode} is not null`))
      .limit(20),
  ]);
  const hasRows = anyRow.length > 0;
  const gated = offer.requiresCode || Boolean(offer.requiredDiscountCode) || hasRows;
  const live = liveRow.length > 0 || (!hasRows && Boolean(offer.requiredDiscountCode));
  return {
    inert: gated && !live,
    collisions: collisionRows.map((row) => ({
      id: row.id,
      code: row.code,
      requestedCode: row.requestedCode as string,
      existingDiscount: row.collisionNote,
    })),
  };
}

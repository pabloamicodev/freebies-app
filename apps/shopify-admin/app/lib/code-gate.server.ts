/**
 * Storefront-side gate for offers that own discount codes: such an offer only
 * qualifies while one of its (currently redeemable) codes is applied to the
 * cart. Codes never leave the server, so the gate is resolved here and handed
 * to the rule engine as an ordinary `discount_code` condition: one that passes
 * with the matched code, or can never pass. A failed gate disqualifies the
 * offer, which is also what removes its gifts when the code is removed.
 *
 * The gate answers "is this code valid?", so it is also a guessing oracle. Guards:
 *  - at most MAX_ENTERED_CODES distinct codes are looked at per evaluation;
 *  - codes that exist nowhere in the shop count as misses against a per-visitor limit (cart token, signed
 *    customer, or one shared anonymous bucket: never "no limit"), and once that limit is spent a call that
 *    includes misses matches nothing at all;
 *  - the visitor key is client-controlled (a bot mints a fresh cart token per request), so every miss also
 *    counts against an always-on shop-wide budget. Once it is spent the shop is locked for the rest of the
 *    window: no request that carries codes matches anything, so hits stop being distinguishable from
 *    misses. A Sentry warning is raised once per lock.
 */
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { discountCodes, offers, type Db } from "@promo/db";
import type { OfferDefinition } from "@promo/rule-engine";
import { isCodeRedeemable } from "./discount-code-generation.js";
import { checkRateLimit, envLimit } from "./rate-limit.server.js";
import { redisAcquireLock, redisGetString } from "./redis.server.js";

type DefinitionCondition = OfferDefinition["conditions"][number];

/** More codes than a shopper could legitimately stack (Shopify itself allows 5 per cart). */
export const MAX_ENTERED_CODES = 5;
export const MISSED_CODE_LIMIT = 10;
export const MISSED_CODE_WINDOW_MS = 10 * 60_000;
/** Shop-wide misses per window before the shop's code matching is locked. Override: CODE_MISS_SHOP_LIMIT. */
export const MISSED_CODE_SHOP_LIMIT_DEFAULT = 500;

const memoryLocks = new Map<string, number>();

export function resetShopCodeLocks(): void {
  memoryLocks.clear();
}

async function isShopCodeLocked(shopId: string): Promise<boolean> {
  const until = memoryLocks.get(shopId);
  if (until && until > Date.now()) return true;
  return (await redisGetString(`code-lock:${shopId}`)) !== null;
}

/** Locks code matching for the window; true only for the call that actually set the lock (alert once). */
async function lockShopCodes(shopId: string): Promise<boolean> {
  const viaRedis = await redisAcquireLock(`code-lock:${shopId}`, "1", MISSED_CODE_WINDOW_MS);
  const until = memoryLocks.get(shopId);
  const freshInMemory = !until || until <= Date.now();
  memoryLocks.set(shopId, Date.now() + MISSED_CODE_WINDOW_MS);
  return viaRedis === null ? freshInMemory : viaRedis;
}

export function codeGateCondition(matchedCode: string | null): DefinitionCondition {
  return {
    id: "code-gate",
    scope: "main",
    conditionType: "discount_code",
    operator: "eq",
    // An empty code can never equal an entered one (entered codes are non-empty).
    value: { code: matchedCode ?? "" },
    isEnabled: true,
    sortOrder: -1,
  } as DefinitionCondition;
}

/** Trimmed, uppercased, de-duplicated, empty ones dropped, and cut to the first MAX_ENTERED_CODES. */
export function normalizeEnteredCodes(appliedCodes: string[]): { codes: string[]; truncated: boolean } {
  const all = [
    ...new Set(appliedCodes.map((code) => code.trim().toUpperCase()).filter((code) => code.length > 0)),
  ];
  return { codes: all.slice(0, MAX_ENTERED_CODES), truncated: all.length > MAX_ENTERED_CODES };
}

export interface CodeGateOptions {
  /**
   * Identifies the visitor for the missed-code limit (cart token, or the signed customer id). Callers pass a
   * shared anonymous key when there is none; if omitted here the same shared bucket is used.
   */
  rateLimitKey?: string | undefined;
  /** Test seam; defaults to the shared Redis/DB-backed limiter. */
  rateLimiter?: typeof checkRateLimit;
}

export interface CodeGateResult {
  definitions: OfferDefinition[];
  /** The visitor spent their missed-code budget: nothing was matched this time. */
  blocked: boolean;
  /** More than MAX_ENTERED_CODES codes were sent; the extra ones were ignored. */
  truncated: boolean;
}

export async function applyCodeGatesDetailed(
  shopId: string,
  db: Db,
  definitions: OfferDefinition[],
  appliedCodes: string[],
  now: Date = new Date(),
  options: CodeGateOptions = {},
): Promise<CodeGateResult> {
  if (definitions.length === 0) return { definitions, blocked: false, truncated: false };
  const offerIds = definitions.map((definition) => definition.id);
  const { codes: entered, truncated } = normalizeEnteredCodes(appliedCodes);
  // Locked shops still go through the gating below, with nothing matched: returning early would leave
  // gated offers without their gate condition, i.e. open to everyone.
  const locked = entered.length > 0 && (await isShopCodeLocked(shopId));

  const [gatedOffers, known] = await Promise.all([
    // Automatic-mode offers are never gated here: they run on conditions alone.
    // `requiresCode` is set whenever an offer gets a code (and by the 0018 backfill for older
    // ones), so no scan of the codes table is needed to know which offers are gated.
    db
      .select({ id: offers.id, code: offers.requiredDiscountCode })
      .from(offers)
      .where(
        and(
          eq(offers.shopId, shopId),
          inArray(offers.id, offerIds),
          eq(offers.codeRedemption, "checkout_code"),
          or(isNotNull(offers.requiredDiscountCode), eq(offers.requiresCode, true)),
        ),
      ),
    // Any offer's code, not just this evaluation's: a code of the shop is not a "miss".
    entered.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(discountCodes)
          .where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.code, entered))),
  ]);

  let blocked = locked;
  if (entered.length > 0 && !locked) {
    const knownCodes = new Set(known.map((row) => row.code));
    for (const row of gatedOffers) if (row.code) knownCodes.add(row.code.trim().toUpperCase());
    let missed = entered.filter((code) => !knownCodes.has(code));
    if (missed.length > 0) {
      // A legacy checkout code on an offer outside this evaluation is still a real code.
      const otherLegacy = await db
        .select({ code: offers.requiredDiscountCode })
        .from(offers)
        .where(and(eq(offers.shopId, shopId), inArray(offers.requiredDiscountCode, missed)));
      const otherCodes = new Set(otherLegacy.map((row) => row.code));
      missed = missed.filter((code) => !otherCodes.has(code));
    }
    const rawLimiter = options.rateLimiter ?? checkRateLimit;
    // A broken limiter backend must not take evaluation down: fail open, loudly. (Redis and the DB both
    // being unreachable already breaks every other query of the request.)
    const limiter: typeof checkRateLimit = async (key, limitOptions) => {
      try {
        return await rawLimiter(key, limitOptions);
      } catch (error) {
        Sentry.captureException(error, { tags: { stage: "code-gate-limiter" } });
        return { ok: true };
      }
    };
    const visitorKey = options.rateLimitKey ?? "anon";
    const shopLimit = envLimit("CODE_MISS_SHOP_LIMIT", MISSED_CODE_SHOP_LIMIT_DEFAULT);
    for (let i = 0; i < missed.length; i += 1) {
      const [visitor, shop] = await Promise.all([
        limiter(`code-miss:${shopId}:${visitorKey}`, { limit: MISSED_CODE_LIMIT, windowMs: MISSED_CODE_WINDOW_MS }),
        // Redis outage: per instance, not a DB row per miss (an attacker drives this counter).
        limiter(`code-miss-shop:${shopId}`, {
          limit: shopLimit,
          windowMs: MISSED_CODE_WINDOW_MS,
          fixedWindow: true,
          onRedisUnavailable: "memory",
        }),
      ]);
      if (!shop.ok) {
        blocked = true;
        if (await lockShopCodes(shopId)) {
          Sentry.captureMessage("Discount code guessing suspected: shop-wide missed-code budget spent, code matching locked", {
            level: "warning",
            tags: { stage: "code-gate", shopId },
            extra: { shopLimit, windowMinutes: MISSED_CODE_WINDOW_MS / 60_000 },
          });
        }
        break;
      }
      if (!visitor.ok) {
        blocked = true;
        break;
      }
    }
  }

  const gated = new Set(gatedOffers.map((row) => row.id));
  if (gated.size === 0) return { definitions, blocked, truncated };
  const matchedByOffer = new Map<string, string>();
  if (!blocked) {
    const inThisEvaluation = new Set(offerIds);
    for (const row of known) {
      if (inThisEvaluation.has(row.offerId) && isCodeRedeemable(row, now)) matchedByOffer.set(row.offerId, row.code);
    }
    for (const row of gatedOffers) {
      const code = row.code?.trim().toUpperCase();
      if (code && entered.includes(code) && !matchedByOffer.has(row.id)) matchedByOffer.set(row.id, code);
    }
  }

  return {
    definitions: definitions.map((definition) =>
      gated.has(definition.id)
        ? {
            ...definition,
            conditions: [codeGateCondition(matchedByOffer.get(definition.id) ?? null), ...definition.conditions],
          }
        : definition,
    ),
    blocked,
    truncated,
  };
}

export async function applyCodeGates(
  shopId: string,
  db: Db,
  definitions: OfferDefinition[],
  appliedCodes: string[],
  now: Date = new Date(),
  options: CodeGateOptions = {},
): Promise<OfferDefinition[]> {
  return (await applyCodeGatesDetailed(shopId, db, definitions, appliedCodes, now, options)).definitions;
}

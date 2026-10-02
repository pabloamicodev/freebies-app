import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { discountCodeBatches, discountCodes, discountCodeRedemptions, offers, type Db } from "@promo/db";
import {
  CODE_TAKEN_MESSAGE,
  MIXED_ONCE_PER_CUSTOMER_ERROR,
  countDiscountCodes,
  createDiscountCode,
  createDiscountCodeBatch,
  deleteDiscountCodes,
  exportDiscountCodes,
  getCodeNotices,
  listDiscountCodes,
  normalizeTypedCode,
  recordDiscountCodeRedemptions,
  setDiscountCodesStatus,
  streamDiscountCodesCsv,
  typedCodeWarning,
  validateBatchEntropy,
} from "./discount-codes.server.js";
import { discountCodesToCsv, isCodeRedeemable } from "./discount-code-generation.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let counter = 0;
const newOffer = (overrides: Parameters<typeof seedOffer>[2] = {}) => seedOffer(db, shopId, { internalName: `o-${(counter += 1)}`, ...overrides });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db);
}, 60_000);
afterAll(async () => {
  await close();
});

describe("normalizeTypedCode", () => {
  it("uppercases and trims, and rejects characters customers can't type reliably", () => {
    expect(normalizeTypedCode("  summer-10 ")).toEqual({ ok: true, code: "SUMMER-10" });
    expect(normalizeTypedCode("sum mer").ok).toBe(false);
    expect(normalizeTypedCode("-LEAD").ok).toBe(false);
    expect(normalizeTypedCode("").ok).toBe(false);
    expect(normalizeTypedCode("A".repeat(256)).ok).toBe(false);
    expect(normalizeTypedCode("SAVE 10%", false)).toEqual({ ok: true, code: "SAVE 10%" });
  });
});

describe("createDiscountCode", () => {
  it("stores the code uppercased and refuses a duplicate in the same shop with a friendly error", async () => {
    const offerId = await newOffer();
    const first = await createDiscountCode(db, { shopId, offerId, code: "welcome10" });
    expect(first.ok && first.code.code).toBe("WELCOME10");

    const otherOffer = await newOffer();
    expect(await createDiscountCode(db, { shopId, offerId: otherOffer, code: "WELCOME10" })).toEqual({
      ok: false,
      error: CODE_TAKEN_MESSAGE,
    });
  });

  it("allows the same code in a different shop", async () => {
    const otherShop = await seedShop(db, "other-shop.myshopify.com");
    const offerId = await seedOffer(db, otherShop);
    expect((await createDiscountCode(db, { shopId: otherShop, offerId, code: "WELCOME10" })).ok).toBe(true);
  });

  it("refuses a code a legacy required-code offer still holds", async () => {
    await newOffer({ requiredDiscountCode: "LEGACY1" });
    const offerId = await newOffer();
    expect((await createDiscountCode(db, { shopId, offerId, code: "legacy1" })).ok).toBe(false);
  });

  it("validates usage limit and the date window", async () => {
    const offerId = await newOffer();
    expect((await createDiscountCode(db, { shopId, offerId, code: "LIMIT0", usageLimit: 0 })).ok).toBe(false);
    const result = await createDiscountCode(db, {
      shopId,
      offerId,
      code: "BACKWARDS",
      startsAt: new Date("2026-02-01"),
      endsAt: new Date("2026-01-01"),
    });
    expect(result).toMatchObject({ ok: false, error: "The end date must be after the start date." });
  });
});

describe("createDiscountCodeBatch", () => {
  it("generates N unique prefixed codes in one batch", async () => {
    const offerId = await newOffer();
    const result = await createDiscountCodeBatch(db, {
      shopId,
      offerId,
      spec: { prefix: "amz-", length: 8, charset: "unambiguous", count: 300 },
      usageLimit: 1,
      oncePerCustomer: true,
    });
    expect(result).toMatchObject({ ok: true, created: 300 });

    const rows = await db.select().from(discountCodes).where(eq(discountCodes.offerId, offerId));
    expect(rows).toHaveLength(300);
    expect(new Set(rows.map((row) => row.code)).size).toBe(300);
    expect(rows.every((row) => /^AMZ-[A-HJ-NP-Z2-9]{8}$/.test(row.code))).toBe(true);
    expect(rows.every((row) => row.usageLimit === 1 && row.oncePerCustomer && row.batchId)).toBe(true);
  });

  it("tops the batch up when generated codes collide with existing ones", async () => {
    const offerId = await newOffer();
    // 4 digits = 10,000 possibilities; take 6,000 of them so collisions are certain.
    await db.insert(discountCodes).values(
      Array.from({ length: 6000 }, (_, i) => ({ shopId, offerId, code: `Z${String(i).padStart(4, "0")}` })),
    );
    const result = await createDiscountCodeBatch(db, {
      shopId,
      offerId,
      spec: { prefix: "Z", length: 4, charset: "numbers", count: 1000 },
      minGuessOdds: 1,
    });
    expect(result).toMatchObject({ ok: true, created: 1000 });
    const rows = await db.select({ code: discountCodes.code }).from(discountCodes).where(eq(discountCodes.offerId, offerId));
    expect(new Set(rows.map((row) => row.code)).size).toBe(7000);
  }, 30_000);

  it("rejects specs that can't produce enough unique codes or are out of range", async () => {
    const offerId = await newOffer();
    const base = { shopId, offerId };
    expect((await createDiscountCodeBatch(db, { ...base, spec: { prefix: "", length: 4, charset: "numbers", count: 5000 } })).ok).toBe(false);
    expect((await createDiscountCodeBatch(db, { ...base, spec: { prefix: "", length: 8, charset: "numbers", count: 0 } })).ok).toBe(false);
    expect((await createDiscountCodeBatch(db, { ...base, spec: { prefix: "", length: 8, charset: "numbers", count: 5001 } })).ok).toBe(false);
    expect((await createDiscountCodeBatch(db, { ...base, spec: { prefix: "", length: 3, charset: "letters", count: 5 } })).ok).toBe(false);
  });
});

describe("list, search, status, delete, export", () => {
  it("searches, filters by status and paginates", async () => {
    const offerId = await newOffer();
    for (const code of ["ALPHA1", "ALPHA2", "BRAVO1"]) await createDiscountCode(db, { shopId, offerId, code });
    await setDiscountCodesStatus(db, shopId, offerId, { ids: [(await listDiscountCodes(db, shopId, offerId, { search: "BRAVO" })).rows[0]!.id] }, "disabled");

    expect((await listDiscountCodes(db, shopId, offerId, { search: "alpha" })).total).toBe(2);
    expect((await listDiscountCodes(db, shopId, offerId, { status: "disabled" })).rows.map((r) => r.code)).toEqual(["BRAVO1"]);
    const page = await listDiscountCodes(db, shopId, offerId, { pageSize: 2, page: 2 });
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(1);
    // LIKE wildcards in a search are literal.
    expect((await listDiscountCodes(db, shopId, offerId, { search: "%" })).total).toBe(0);
  });

  it("toggles deactivated and active codes but never touches an exhausted one", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "REACT1" });
    await createDiscountCode(db, { shopId, offerId, code: "REACT2" });
    await db.update(discountCodes).set({ status: "exhausted" }).where(eq(discountCodes.code, "REACT2"));

    expect(await setDiscountCodesStatus(db, shopId, offerId, { all: true }, "disabled")).toBe(1);
    expect(await setDiscountCodesStatus(db, shopId, offerId, { all: true }, "active")).toBe(1);
    const statuses = (await listDiscountCodes(db, shopId, offerId)).rows.map((row) => `${row.code}:${row.status}`).sort();
    expect(statuses).toEqual(["REACT1:active", "REACT2:exhausted"]);
  });

  it("can deactivate a whole batch", async () => {
    const offerId = await newOffer();
    const batch = await createDiscountCodeBatch(db, { shopId, offerId, spec: { prefix: "B", length: 6, charset: "letters", count: 20 } });
    if (!batch.ok) throw new Error("batch failed");
    expect(await setDiscountCodesStatus(db, shopId, offerId, { batchId: batch.batchId }, "disabled")).toBe(20);
  });

  it("deletes only codes already off Shopify", async () => {
    const offerId = await newOffer();
    const a = await createDiscountCode(db, { shopId, offerId, code: "DEL1" });
    const b = await createDiscountCode(db, { shopId, offerId, code: "DEL2" });
    if (!a.ok || !b.ok) throw new Error("setup");
    await db.update(discountCodes).set({ shopifySyncedAt: new Date() }).where(eq(discountCodes.id, b.code.id));

    expect(await deleteDiscountCodes(db, shopId, offerId, [a.code.id, b.code.id])).toBe(1);
    expect((await listDiscountCodes(db, shopId, offerId)).rows.map((row) => row.code)).toEqual(["DEL2"]);
  });

  it("exports every matching code as CSV, neutralizing spreadsheet formulas", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "CSV1", usageLimit: 5 });
    const csv = discountCodesToCsv(await exportDiscountCodes(db, shopId, offerId));
    expect(csv.split("\n")[0]).toBe("code,status,starts_at,ends_at,usage_limit,once_per_customer,usage_count");
    expect(csv).toContain("CSV1,active,,,5,false,0");
    expect(discountCodesToCsv([{ code: "=1+1", status: "active", startsAt: null, endsAt: null, usageLimit: null, usageCount: 0, oncePerCustomer: false }])).toContain("'=1+1");
  });
});

describe("isCodeRedeemable", () => {
  const base = { status: "active", startsAt: null, endsAt: null, usageLimit: null, usageCount: 0 };
  const now = new Date("2026-06-01T00:00:00Z");
  it("honors status, window and usage", () => {
    expect(isCodeRedeemable(base, now)).toBe(true);
    expect(isCodeRedeemable({ ...base, status: "disabled" }, now)).toBe(false);
    expect(isCodeRedeemable({ ...base, startsAt: new Date("2026-07-01") }, now)).toBe(false);
    expect(isCodeRedeemable({ ...base, endsAt: new Date("2026-05-01") }, now)).toBe(false);
    expect(isCodeRedeemable({ ...base, usageLimit: 3, usageCount: 3 }, now)).toBe(false);
    expect(isCodeRedeemable({ ...base, usageLimit: 3, usageCount: 2 }, now)).toBe(true);
  });
});

describe("recordDiscountCodeRedemptions (orders/paid)", () => {
  async function codeRow(code: string) {
    const [row] = await db.select().from(discountCodes).where(eq(discountCodes.code, code));
    return row!;
  }

  it("counts one redemption per order and is a no-op when the webhook is redelivered", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "REDEEM1" });
    const order = { id: 9001, customer: { id: 77 }, discount_codes: [{ code: "redeem1" }] };

    expect(await recordDiscountCodeRedemptions(db, shopId, order)).toMatchObject({ redeemed: 1 });
    expect(await recordDiscountCodeRedemptions(db, shopId, order)).toMatchObject({ redeemed: 0 });

    const row = await codeRow("REDEEM1");
    expect(row.usageCount).toBe(1);
    const [redemption] = await db.select().from(discountCodeRedemptions).where(eq(discountCodeRedemptions.codeId, row.id));
    expect(redemption).toMatchObject({ orderId: "9001", customerId: "gid://shopify/Customer/77", offerId });
  });

  it("counts different orders separately", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "MANY1" });
    await recordDiscountCodeRedemptions(db, shopId, { id: 1, discount_codes: [{ code: "MANY1" }] });
    await recordDiscountCodeRedemptions(db, shopId, { id: 2, discount_codes: [{ code: "MANY1" }] });
    expect((await codeRow("MANY1")).usageCount).toBe(2);
  });

  it("ignores codes this app does not manage, other shops' codes, and orders without codes", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "MINE1" });
    expect(await recordDiscountCodeRedemptions(db, shopId, { id: 3, discount_codes: [{ code: "SHOPIFYNATIVE" }] })).toEqual({ redeemed: 0, exhaustedOfferIds: [] });
    expect(await recordDiscountCodeRedemptions(db, shopId, { id: 4, discount_codes: [] })).toEqual({ redeemed: 0, exhaustedOfferIds: [] });
    expect(await recordDiscountCodeRedemptions(db, shopId, { id: 5 })).toEqual({ redeemed: 0, exhaustedOfferIds: [] });
    const otherShop = await seedShop(db, `s-${(counter += 1)}.myshopify.com`);
    expect(await recordDiscountCodeRedemptions(db, otherShop, { id: 6, discount_codes: [{ code: "MINE1" }] })).toEqual({ redeemed: 0, exhaustedOfferIds: [] });
    expect((await codeRow("MINE1")).usageCount).toBe(0);
  });

  it("exhausts a code when it reaches its usage limit and reports the offer until it is pulled off Shopify", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "LIMITED1", usageLimit: 2 });
    await db.update(discountCodes).set({ shopifySyncedAt: new Date() }).where(eq(discountCodes.code, "LIMITED1"));

    expect((await recordDiscountCodeRedemptions(db, shopId, { id: 11, discount_codes: [{ code: "LIMITED1" }] })).exhaustedOfferIds).toEqual([]);
    const second = await recordDiscountCodeRedemptions(db, shopId, { id: 12, discount_codes: [{ code: "LIMITED1" }] });
    expect(second.exhaustedOfferIds).toEqual([offerId]);
    expect(await codeRow("LIMITED1")).toMatchObject({ status: "exhausted", usageCount: 2 });

    // A redelivery of the same order still reports it, so a failed republish is retried.
    expect((await recordDiscountCodeRedemptions(db, shopId, { id: 12, discount_codes: [{ code: "LIMITED1" }] })).exhaustedOfferIds).toEqual([offerId]);
    // Once the publisher has removed it from the node, nothing is left to do.
    await db.update(discountCodes).set({ shopifySyncedAt: null }).where(eq(discountCodes.code, "LIMITED1"));
    expect((await recordDiscountCodeRedemptions(db, shopId, { id: 12, discount_codes: [{ code: "LIMITED1" }] })).exhaustedOfferIds).toEqual([]);
  });

  it("handles two of this offer's codes on one order and a mix with a foreign code", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "COMBO1" });
    await createDiscountCode(db, { shopId, offerId, code: "COMBO2" });
    const result = await recordDiscountCodeRedemptions(db, shopId, {
      id: 21,
      discount_codes: [{ code: "combo1" }, { code: "COMBO2" }, { code: "OTHER" }],
    });
    expect(result.redeemed).toBe(2);
  });

  it("does not leave the offers table untouched by code bookkeeping", async () => {
    const offerId = await newOffer();
    const [before] = await db.select().from(offers).where(eq(offers.id, offerId));
    await createDiscountCode(db, { shopId, offerId, code: "UNTOUCHED1" });
    await recordDiscountCodeRedemptions(db, shopId, { id: 31, discount_codes: [{ code: "UNTOUCHED1" }] });
    const [after] = await db.select().from(offers).where(eq(offers.id, offerId));
    expect(after!.requiredDiscountCode).toBe(before!.requiredDiscountCode);
  });
});

describe("typed-code length warning", () => {
  it("warns on a code shorter than 6 characters but still creates it", async () => {
    const offerId = await newOffer();
    const short = await createDiscountCode(db, { shopId, offerId, code: "VIP" });
    expect(short.ok && short.warning).toMatch(/shorter than 6 characters/);
    expect(short.ok).toBe(true);
    expect(typedCodeWarning("SIXSIX")).toBeNull();
    expect(typedCodeWarning("FIVE5")).not.toBeNull();
  });

  it("gives no warning for a code of 6 or more characters", async () => {
    const offerId = await newOffer();
    const long = await createDiscountCode(db, { shopId, offerId, code: "BIGBONUS25" });
    expect(long.ok && long.warning).toBeUndefined();
  });
});

describe("batch entropy minimum", () => {
  it("requires the random part to leave at most a one-in-a-million guessing chance", () => {
    // 10^6 possibilities for 100 codes: one guess in 10,000 hits.
    expect(validateBatchEntropy({ length: 6, charset: "numbers", count: 100 })).toMatch(/too easy to guess/);
    // 32^8 ~ 1.1e12 for 5,000 codes: far above the floor.
    expect(validateBatchEntropy({ length: 8, charset: "unambiguous", count: 5000 })).toBeNull();
    // The boundary: exactly 1e6 possibilities per code passes.
    expect(validateBatchEntropy({ length: 6, charset: "numbers", count: 1 })).toBeNull();
    expect(validateBatchEntropy({ length: 6, charset: "numbers", count: 2 })).not.toBeNull();
  });

  it("is enforced when a batch is created", async () => {
    const offerId = await newOffer();
    const weak = await createDiscountCodeBatch(db, {
      shopId,
      offerId,
      spec: { prefix: "WEAK", length: 6, charset: "numbers", count: 500 },
    });
    expect(weak).toMatchObject({ ok: false });
    expect((await listDiscountCodes(db, shopId, offerId)).total).toBe(0);

    const strong = await createDiscountCodeBatch(db, {
      shopId,
      offerId,
      spec: { prefix: "OK-", length: 8, charset: "unambiguous", count: 50 },
    });
    expect(strong).toMatchObject({ ok: true, created: 50 });
  });
});

describe("once-per-customer cannot be mixed within one offer", () => {
  it("refuses a code whose setting differs from the offer's active codes", async () => {
    const offerId = await newOffer();
    expect((await createDiscountCode(db, { shopId, offerId, code: "ONCE-A", oncePerCustomer: true })).ok).toBe(true);

    expect(await createDiscountCode(db, { shopId, offerId, code: "MULTI-A", oncePerCustomer: false })).toEqual({
      ok: false,
      error: MIXED_ONCE_PER_CUSTOMER_ERROR,
    });
    expect((await createDiscountCode(db, { shopId, offerId, code: "ONCE-B", oncePerCustomer: true })).ok).toBe(true);
  });

  it("applies the same rule the other way round and to generated batches", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "PLAIN-A" });
    const batch = await createDiscountCodeBatch(db, {
      shopId,
      offerId,
      oncePerCustomer: true,
      spec: { prefix: "ONE-", length: 8, charset: "unambiguous", count: 5 },
    });
    expect(batch).toEqual({ ok: false, error: MIXED_ONCE_PER_CUSTOMER_ERROR });
    expect(
      await createDiscountCodeBatch(db, {
        shopId,
        offerId,
        spec: { prefix: "PL-", length: 8, charset: "unambiguous", count: 5 },
      }),
    ).toMatchObject({ ok: true });
  });

  it("counts scheduled (future-dated) codes: they share the node the moment they start", async () => {
    const offerId = await newOffer();
    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect((await createDiscountCode(db, { shopId, offerId, code: "LATER-ONCE", oncePerCustomer: true, startsAt })).ok).toBe(true);
    expect(await createDiscountCode(db, { shopId, offerId, code: "NOW-MULTI", oncePerCustomer: false })).toEqual({
      ok: false,
      error: MIXED_ONCE_PER_CUSTOMER_ERROR,
    });
    expect(
      await createDiscountCodeBatch(db, {
        shopId,
        offerId,
        spec: { prefix: "LB-", length: 8, charset: "unambiguous", count: 3 },
      }),
    ).toEqual({ ok: false, error: MIXED_ONCE_PER_CUSTOMER_ERROR });
  });

  it("ignores disabled codes, so the merchant can switch the whole offer over", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "OLD-ONCE", oncePerCustomer: true });
    await setDiscountCodesStatus(db, shopId, offerId, { all: true }, "disabled");
    expect((await createDiscountCode(db, { shopId, offerId, code: "NEW-MULTI", oncePerCustomer: false })).ok).toBe(true);
  });
});

describe("code insert and requiresCode flag are one transaction", () => {
  /** A db whose transactions fail on the requiresCode update, like a crash between the two statements. */
  const failingFlagDb = (): Db =>
    new Proxy(db, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(inner, innerKey) {
                  if (innerKey === "update") {
                    return () => {
                      throw new Error("flag update failed");
                    };
                  }
                  return Reflect.get(inner, innerKey);
                },
              }),
            ),
          );
      },
    });

  it("leaves no code row behind when marking the offer gated fails", async () => {
    const offerId = await newOffer();
    await expect(createDiscountCode(failingFlagDb(), { shopId, offerId, code: "ATOMIC-1" })).rejects.toThrow("flag update failed");
    expect(await countDiscountCodes(db, shopId, offerId)).toBe(0);
  });

  it("leaves no batch or codes behind for a batch either, and flags the offer when it succeeds", async () => {
    const offerId = await newOffer();
    await expect(
      createDiscountCodeBatch(failingFlagDb(), {
        shopId,
        offerId,
        spec: { prefix: "AT-", length: 8, charset: "unambiguous", count: 5 },
      }),
    ).rejects.toThrow("flag update failed");
    expect(await countDiscountCodes(db, shopId, offerId)).toBe(0);
    expect(await db.select().from(discountCodeBatches).where(eq(discountCodeBatches.offerId, offerId))).toEqual([]);

    expect(await createDiscountCodeBatch(db, { shopId, offerId, spec: { prefix: "AT-", length: 8, charset: "unambiguous", count: 5 } })).toMatchObject({ ok: true });
    const [offer] = await db.select({ requiresCode: offers.requiresCode }).from(offers).where(eq(offers.id, offerId));
    expect(offer?.requiresCode).toBe(true);
  });
});

describe("getCodeNotices (exists and limited reads)", () => {
  const gated = (offerId: string) => ({ id: offerId, requiresCode: true, requiredDiscountCode: null });

  it("is inert when the offer is gated but no code is redeemable, and live when one is", async () => {
    const offerId = await newOffer({ requiresCode: true });
    expect((await getCodeNotices(db, shopId, gated(offerId))).inert).toBe(true);

    await createDiscountCode(db, { shopId, offerId, code: "LIVE-NOTICE" });
    expect((await getCodeNotices(db, shopId, gated(offerId))).inert).toBe(false);

    await setDiscountCodesStatus(db, shopId, offerId, { all: true }, "disabled");
    expect((await getCodeNotices(db, shopId, gated(offerId))).inert).toBe(true);
  });

  it("treats an expired, not-yet-started or used-up code as not redeemable", async () => {
    const offerId = await newOffer({ requiresCode: true });
    await db.insert(discountCodes).values([
      { shopId, offerId, code: "NOTICE-EXPIRED", endsAt: new Date(Date.now() - 1000) },
      { shopId, offerId, code: "NOTICE-FUTURE", startsAt: new Date(Date.now() + 86_400_000) },
      { shopId, offerId, code: "NOTICE-FULL", usageLimit: 1, usageCount: 1 },
    ]);
    expect((await getCodeNotices(db, shopId, gated(offerId))).inert).toBe(true);
  });

  it("lists at most 20 collision notices without loading every code", async () => {
    const offerId = await newOffer({ requiresCode: true });
    await db.insert(discountCodes).values(
      Array.from({ length: 25 }, (_, i) => ({
        shopId,
        offerId,
        code: `NOTE-${i}`,
        requestedCode: `ASKED-${i}`,
        collisionNote: "Their discount",
      })),
    );
    const notices = await getCodeNotices(db, shopId, gated(offerId));
    expect(notices.collisions).toHaveLength(20);
    expect(notices.collisions[0]).toMatchObject({ existingDiscount: "Their discount" });
  });
});

describe("streamed CSV export and counting", () => {
  async function readAll(stream: ReadableStream<Uint8Array>): Promise<{ text: string; chunks: number }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text, chunks };
      chunks += 1;
      text += decoder.decode(value, { stream: true });
    }
  }

  it("streams the same CSV the in-memory export builds, one page at a time", async () => {
    const offerId = await newOffer();
    await db.insert(discountCodes).values(
      Array.from({ length: 2500 }, (_, i) => ({ shopId, offerId, code: `STREAM-${String(i).padStart(5, "0")}` })),
    );

    const { text, chunks } = await readAll(streamDiscountCodesCsv(db, shopId, offerId, {}, 1000));

    expect(text).toBe(discountCodesToCsv(await exportDiscountCodes(db, shopId, offerId)));
    expect(chunks).toBe(3);
    expect(text.split("\n")[0]).toBe("code,status,starts_at,ends_at,usage_limit,once_per_customer,usage_count");
    expect(text.trim().split("\n")).toHaveLength(2501);
  });

  it("handles an exact page multiple and an empty offer without a stray header or empty chunk", async () => {
    const offerId = await newOffer();
    expect((await readAll(streamDiscountCodesCsv(db, shopId, offerId))).text).toBe(
      "code,status,starts_at,ends_at,usage_limit,once_per_customer,usage_count\n",
    );

    await db.insert(discountCodes).values(Array.from({ length: 4 }, (_, i) => ({ shopId, offerId, code: `EXACT-${i}` })));
    const { text } = await readAll(streamDiscountCodesCsv(db, shopId, offerId, {}, 2));
    expect(text.trim().split("\n")).toHaveLength(5);
    expect(text.match(/^code,status/gm)).toHaveLength(1);
  });

  it("pages through rows that share a millisecond without repeating or skipping any (microsecond keyset)", async () => {
    const offerId = await newOffer();
    await db.insert(discountCodes).values(Array.from({ length: 7 }, (_, i) => ({ shopId, offerId, code: `MICRO-${i}` })));
    // Same millisecond, different microseconds: a millisecond-precision key re-selects these across pages.
    for (let i = 0; i < 7; i += 1) {
      await db
        .update(discountCodes)
        .set({ createdAt: sql`('2026-01-01 00:00:00.123' || ${String(100 + i)})::timestamptz` })
        .where(eq(discountCodes.code, `MICRO-${i}`));
    }
    const { text } = await readAll(streamDiscountCodesCsv(db, shopId, offerId, {}, 2));
    const lines = text.trim().split(/\r?\n/).slice(1);
    expect(lines.map((line) => line.split(",")[0])).toEqual(Array.from({ length: 7 }, (_, i) => `MICRO-${i}`));
  });

  it("honours the same filters as the list", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "FILTER-A1" });
    await createDiscountCode(db, { shopId, offerId, code: "FILTER-B1" });
    const { text } = await readAll(streamDiscountCodesCsv(db, shopId, offerId, { search: "FILTER-A" }));
    expect(text).toContain("FILTER-A1");
    expect(text).not.toContain("FILTER-B1");
  });

  it("counts without loading rows", async () => {
    const offerId = await newOffer();
    await createDiscountCode(db, { shopId, offerId, code: "COUNT-1" });
    await createDiscountCode(db, { shopId, offerId, code: "COUNT-2" });
    expect(await countDiscountCodes(db, shopId, offerId)).toBe(2);
    expect(await countDiscountCodes(db, shopId, offerId, { search: "COUNT-1" })).toBe(1);
  });
});

describe("a code in flight to Shopify cannot be deleted", () => {
  it("keeps a row flagged pending even though it is not marked synced yet", async () => {
    const offerId = await newOffer();
    const created = await createDiscountCode(db, { shopId, offerId, code: "INFLIGHT" });
    if (!created.ok) throw new Error("setup");
    await db.update(discountCodes).set({ shopifySyncPendingAt: new Date() }).where(eq(discountCodes.id, created.code.id));

    expect(await deleteDiscountCodes(db, shopId, offerId, [created.code.id])).toBe(0);
    expect((await listDiscountCodes(db, shopId, offerId)).total).toBe(1);

    await db.update(discountCodes).set({ shopifySyncPendingAt: null }).where(eq(discountCodes.id, created.code.id));
    expect(await deleteDiscountCodes(db, shopId, offerId, [created.code.id])).toBe(1);
  });
});

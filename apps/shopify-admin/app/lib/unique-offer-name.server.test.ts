import { describe, expect, it } from "vitest";
import { isConstraintViolation, isUniqueViolation, withUniqueOfferSuffix } from "./unique-offer-name.server.js";

/**
 * Regression test (app.offers.new._index.tsx action, "checkout_code_promo"
 * creation flow): Postgres reports the same 23505 code for BOTH
 * `offers_shop_internal_name` and the newer partial unique index on
 * (shop_id, required_discount_code) — `offers_shop_required_discount_code_idx`
 * (packages/db/src/schema/offers.ts). The action originally assumed every
 * 23505 meant a name collision and retried with a suffixed name — which,
 * for a discount-code collision, resubmits the SAME already-taken code and
 * throws again, uncaught. Fixed by checking WHICH constraint actually fired
 * (`isConstraintViolation`) before deciding how to react.
 *
 * These tests reproduce the action's real control flow (see
 * app.offers.new._index.tsx's create action) against a fake insert that
 * fails with 23505 on whichever unique index the current attempt's values
 * violate.
 */
describe("create-offer duplicate-code handling (app.offers.new._index.tsx)", () => {
  function pgUniqueViolation(constraint: string): Error & { code: string; constraint: string } {
    const err = new Error(`duplicate key value violates unique constraint "${constraint}"`) as Error & {
      code: string;
      constraint: string;
    };
    err.code = "23505";
    err.constraint = constraint;
    return err;
  }

  async function runCreateOfferAction(
    internalName: string,
    code: string,
    createOfferWithChildren: (name: string, code: string) => Promise<{ id: string; internalName: string; code: string }>,
  ): Promise<{ id: string } | { error: string }> {
    try {
      return await createOfferWithChildren(internalName, code);
    } catch (err) {
      if (isConstraintViolation(err, "offers_shop_required_discount_code_idx")) {
        return { error: "That discount code is already used by another offer. Choose a different code." };
      }
      if (!isUniqueViolation(err)) throw err;
      return await createOfferWithChildren(withUniqueOfferSuffix(internalName), code);
    }
  }

  it("retries and succeeds when the violation is on the internal-name index", async () => {
    const existingNames = new Set(["free-gift-50"]);
    async function createOfferWithChildren(candidateName: string, code: string) {
      if (existingNames.has(candidateName)) throw pgUniqueViolation("offers_shop_internal_name");
      return { id: "new-offer", internalName: candidateName, code };
    }

    const result = await runCreateOfferAction("free-gift-50", "PRIME2026", createOfferWithChildren);
    expect(result).toMatchObject({ id: "new-offer" });
  });

  it("returns a friendly error instead of retrying (and re-failing) when the violation is really on the discount-code index", async () => {
    // A different, non-archived offer already holds "PRIME2026" — the
    // partial unique index on (shop_id, required_discount_code) fires
    // regardless of internalName, so a name-suffix retry could never help.
    const codeAlreadyTaken = "PRIME2026";
    async function createOfferWithChildren(candidateName: string, code: string) {
      if (code === codeAlreadyTaken) throw pgUniqueViolation("offers_shop_required_discount_code_idx");
      return { id: "new-offer", internalName: candidateName, code };
    }

    const result = await runCreateOfferAction("checkout-promo", codeAlreadyTaken, createOfferWithChildren);
    expect(result).toEqual({
      error: "That discount code is already used by another offer. Choose a different code.",
    });
  });
});

describe("driver error shapes", () => {
  const postgresJs = Object.assign(new Error("duplicate key"), { code: "23505", constraint_name: "idx_a" });

  it("reads the constraint from postgres.js errors (constraint_name)", () => {
    expect(isConstraintViolation(postgresJs, "idx_a")).toBe(true);
    expect(isConstraintViolation(postgresJs, "idx_b")).toBe(false);
  });

  it("finds the Postgres error under a DrizzleQueryError-style cause", () => {
    const wrapped = Object.assign(new Error("Failed query: insert ..."), { cause: postgresJs });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isConstraintViolation(wrapped, "idx_a")).toBe(true);
  });

  it("does not treat unrelated errors as unique violations", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isConstraintViolation(Object.assign(new Error("x"), { code: "23503" }), "idx_a")).toBe(false);
  });
});

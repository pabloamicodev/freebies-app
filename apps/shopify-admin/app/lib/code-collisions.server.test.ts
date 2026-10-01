import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { discountCodes, offers, type Db } from "@promo/db";
import { suffixedCode, lookupCodes, type CodeAvailability } from "./code-preflight.server.js";
import { retryOriginalCode } from "./code-retry.server.js";
import {
  createDiscountCode,
  createDiscountCodeBatch,
  getCodeNotices,
  offerRequiresCode,
} from "./discount-codes.server.js";
import { applyCodeGates } from "./code-gate.server.js";
import { migrateLegacyDiscountCodes } from "./discount-code-migration.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import type { OfferDefinition } from "@promo/rule-engine";

vi.mock("./token-crypto.server.js", () => ({ decryptToken: async () => "token" }));
const graphql = vi.hoisted(() => ({
  calls: [] as Array<{ query: string; variables: Record<string, string> }>,
  nodes: {} as Record<string, unknown>,
}));
vi.mock("./shopify-fetch.server.js", () => ({
  shopifyGraphQL: async (args: { query: string; variables: Record<string, string> }) => {
    graphql.calls.push(args);
    return Object.fromEntries(
      Object.entries(args.variables).map(([name, code]) => [
        `c${name.slice(1)}`,
        graphql.nodes[code] ?? null,
      ]),
    );
  },
}));

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const availability = (map: Record<string, CodeAvailability>) =>
  (async (_d: string, _t: string, codes: string[]) =>
    new Map(
      codes.map((code) => [code, map[code] ?? ({ status: "free" } as CodeAvailability)]),
    )) as typeof lookupCodes;

describe("suffixedCode", () => {
  it("is deterministic, readable and changes with the attempt", () => {
    const first = suffixedCode("PRIME", "shop:offer", 1);
    expect(first).toMatch(/^PRIME-[A-HJ-NP-Z2-9]{3}$/);
    expect(suffixedCode("PRIME", "shop:offer", 1)).toBe(first);
    expect(suffixedCode("PRIME", "shop:offer", 2)).not.toBe(first);
    expect(suffixedCode("PRIME", "other:offer", 1)).not.toBe(first);
  });
});

describe("lookupCodes", () => {
  it("classifies codes as free, ours, or taken (with the other discount's title), batched in one request", async () => {
    graphql.calls.length = 0;
    graphql.nodes = {
      MINE: {
        id: "gid://shopify/DiscountCodeNode/own",
        codeDiscount: { title: "[Promo Engine] x" },
      },
      THEIRS: { id: "gid://shopify/DiscountCodeNode/other", codeDiscount: { title: "Influencer" } },
    };
    const result = await lookupCodes(
      "s.myshopify.com",
      "t",
      ["FREE", "MINE", "THEIRS"],
      "gid://shopify/DiscountCodeNode/own",
    );
    expect(result.get("FREE")).toEqual({ status: "free" });
    expect(result.get("MINE")).toEqual({ status: "ours" });
    expect(result.get("THEIRS")).toEqual({ status: "taken", title: "Influencer" });
    expect(graphql.calls).toHaveLength(1);
    expect(graphql.calls[0]!.query).not.toMatch(/mutation/);
  });
});

describe("retryOriginalCode", () => {
  async function suffixedRow(shopId: string, synced: boolean) {
    const offerId = await seedOffer(db, shopId, {
      codeDiscountId: "gid://shopify/DiscountCodeNode/node",
    });
    const [row] = await db
      .insert(discountCodes)
      .values({
        shopId,
        offerId,
        code: "PRIME-7Q4",
        requestedCode: "PRIME",
        collisionNote: "Influencer",
        shopifySyncedAt: synced ? new Date() : null,
      })
      .returning();
    return row!;
  }

  it("switches back to the original once it is free in Shopify, removing the variant from the node", async () => {
    const shopId = await seedShop(db, "retry-ok.myshopify.com");
    const row = await suffixedRow(shopId, true);
    const remove = vi.fn().mockResolvedValue(undefined);

    const result = await retryOriginalCode(
      db,
      shopId,
      "retry-ok.myshopify.com",
      row.id,
      availability({}),
      remove,
    );

    expect(result).toEqual({ ok: true, code: "PRIME" });
    expect(remove).toHaveBeenCalledWith(
      "retry-ok.myshopify.com",
      "token",
      "gid://shopify/DiscountCodeNode/node",
      ["PRIME-7Q4"],
    );
    const [after] = await db.select().from(discountCodes).where(eq(discountCodes.id, row.id));
    expect(after).toMatchObject({
      code: "PRIME",
      requestedCode: null,
      collisionNote: null,
      shopifySyncedAt: null,
    });
  });

  it("refuses, changing nothing, while the original still exists as the merchant's discount", async () => {
    const shopId = await seedShop(db, "retry-no.myshopify.com");
    const row = await suffixedRow(shopId, true);
    const remove = vi.fn();

    const result = await retryOriginalCode(
      db,
      shopId,
      "retry-no.myshopify.com",
      row.id,
      availability({ PRIME: { status: "taken", title: "Influencer" } }),
      remove,
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(
      /PRIME still exists in Shopify \(discount "Influencer"\)/,
    );
    expect(remove).not.toHaveBeenCalled();
    const [after] = await db.select().from(discountCodes).where(eq(discountCodes.id, row.id));
    expect(after).toMatchObject({ code: "PRIME-7Q4", requestedCode: "PRIME" });
  });

  it("does nothing for a code that was never renamed, and reports a clash with another of our codes", async () => {
    const shopId = await seedShop(db, "retry-edge.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    const plain = await createDiscountCode(db, { shopId, offerId, code: "PLAIN1" });
    if (!plain.ok) throw new Error("setup");
    expect(
      (
        await retryOriginalCode(
          db,
          shopId,
          "retry-edge.myshopify.com",
          plain.code.id,
          availability({}),
        )
      ).ok,
    ).toBe(false);

    const row = await suffixedRow(shopId, false);
    await db.insert(discountCodes).values({ shopId, offerId, code: "PRIME" });
    const clash = await retryOriginalCode(
      db,
      shopId,
      "retry-edge.myshopify.com",
      row.id,
      availability({}),
      vi.fn(),
    );
    expect(clash).toMatchObject({ ok: false });
  });
});

describe("requiresCode", () => {
  it("is set when a code or batch is created", async () => {
    const shopId = await seedShop(db, "requires.myshopify.com");
    const single = await seedOffer(db, shopId);
    const batch = await seedOffer(db, shopId);
    await createDiscountCode(db, { shopId, offerId: single, code: "REQ1" });
    await createDiscountCodeBatch(db, {
      shopId,
      offerId: batch,
      spec: { prefix: "R", length: 6, charset: "letters", count: 5 },
    });
    for (const id of [single, batch]) {
      const [row] = await db
        .select({ requiresCode: offers.requiresCode })
        .from(offers)
        .where(eq(offers.id, id));
      expect(row!.requiresCode).toBe(true);
    }
  });

  it("is carried to a duplicate: offerRequiresCode is true for flagged, legacy-coded and code-owning offers, false otherwise", async () => {
    const shopId = await seedShop(db, "dup.myshopify.com");
    const plain = await seedOffer(db, shopId);
    const flagged = await seedOffer(db, shopId, { requiresCode: true });
    const legacy = await seedOffer(db, shopId, { requiredDiscountCode: "OLD1" });
    const owner = await seedOffer(db, shopId);
    await db.insert(discountCodes).values({ shopId, offerId: owner, code: "OWNS1" });
    const check = async (id: string) => {
      const [row] = await db.select().from(offers).where(eq(offers.id, id));
      return offerRequiresCode(db, shopId, row!);
    };
    expect(await check(plain)).toBe(false);
    expect(await check(flagged)).toBe(true);
    expect(await check(legacy)).toBe(true);
    expect(await check(owner)).toBe(true);
  });

  it("a duplicate-style offer (flag set, no codes) never qualifies on the storefront", async () => {
    const shopId = await seedShop(db, "gate-dup.myshopify.com");
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    const definition = {
      id: offerId,
      version: 1,
      type: "gift",
      priority: 1,
      stopLowerPriority: false,
      startsAt: null,
      endsAt: null,
      conditions: [],
      rewards: [],
      combinationPolicy: {},
      giftValueCountsForOtherOffers: false,
    } as unknown as OfferDefinition;
    const [gated] = await applyCodeGates(shopId, db, [definition], ["ANYTHING"]);
    expect(gated!.conditions[0]).toMatchObject({
      conditionType: "discount_code",
      value: { code: "" },
    });
  });

  it("raises an inert warning for a gated offer with no redeemable code, and clears it once a code exists", async () => {
    const shopId = await seedShop(db, "notice.myshopify.com");
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    const load = async () => {
      const [row] = await db.select().from(offers).where(eq(offers.id, offerId));
      return getCodeNotices(db, shopId, row!);
    };
    expect((await load()).inert).toBe(true);
    await createDiscountCode(db, { shopId, offerId, code: "NOTICE1" });
    expect((await load()).inert).toBe(false);
    await db
      .update(discountCodes)
      .set({ requestedCode: "NOTICE", collisionNote: "Other" })
      .where(eq(discountCodes.code, "NOTICE1"));
    expect((await load()).collisions).toEqual([
      expect.objectContaining({
        code: "NOTICE1",
        requestedCode: "NOTICE",
        existingDiscount: "Other",
      }),
    ]);
  });

  it("an un-gated plain offer never warns", async () => {
    const shopId = await seedShop(db, "notice-plain.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    const [row] = await db.select().from(offers).where(eq(offers.id, offerId));
    expect((await getCodeNotices(db, shopId, row!)).inert).toBe(false);
  });

  it("the legacy-code migration sets the flag on every converted offer", async () => {
    const shopId = await seedShop(db, "mig-flag.myshopify.com");
    const offerId = await seedOffer(db, shopId, { requiredDiscountCode: "MIGFLAG" });
    await migrateLegacyDiscountCodes(db, { apply: true, shopId });
    const [row] = await db.select().from(offers).where(eq(offers.id, offerId));
    expect(row).toMatchObject({ requiresCode: true, requiredDiscountCode: null });
  });
});

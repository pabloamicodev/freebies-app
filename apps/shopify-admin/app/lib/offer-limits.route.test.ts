import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offerCombinationPolicies, offerRewards, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "", scope: "read_products" as string | null }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "limits-shop.myshopify.com", scope: ctx.scope },
  }),
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => ctx.db,
}));
vi.mock("./offer-publish-flow.server.js", () => ({
  republishIfActive: async () => null,
}));

const route = await import("../routes/app.offers.$id.combination.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, "limits-shop.myshopify.com");
  ctx.shopId = shopId;
}, 60_000);
afterAll(async () => {
  await close();
});

const run = (fn: unknown, request: Request, id: string) =>
  (fn as (a: unknown) => Promise<unknown>)({ request, params: { id }, context: {} });
const post = (id: string, fields: Record<string, string>) =>
  run(route.action, new Request("http://localhost/", { method: "POST", body: new URLSearchParams(fields) }), id) as Promise<{
    error?: string;
    success?: boolean;
  }>;
const policy = async (id: string) =>
  (await db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, id)))[0];
const reward = (offerId: string, rewardType: "product_gift" | "order_discount" | "shipping_discount") =>
  db.insert(offerRewards).values({ shopId, offerId, rewardType, discountType: "percentage", value: { amount: 10 }, target: { scope: "cart" } });

describe("combination limits action", () => {
  it("persists limits and the identified-customer toggle", async () => {
    const id = await seedOffer(db, shopId, { publicTitle: "Persist title" });
    await reward(id, "product_gift");
    const res = await post(id, { max_per_cart: "2", max_per_customer: "3", require_identified_customer: "on" });
    expect(res.success).toBe(true);
    const p = await policy(id);
    expect(p).toMatchObject({ maxApplicationsPerCart: 2, maxApplicationsPerCustomer: 3, requireIdentifiedCustomer: true });
    await post(id, { max_per_customer: "3" });
    expect((await policy(id))?.requireIdentifiedCustomer).toBe(false);
  });

  it("rejects out-of-range or non-integer limits without saving", async () => {
    const id = await seedOffer(db, shopId, { publicTitle: "Bounds title" });
    for (const bad of ["0", "1001", "2.5", "abc"]) {
      const res = await post(id, { max_per_customer: bad });
      expect(res.error).toMatch(/between 1 and 1000/);
    }
    expect(await policy(id)).toBeUndefined();
  });

  it("ignores max per cart for order-only offers", async () => {
    const id = await seedOffer(db, shopId, { type: "discount", publicTitle: "Order only" });
    await reward(id, "order_discount");
    await post(id, { max_per_cart: "5", max_per_customer: "1" });
    expect(await policy(id)).toMatchObject({ maxApplicationsPerCart: null, maxApplicationsPerCustomer: 1 });
  });

  it("requires a unique public title for a per-customer limit on an automatic offer", async () => {
    await seedOffer(db, shopId, { publicTitle: "Dup Title", internalName: "first dup" });
    const b = await seedOffer(db, shopId, { publicTitle: "Dup Title", internalName: "second dup" });
    const res = await post(b, { max_per_customer: "1" });
    expect(res.error).toMatch(/unique customer-facing title/);
    expect(res.error).toContain("first dup");
    expect(await policy(b)).toBeUndefined();

    const blank = await seedOffer(db, shopId, { publicTitle: "  " });
    expect((await post(blank, { max_per_customer: "1" })).error).toMatch(/unique customer-facing title/);
  });

  it("does not count archived offers and does not require a title for code offers", async () => {
    await seedOffer(db, shopId, { publicTitle: "Archived twin", status: "archived" });
    const live = await seedOffer(db, shopId, { publicTitle: "Archived twin" });
    expect((await post(live, { max_per_customer: "1" })).success).toBe(true);

    const code = await seedOffer(db, shopId, { publicTitle: "", requiresCode: true });
    expect((await post(code, { max_per_customer: "1" })).success).toBe(true);
  });

  it("an offer without a per-customer limit can save with a colliding title", async () => {
    await seedOffer(db, shopId, { publicTitle: "Shared" });
    const id = await seedOffer(db, shopId, { publicTitle: "Shared" });
    expect((await post(id, { max_per_cart: "2" })).success).toBe(true);
  });
});

describe("combination limits loader", () => {
  const load = async (id: string) =>
    (await run(route.loader, new Request("http://localhost/"), id)) as {
      help: { showPerCart: boolean };
      missingCustomerScope: boolean;
    };

  it("flags a missing write_customers scope only when a per-customer limit is set", async () => {
    const id = await seedOffer(db, shopId, { publicTitle: "Scope title" });
    ctx.scope = "read_customers";
    expect((await load(id)).missingCustomerScope).toBe(false);
    await post(id, { max_per_customer: "1" });
    expect((await load(id)).missingCustomerScope).toBe(true);
    ctx.scope = "read_customers,write_customers";
    expect((await load(id)).missingCustomerScope).toBe(false);
    ctx.scope = null;
    expect((await load(id)).missingCustomerScope).toBe(true);
  });

  it("hides per-cart for order and shipping offers", async () => {
    const id = await seedOffer(db, shopId, { type: "discount", publicTitle: "Ship only" });
    await reward(id, "shipping_discount");
    expect((await load(id)).help.showPerCart).toBe(false);
  });
});

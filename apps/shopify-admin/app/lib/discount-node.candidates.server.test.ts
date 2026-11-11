import type * as PromoDb from "@promo/db";
import type * as ShopifyFetch from "./shopify-fetch.server.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";
import { createTestDb, seedShop } from "./test-support/pglite-db.js";
import { shopifyGraphQL } from "./shopify-fetch.server.js";

const ctx = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@promo/db", async (importOriginal) => ({ ...(await importOriginal<typeof PromoDb>()), getDb: () => ctx.db }));
vi.mock("./shopify-fetch.server.js", async (importOriginal) => ({ ...(await importOriginal<typeof ShopifyFetch>()), shopifyGraphQL: vi.fn() }));

const { listAutomaticDiscountCandidates } = await import("./discount-node.server.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, "candidates.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

describe("listAutomaticDiscountCandidates", () => {
  it("marks native Shopify discounts and tells other apps' discounts apart", async () => {
    vi.mocked(shopifyGraphQL).mockResolvedValueOnce({
      discountNodes: {
        nodes: [
          { id: "gid://shopify/DiscountNode/1", discount: { __typename: "DiscountAutomaticBasic", title: "Basic" } },
          { id: "gid://shopify/DiscountNode/2", discount: { __typename: "DiscountAutomaticBxgy", title: "Bxgy" } },
          { id: "gid://shopify/DiscountNode/3", discount: { __typename: "DiscountAutomaticFreeShipping", title: "Ship" } },
          { id: "gid://shopify/DiscountNode/4", discount: { __typename: "DiscountAutomaticApp", title: "Nektar", appDiscountType: { app: { title: "Nektar" } } } },
          { id: "gid://shopify/DiscountNode/5", discount: { __typename: "DiscountAutomaticApp", title: "Unknown owner", appDiscountType: null } },
          { id: "gid://shopify/DiscountNode/6", discount: { __typename: "DiscountCodeBasic", title: "Code" } },
        ],
      },
    });
    const list = await listAutomaticDiscountCandidates(shopId, "candidates.myshopify.com", "token");
    expect(list.map((c) => [c.id.split("/").pop(), c.native])).toEqual([
      ["1", true],
      ["2", true],
      ["3", true],
      ["4", false],
      ["5", false],
    ]);
    expect(list[3]).toMatchObject({ appTitle: "Nektar" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { offerConditions, offerRewards, productCache, variantCache, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerPromoPreviewTools } from "./register-promo-preview.server.js";

const SHOP = "onesolsupps.myshopify.com";
const BUNDLE_PRODUCT = "gid://shopify/Product/9208279269615";
const BUNDLE_VARIANT = "gid://shopify/ProductVariant/48000000000001";
const OTHER_PRODUCT = "gid://shopify/Product/1111";
const OTHER_VARIANT = "gid://shopify/ProductVariant/2222";
const GIFT_PRODUCT = "gid://shopify/Product/3333";
const GIFT_VARIANT = "gid://shopify/ProductVariant/4444";

const operator: Operator = { id: "op", email: "o@example.com", name: "Op", role: "viewer", shopAllowList: ["*"] };

let db: Db;
let close: () => Promise<void>;
let client: Client;
const ids: Record<string, string> = {};

type Out = {
  summary: string;
  data: {
    cart: { subtotal: { amount: string } };
    qualified: Array<{
      offer: { ref: string; name: string };
      lineDiscounts: Array<{ discountedUnits: number; discountType: string; discountValue: number; tier: { minimumQuantity: number } | null; totalDiscount: { amount: string }; discountPerUnit: { amount: string } }>;
      lineDiscountTotal: { amount: string } | null;
      gifts: Array<{ variantId: string; quantity: number; title: string | null }>;
      notes: string[];
    }>;
    notQualified: Array<{ offer: { name: string }; why: string[] }>;
  };
};

async function preview(args: Record<string, unknown>): Promise<Out> {
  const res = await client.callTool({ name: "promo_preview_cart", arguments: { shop: "onesolsupps", ...args } });
  return res.structuredContent as unknown as Out;
}
const byName = <T extends { offer: { name: string } }>(rows: T[], name: string) => rows.find((r) => r.offer.name === name);

async function seedCatalog(shopId: string) {
  const product = (gid: string, handle: string, title: string) => ({ shopId, productGid: gid, handle, title, raw: {} });
  await db.insert(productCache).values([
    product(BUNDLE_PRODUCT, "protein-creatine-bundle", "Protein & Creatine Bundle"),
    product(OTHER_PRODUCT, "shaker", "Shaker"),
    product(GIFT_PRODUCT, "free-scoop", "Free Scoop"),
  ]);
  const variant = (productGid: string, variantGid: string, title: string, price: string) => ({ shopId, productGid, variantGid, title, price, currencyCode: "USD", raw: {} });
  await db.insert(variantCache).values([
    variant(BUNDLE_PRODUCT, BUNDLE_VARIANT, "Default Title", "100.0000"),
    variant(OTHER_PRODUCT, OTHER_VARIANT, "Default Title", "30.0000"),
    variant(GIFT_PRODUCT, GIFT_VARIANT, "Default Title", "12.0000"),
  ]);
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const shopId = await seedShop(db, SHOP);
  await seedCatalog(shopId);

  ids["tiers"] = await seedOffer(db, shopId, { type: "discount", internalName: "Bundle quantity tiers", priority: 10 });
  await db.insert(offerConditions).values({ shopId, offerId: ids["tiers"], scope: "main", conditionType: "cart_quantity", operator: "gte", value: { minQuantity: 1, includeGiftValues: false } });
  await db.insert(offerRewards).values({
    shopId,
    offerId: ids["tiers"],
    rewardType: "product_discount",
    discountType: "percentage",
    value: {
      amount: 20,
      currencyCode: "USD",
      tiers: [
        { minimumQuantity: 1, maximumQuantity: 1, discountType: "percentage", discountValue: 20 },
        { minimumQuantity: 2, discountType: "percentage", discountValue: 30 },
      ],
    },
    target: { scope: "specific", productIds: [BUNDLE_PRODUCT] },
  });

  ids["gift"] = await seedOffer(db, shopId, { type: "gift", internalName: "Free scoop over 100", priority: 20 });
  await db.insert(offerConditions).values({ shopId, offerId: ids["gift"], scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 10_000, currencyCode: "USD", includeGiftValues: false } });
  await db.insert(offerRewards).values({
    shopId,
    offerId: ids["gift"],
    rewardType: "product_gift",
    discountType: "free",
    value: { percentage: 100 },
    target: { scope: "cart", variantIds: [GIFT_VARIANT], productIds: [GIFT_PRODUCT] },
    quantity: 1,
    isAutoAdd: true,
    trackMode: "variant",
  });

  ids["page"] = await seedOffer(db, shopId, { type: "discount", internalName: "Product page only", priority: 30, status: "draft" });
  await db.insert(offerConditions).values({ shopId, offerId: ids["page"], scope: "main", conditionType: "page_types", operator: "in", value: { pageTypes: ["product"] } });
  await db.insert(offerRewards).values({
    shopId,
    offerId: ids["page"],
    rewardType: "product_discount",
    discountType: "percentage",
    value: { amount: 10, currencyCode: "USD" },
    target: { scope: "specific", productIds: [OTHER_PRODUCT] },
  });

  const server = new McpServer({ name: "test", version: "0" });
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date("2026-11-13T12:00:00Z") };
  registerPromoPreviewTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
}, 60_000);
afterAll(async () => {
  await client.close();
  await close();
});

describe("promo_preview_cart", () => {
  it("is registered read-only", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "promo_preview_cart");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toContain("NOT simulated");
  });

  it("quantity tiers: 1 unit is 20% off, 2 units 30% off, by product id", async () => {
    const one = await preview({ lines: [{ product: "9208279269615", quantity: 1 }] });
    const q1 = byName(one.data.qualified, "Bundle quantity tiers")!;
    expect(q1.lineDiscounts).toHaveLength(1);
    expect(q1.lineDiscounts[0]).toMatchObject({ discountedUnits: 1, discountType: "percentage", discountValue: 20, tier: { minimumQuantity: 1 } });
    expect(q1.lineDiscounts[0]!.discountPerUnit.amount).toBe("20.00");
    expect(q1.lineDiscounts[0]!.totalDiscount.amount).toBe("20.00");

    const two = await preview({ lines: [{ product: "9208279269615", quantity: 2 }] });
    const q2 = byName(two.data.qualified, "Bundle quantity tiers")!;
    expect(q2.lineDiscounts[0]).toMatchObject({ discountedUnits: 2, discountValue: 30, tier: { minimumQuantity: 2 } });
    expect(q2.lineDiscounts[0]!.discountPerUnit.amount).toBe("30.00");
    expect(q2.lineDiscountTotal!.amount).toBe("60.00");
  });

  it("accepts a variant id and an explicit unit price", async () => {
    const out = await preview({ lines: [{ variant: "48000000000001", quantity: 2, unitPrice: 50 }] });
    expect(out.data.cart.subtotal.amount).toBe("100.00");
    expect(byName(out.data.qualified, "Bundle quantity tiers")!.lineDiscounts[0]!.discountPerUnit.amount).toBe("15.00");
  });

  it("a cart without the target product qualifies the offer but discounts no line", async () => {
    const out = await preview({ lines: [{ product: "shaker", quantity: 1 }] });
    const q = byName(out.data.qualified, "Bundle quantity tiers")!;
    expect(q.lineDiscounts).toEqual([]);
    expect(q.notes.join(" ")).toContain("no cart line matches");
  });

  it("gift threshold: below it the offer does not qualify and says why, above it the gift is added", async () => {
    const below = await preview({ lines: [{ product: "shaker", quantity: 2 }] });
    const miss = byName(below.data.notQualified, "Free scoop over 100")!;
    expect(miss.why.join(" ").toLowerCase()).toContain("cart");
    expect(byName(below.data.qualified, "Free scoop over 100")).toBeUndefined();

    const above = await preview({ lines: [{ product: "shaker", quantity: 4 }] });
    const hit = byName(above.data.qualified, "Free scoop over 100")!;
    expect(hit.gifts).toEqual([expect.objectContaining({ variantId: GIFT_VARIANT, quantity: 1, title: "Free Scoop" })]);
  });

  it("a page_types condition that is not met names the page in the reason; named drafts are included", async () => {
    const offers = [`promo:onesolsupps:${ids["page"]}`];
    const cart = await preview({ offers, lines: [{ product: "shaker" }], page: { type: "cart" } });
    expect(cart.data.qualified).toEqual([]);
    expect(cart.data.notQualified[0]!.offer.name).toBe("Product page only");
    expect(cart.data.notQualified[0]!.why.join(" ")).toContain("cart");

    const noPage = await preview({ offers, lines: [{ product: "shaker" }] });
    expect(noPage.data.notQualified[0]!.why.join(" ")).toContain("No page URL");

    const product = await preview({ offers, lines: [{ product: "shaker" }], page: { type: "product" } });
    const hit = byName(product.data.qualified, "Product page only");
    expect(hit).toBeDefined();
  });

  it("a draft is skipped unless named; an unknown product is a NOT_FOUND error", async () => {
    const all = await preview({ lines: [{ product: "shaker" }], page: { type: "product" } });
    expect([...all.data.qualified, ...all.data.notQualified].map((r) => r.offer.name)).not.toContain("Product page only");
    const res = await client.callTool({ name: "promo_preview_cart", arguments: { shop: "onesolsupps", lines: [{ product: "999" }] } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain("NOT_FOUND");
  });
});

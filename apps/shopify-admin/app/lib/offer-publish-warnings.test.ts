import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const world = vi.hoisted(() => ({ theme: "ok" as "ok" | "down", directory: "ok" as "ok" | "absent" | "down" }));
const redis = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("./redis.server.js", () => ({
  redisGetString: async (k: string) => redis.store.get(k) ?? null,
  redisSetString: async (k: string, v: string) => void redis.store.set(k, v),
}));
vi.mock("./token-crypto.server.js", () => ({ decryptToken: async () => "tok" }));
vi.mock("./offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("./sync/offer-publisher.server.js", () => ({ MAX_METAFIELD_BYTES: 9500, publishOffersForShop: async () => "ok" }));
vi.mock("./shopify-fetch.server.js", () => ({
  shopifyGraphQL: async ({ query }: { query: string }) => {
    if (query.includes("PromoEngineExperimentDirectory")) {
      if (world.directory === "down") throw new Error("down");
      if (world.directory === "absent") return { shop: { metafield: null } };
      return {
        shop: {
          metafield: {
            value: JSON.stringify({
              v: 1,
              experiments: [{ id: "abcd1234", name: "PDP hero", status: "RUNNING", mode: "inline", variants: [{ key: "control", name: "Control", control: true }] }],
            }),
          },
        },
      };
    }
    if (world.theme === "down") throw new Error("down");
    const theme = { id: "gid://shopify/OnlineStoreTheme/1", name: "Dawn", updatedAt: "u1" };
    if (query.includes("PromoEngineThemeHead")) return { themes: { nodes: [theme] } };
    const files =
      query.includes("PromoEngineThemeTemplates")
        ? [{ filename: "templates/page.landing.json", body: { content: JSON.stringify({ sections: { hero: { type: "hero" } }, order: ["hero"] }) } }]
        : [];
    return { themes: { nodes: [{ ...theme, files: { nodes: files, pageInfo: { hasNextPage: false, endCursor: null } } }] } };
  },
}));

const { finalizeCreatedOffer, getPublishWarnings, getShopPublishWarnings } = await import("./offer-publish-flow.server.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;
const auth = { shopDomain: "warn-shop.myshopify.com", accessToken: "t" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, "warn-shop.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  world.theme = "ok";
  world.directory = "ok";
  redis.store.clear();
});

async function offerWith(conditions: Array<{ conditionType: string; value: unknown; isEnabled?: boolean }>) {
  const id = await seedOffer(db, shopId, { status: "draft" });
  for (const [i, c] of conditions.entries()) {
    await db.insert(offerConditions).values({
      shopId, offerId: id, scope: "main", conditionType: c.conditionType as "template", operator: "gte",
      value: c.value, sortOrder: i, isEnabled: c.isEnabled ?? true,
    });
  }
  return id;
}

describe("getPublishWarnings", () => {
  it("is empty when every ref and the experiment exist", async () => {
    const id = await offerWith([
      { conditionType: "template", value: { templates: ["page.landing"] } },
      { conditionType: "section_shown", value: { sections: [{ template: "page.landing", key: "hero" }] } },
      { conditionType: "experiment", value: { experimentId: "abcd1234", variantKeys: ["control"] } },
    ]);
    expect(await getPublishWarnings(db, shopId, id, auth)).toEqual([]);
  });

  it("warns about stale template and section refs", async () => {
    const id = await offerWith([
      { conditionType: "template", value: { templates: ["page.gone"] } },
      { conditionType: "section_shown", value: { sections: [{ template: "page.landing", key: "old" }] } },
    ]);
    expect(await getPublishWarnings(db, shopId, id, auth)).toEqual([
      'Template "page.gone" is not in your published theme.',
      'Section "page.landing/old" is not in your published theme. A section that is deleted and re-added gets a new ID, so reselect it.',
    ]);
  });

  it("warns about a missing experiment or arm, ignoring disabled conditions", async () => {
    const id = await offerWith([
      { conditionType: "experiment", value: { experimentId: "deadbeef", variantKeys: ["a"], experimentName: "Old" } },
      { conditionType: "experiment", value: { experimentId: "abcd1234", variantKeys: ["control", "nope"] } },
      { conditionType: "template", value: { templates: ["page.gone"] }, isEnabled: false },
    ]);
    expect(await getPublishWarnings(db, shopId, id, auth)).toEqual([
      'Experiment "Old" is not in your Experiment Engine directory.',
      'Experiment "abcd1234" has no arm "nope".',
    ]);
  });

  it("gives no warning when the theme or the directory is unreadable", async () => {
    const id = await offerWith([
      { conditionType: "template", value: { templates: ["page.gone"] } },
      { conditionType: "experiment", value: { experimentId: "deadbeef", variantKeys: ["a"] } },
    ]);
    world.theme = "down";
    world.directory = "down";
    expect(await getPublishWarnings(db, shopId, id, auth)).toEqual([]);
    world.directory = "absent";
    expect(await getPublishWarnings(db, shopId, id, auth)).toEqual([]);
  });
});

describe("getShopPublishWarnings and the wizard end", () => {
  const missing = { conditionType: "experiment", value: { experimentId: "deadbeef", variantKeys: ["a"], experimentName: "Old" } };

  it("resolves the stored token itself and returns the same warnings", async () => {
    const id = await offerWith([missing]);
    expect(await getShopPublishWarnings(db, shopId, "warn-shop.myshopify.com", id)).toEqual(await getPublishWarnings(db, shopId, id, auth));
    expect(await getShopPublishWarnings(db, shopId, "warn-shop.myshopify.com", id)).toHaveLength(1);
  });

  it("finalizeCreatedOffer keeps the offer live and audits the warnings; a clean offer writes no audit", async () => {
    const withWarning = await offerWith([missing, { conditionType: "cart_value", value: { thresholdCents: 100, currencyCode: "USD", includeGiftValues: false } }]);
    const clean = await offerWith([{ conditionType: "cart_value", value: { thresholdCents: 100, currencyCode: "USD", includeGiftValues: false } }]);
    for (const id of [withWarning, clean]) {
      await db.insert(offerRewards).values({
        shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
        target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
      });
      await db.update(offers).set({ status: "active" }).where(eq(offers.id, id));
      expect(await finalizeCreatedOffer(db, shopId, "warn-shop.myshopify.com", id, "active")).toBeNull();
    }
    expect((await db.select().from(offers).where(eq(offers.id, withWarning)))[0]!.status).toBe("active");
    const logs = (id: string) => db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.entityId, id)));
    expect((await logs(withWarning))[0]).toMatchObject({ action: "publish_warning", performedBy: "system", after: { warnings: ['Experiment "Old" is not in your Experiment Engine directory.'] } });
    expect(await logs(clean)).toHaveLength(0);
  });
});

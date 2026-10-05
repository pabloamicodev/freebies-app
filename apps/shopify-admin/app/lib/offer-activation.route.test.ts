import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offerConditions, offerRewards, offers, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ART = "America/Argentina/Buenos_Aires";
const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "", timezone: "UTC" }));
const publishShopConfig = vi.hoisted(() => vi.fn(async () => null as string | null));
const republishIfActive = vi.hoisted(() => vi.fn(async () => null as string | null));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: ctx.timezone,
    currencyCode: "USD",
    session: { shop: "route-shop.myshopify.com" },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: "route-shop.myshopify.com" } }) },
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@promo/db")>()),
  getDb: () => ctx.db,
}));
vi.mock("./offer-publish-flow.server.js", () => ({
  publishShopConfig,
  republishIfActive,
  validateOffersPublishable: async () => ({ ok: true }),
}));
vi.mock("./audit-log.server.js", () => ({ insertAuditLog: async () => undefined }));

const detail = await import("../routes/app.offers.$id._index.js");
const list = await import("../routes/app.offers._index.js");
const quickCreate = await import("../routes/app.offers.new._index.js");
const csvImport = await import("../routes/app.offers.import.js");
const { insertPresetOffer } = await import("./legacy-store-presets.server.js");
const { restoreArchivedOffers, recordUninstallArchive } = await import("./restore-archived-offers.server.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, "route-shop.myshopify.com");
  await db.update(shops).set({ timezone: ART }).where(eq(shops.id, shopId));
  ctx.shopId = shopId;
  ctx.timezone = ART;
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publishShopConfig.mockClear();
  republishIfActive.mockClear();
});

const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const post = (url: string, fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
  return new Request(`http://localhost${url}`, { method: "POST", body });
};
const row = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<unknown>)({ request, params, context: {} });

async function publishable(overrides: Partial<typeof offers.$inferInsert>) {
  const id = await seedOffer(db, shopId, { status: "draft", ...overrides });
  await db.insert(offerConditions).values({
    shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte",
    value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true,
  });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 }, target: { scope: "cart" },
  });
  return id;
}

describe("activation honours the schedule", () => {
  it("detail Publish with a future start schedules the offer", async () => {
    const id = await publishable({ startsAt: days(2) });
    await run(detail.action, post(`/app/offers/${id}`, { intent: "publish" }), { id });
    expect((await row(id)).status).toBe("scheduled");
  });

  it("detail Publish with a past start activates", async () => {
    const id = await publishable({ startsAt: days(-1) });
    await run(detail.action, post(`/app/offers/${id}`, { intent: "publish" }), { id });
    expect((await row(id)).status).toBe("active");
  });

  it("list toggle_status schedules a future-start offer and expires an ended one", async () => {
    const future = await seedOffer(db, shopId, { status: "paused", startsAt: days(3) });
    const ended = await seedOffer(db, shopId, { status: "paused", startsAt: days(-5), endsAt: days(-1) });
    for (const id of [future, ended]) {
      await run(list.action, post("/app/offers", { intent: "toggle_status", offerId: id, currentStatus: "paused" }));
    }
    expect((await row(future)).status).toBe("scheduled");
    expect((await row(ended)).status).toBe("expired");
  });

  it("list bulk_activate sets each offer by its own dates", async () => {
    const future = await seedOffer(db, shopId, { status: "draft", startsAt: days(3) });
    const now = await seedOffer(db, shopId, { status: "draft" });
    await run(list.action, post("/app/offers", { intent: "bulk_activate", "offerIds[]": [future, now] }));
    expect((await row(future)).status).toBe("scheduled");
    expect((await row(now)).status).toBe("active");
  });

  it("restore puts a future-start offer back as scheduled", async () => {
    const id = await seedOffer(db, shopId, { status: "archived", archivedAt: new Date(), startsAt: days(4) });
    await recordUninstallArchive(db, shopId, [id]);
    await restoreArchivedOffers(
      { db, shopId, shopDomain: "route-shop.myshopify.com" },
      { publish: async () => null, validate: async () => ({ ok: true }) },
    );
    expect((await row(id)).status).toBe("scheduled");
  });

  it("detail update moves an active offer with a new future start to scheduled and republishes", async () => {
    const id = await seedOffer(db, shopId, { status: "active", timezone: ART, startsAt: days(-2) });
    await run(
      detail.action,
      post(`/app/offers/${id}`, { intent: "update", internalName: "n", publicTitle: "t", startsAt: "2099-01-01T09:00", endsAt: "" }),
      { id },
    );
    const after = await row(id);
    expect(after.status).toBe("scheduled");
    expect(after.startsAt!.toISOString()).toBe("2099-01-01T12:00:00.000Z");
    expect(republishIfActive).toHaveBeenCalledWith(expect.anything(), shopId, "route-shop.myshopify.com", id, true);
  });

  it("detail update without date fields keeps the stored dates and adopts the shop timezone", async () => {
    const startsAt = new Date("2030-05-05T15:00:00.000Z");
    const id = await seedOffer(db, shopId, { status: "scheduled", timezone: null, startsAt });
    await run(detail.action, post(`/app/offers/${id}`, { intent: "update", internalName: "n2", publicTitle: "t2" }), { id });
    const after = await row(id);
    expect(after.startsAt!.toISOString()).toBe(startsAt.toISOString());
    expect(after.status).toBe("scheduled");
    expect(after.timezone).toBe(ART);
  });

  it("detail loader prefills wall-clock time in the effective timezone", async () => {
    const id = await seedOffer(db, shopId, { timezone: null, startsAt: new Date("2030-05-05T15:00:00.000Z") });
    const data = (await run(detail.loader, new Request("http://localhost/"), { id })) as {
      offer: { startsAtLocal: string; endsAtLocal: string; timezone: string };
    };
    expect(data.offer).toMatchObject({ startsAtLocal: "2030-05-05T12:00", endsAtLocal: "", timezone: ART });
  });
});

describe("new offers carry the shop timezone", () => {
  it("quick create", async () => {
    await run(quickCreate.action, post("/app/offers/new", { offerType: "gift", internalName: "qc-tz", publicTitle: "QC" })).catch((r) => r);
    const [created] = await db.select().from(offers).where(eq(offers.internalName, "qc-tz"));
    expect(created!.timezone).toBe(ART);
  });

  it("CSV import", async () => {
    await run(csvImport.action, post("/app/offers/import", { csvContent: "internal_name,public_title,type\ncsv-tz,CSV,gift\n" }));
    const [created] = await db.select().from(offers).where(eq(offers.internalName, "csv-tz"));
    expect(created!.timezone).toBe(ART);
  });

  it("legacy presets", async () => {
    await db.transaction((tx) =>
      insertPresetOffer(tx, shopId, {
        key: "k", type: "gift", internalName: "preset-tz", publicTitle: "P", description: "d", priority: 1,
        conditions: [], rewards: [],
      } as never).catch(() => undefined),
    );
    const [created] = await db.select().from(offers).where(eq(offers.internalName, "preset-tz"));
    expect(created!.timezone).toBe(ART);
  });
});

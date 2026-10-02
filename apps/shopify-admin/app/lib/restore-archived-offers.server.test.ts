import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offers, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

vi.mock("./offer-publish-flow.server.js", () => ({
  publishShopConfig: vi.fn(),
  validateOffersPublishable: vi.fn(),
}));
vi.mock("./proxy-shop.server.js", () => ({ invalidateShopCache: async () => undefined }));
vi.mock("./offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));

const { recordUninstallArchive, getRestorableOffers, restoreArchivedOffers, dismissRestorableOffers } = await import(
  "./restore-archived-offers.server.js"
);

let db: Db;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function reinstalledShop() {
  counter += 1;
  const domain = `restore-${counter}.myshopify.com`;
  return { shopId: await seedShop(db, domain), domain };
}
const statusOf = async (offerId: string) =>
  (await db.select({ status: offers.status }).from(offers).where(eq(offers.id, offerId)))[0]!.status;
const ok = async () => ({ ok: true as const });

describe("getRestorableOffers", () => {
  it("is 0 when nothing was archived by an uninstall", async () => {
    const { shopId } = await reinstalledShop();
    expect(await getRestorableOffers(db, shopId)).toEqual({ count: 0 });
  });

  it("counts only offers that are still archived", async () => {
    const { shopId } = await reinstalledShop();
    const stillArchived = await seedOffer(db, shopId, { status: "archived" });
    const alreadyBack = await seedOffer(db, shopId, { status: "active" });
    await recordUninstallArchive(db, shopId, [stillArchived, alreadyBack]);
    expect(await getRestorableOffers(db, shopId)).toEqual({ count: 1 });
  });
});

describe("restoreArchivedOffers", () => {
  it("restores exactly the uninstall-archived offers and republishes once", async () => {
    const { shopId, domain } = await reinstalledShop();
    const a = await seedOffer(db, shopId, { status: "archived", archivedAt: new Date() });
    const b = await seedOffer(db, shopId, { status: "archived", archivedAt: new Date() });
    const merchantArchived = await seedOffer(db, shopId, { status: "archived", archivedAt: new Date() });
    await recordUninstallArchive(db, shopId, [a, b]);
    const publish = vi.fn(async () => null);

    const result = await restoreArchivedOffers({ db, shopId, shopDomain: domain }, { publish, validate: ok });

    expect(result).toEqual({ restored: 2, failed: 0 });
    expect(await statusOf(a)).toBe("active");
    expect(await statusOf(b)).toBe("active");
    expect(await statusOf(merchantArchived)).toBe("archived");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(shopId, domain);
    const [restored] = await db.select().from(offers).where(eq(offers.id, a));
    expect(restored!.archivedAt).toBeNull();
    // Done: the banner goes away.
    expect(await getRestorableOffers(db, shopId)).toEqual({ count: 0 });
  });

  it("leaves an offer that no longer validates archived and counts it as failed", async () => {
    const { shopId, domain } = await reinstalledShop();
    const good = await seedOffer(db, shopId, { status: "archived" });
    const bad = await seedOffer(db, shopId, { status: "archived" });
    await recordUninstallArchive(db, shopId, [good, bad]);
    const validate = vi.fn(async (_db: Db, _shopId: string, ids: string[]) =>
      ids[0] === bad ? { ok: false, error: "Add a reward." } : { ok: true },
    );

    const result = await restoreArchivedOffers(
      { db, shopId, shopDomain: domain },
      { publish: async () => null, validate: validate as never },
    );

    expect(result).toEqual({ restored: 1, failed: 1 });
    expect(await statusOf(good)).toBe("active");
    expect(await statusOf(bad)).toBe("archived");
  });

  it("counts an offer whose checkout code a live offer took meanwhile as failed, without touching the live one", async () => {
    const { shopId, domain } = await reinstalledShop();
    const archived = await seedOffer(db, shopId, { status: "archived", requiredDiscountCode: "TAKEN-CODE" });
    const live = await seedOffer(db, shopId, { status: "active", requiredDiscountCode: "TAKEN-CODE" });
    await recordUninstallArchive(db, shopId, [archived]);

    const result = await restoreArchivedOffers(
      { db, shopId, shopDomain: domain },
      { publish: async () => null, validate: ok },
    );

    expect(result).toEqual({ restored: 0, failed: 1 });
    expect(await statusOf(archived)).toBe("archived");
    expect(await statusOf(live)).toBe("active");
  });

  it("puts everything back and throws the Shopify error when the republish fails", async () => {
    const { shopId, domain } = await reinstalledShop();
    const a = await seedOffer(db, shopId, { status: "archived" });
    await recordUninstallArchive(db, shopId, [a]);
    const publish = vi.fn(async () => "Shopify rejected the config");

    await expect(restoreArchivedOffers({ db, shopId, shopDomain: domain }, { publish, validate: ok })).rejects.toThrow(
      "Shopify rejected the config",
    );

    expect(await statusOf(a)).toBe("archived");
    // Rolled back and republished, so the discount nodes don't keep the offer's config.
    expect(publish).toHaveBeenCalledTimes(2);
    // Still restorable once the problem is fixed.
    expect(await getRestorableOffers(db, shopId)).toEqual({ count: 1 });
  });

  it("does nothing when there is nothing to restore", async () => {
    const { shopId, domain } = await reinstalledShop();
    const publish = vi.fn(async () => null);
    expect(await restoreArchivedOffers({ db, shopId, shopDomain: domain }, { publish, validate: ok })).toEqual({
      restored: 0,
      failed: 0,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("dismissing hides the banner without restoring anything", async () => {
    const { shopId } = await reinstalledShop();
    const a = await seedOffer(db, shopId, { status: "archived" });
    await recordUninstallArchive(db, shopId, [a]);
    await dismissRestorableOffers(db, shopId);
    expect(await getRestorableOffers(db, shopId)).toEqual({ count: 0 });
    expect(await statusOf(a)).toBe("archived");
  });
});

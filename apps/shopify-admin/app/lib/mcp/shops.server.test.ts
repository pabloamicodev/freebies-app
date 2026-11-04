import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appSettings, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../test-support/pglite-db.js";
import { listShopWriteModes, resolveWriteModes, setShopWriteMode, WRITE_MODE_SETTING_KEY } from "./shops.server.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("setShopWriteMode / listShopWriteModes", () => {
  it("upserts by domain or handle, one row per shop, and the resolver honors it", async () => {
    const id = await seedShop(db, "wm-a.myshopify.com");
    await seedShop(db, "wm-b.myshopify.com");
    expect(await setShopWriteMode(db, "wm-a", "write")).toEqual({ myshopifyDomain: "wm-a.myshopify.com", mode: "write" });
    const shop = { id, myshopifyDomain: "wm-a.myshopify.com", timezone: "UTC", currencyCode: "USD" };
    const env = { MCP_WRITE_SHOPS: "wm-a.myshopify.com" } as NodeJS.ProcessEnv;
    expect((await resolveWriteModes(db, [shop], env)).get(id)).toBe("write");
    expect((await resolveWriteModes(db, [shop], {} as NodeJS.ProcessEnv)).get(id)).toBe("read_only");

    await setShopWriteMode(db, "WM-A.myshopify.com", "read_only");
    const rows = await db.select().from(appSettings).where(and(eq(appSettings.shopId, id), eq(appSettings.key, WRITE_MODE_SETTING_KEY)));
    expect(rows.map((r) => r.value)).toEqual(['"read_only"']);
    expect((await resolveWriteModes(db, [shop], env)).get(id)).toBe("read_only");

    await setShopWriteMode(db, "wm-b", "write");
    const listed = (await listShopWriteModes(db)).filter((r) => r.myshopifyDomain.startsWith("wm-"));
    expect(listed).toEqual([
      { myshopifyDomain: "wm-a.myshopify.com", mode: "read_only" },
      { myshopifyDomain: "wm-b.myshopify.com", mode: "write" },
    ]);
  });

  it("errors for an unknown shop", async () => {
    await expect(setShopWriteMode(db, "nope", "write")).rejects.toThrow(/no such shop/);
  });
});

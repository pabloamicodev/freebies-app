import type * as RedisModule from "./redis.server.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { capacityIncidents, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { recordCapacityIncident } from "./capacity-incidents.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "", shopDomain: "route-a.myshopify.com" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({ db: ctx.db, shopId: ctx.shopId, shopDomain: ctx.shopDomain, timezone: "UTC", currencyCode: "USD", session: { shop: ctx.shopDomain } }),
}));
vi.mock("../shopify.server.js", () => ({ authenticate: { admin: async () => ({ session: { shop: ctx.shopDomain } }) } }));
vi.mock("@promo/db", async (importOriginal) => ({ ...(await importOriginal<typeof PromoDb>()), getDb: () => ctx.db }));
vi.mock("./redis.server.js", async (importOriginal) => ({ ...(await importOriginal<typeof RedisModule>()), redisDelete: vi.fn(async () => undefined) }));

const route = await import("../routes/app.capacity-incidents.js");

let db: Db;
let close: () => Promise<void>;
let shopA: string;
let shopB: string;
let incidentA: string;
let incidentB: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopA = await seedShop(db, "route-a.myshopify.com");
  shopB = await seedShop(db, "route-b.myshopify.com");
  ctx.shopId = shopA;
  const offerA = await seedOffer(db, shopA, { internalName: "a", status: "paused" });
  const offerB = await seedOffer(db, shopB, { internalName: "b", status: "paused" });
  await recordCapacityIncident(db, { shopId: shopA, code: "OFFER_TOO_LARGE", offerIds: [offerA], numbers: { bytes: 20000 }, splitRefusal: "STILL_TOO_LARGE" }, { source: "cron", attended: false });
  await recordCapacityIncident(db, { shopId: shopB, code: "OFFER_TOO_LARGE", offerIds: [offerB], numbers: { bytes: 20000 }, splitRefusal: "STILL_TOO_LARGE" }, { source: "cron", attended: false });
  incidentA = (await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopA)))[0]!.id;
  incidentB = (await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopB)))[0]!.id;
}, 60_000);
afterAll(async () => {
  await close();
});

const load = (search = "") => route.loader({ request: new Request(`http://localhost/app/capacity-incidents${search}`), params: {}, context: {} } as never) as Promise<Record<string, unknown>>;
const post = (body: Record<string, string>) =>
  route.action({ request: new Request("http://localhost/app/capacity-incidents", { method: "POST", body: new URLSearchParams(body) }), params: {}, context: {} } as never);

describe("loader", () => {
  it("returns only the session shop's incidents, with the plain-language copy", async () => {
    const data = (await load()) as { incidents: Array<{ incidentId: string; title: string; offers: Array<{ name: string }> }> };
    expect(data.incidents.map((i) => i.incidentId)).toEqual([incidentA]);
    expect(data.incidents[0]?.title).toBeTruthy();
    expect(data.incidents[0]?.offers.map((o) => o.name)).toEqual(["a"]);
  });

  it("another shop's incident id yields nothing, and its discounts list is a 404", async () => {
    expect(((await load(`?incident=${incidentB}`)) as { incidents: unknown[] }).incidents).toEqual([]);
    await expect(load(`?incident=${incidentB}&discounts=1`)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects malformed query parameters with a 400", async () => {
    await expect(load("?incident=not-a-uuid")).rejects.toMatchObject({ status: 400 });
    await expect(load("?discounts=2")).rejects.toMatchObject({ status: 400 });
  });
});

describe("action", () => {
  it("validates the payload at the boundary", async () => {
    const bodies: Array<Record<string, string>> = [{}, { intent: "nope" }, { intent: "apply", incidentId: "x", kind: "use_whole_products" }, { intent: "apply", incidentId: incidentA, kind: "rm_rf" }, { intent: "undo", actionId: "1" }, { intent: "apply", incidentId: incidentA, kind: "use_whole_products", expectedVersions: "[1]" }];
    for (const body of bodies) {
      expect(await post(body)).toMatchObject({ ok: false, code: "refused", message: "That request was not valid." });
    }
  });

  it("cannot apply, dismiss or undo another shop's incident or action", async () => {
    expect(await post({ intent: "apply", incidentId: incidentB, kind: "use_whole_products", confirm: "true", expectedVersions: "{}" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await post({ intent: "dismiss", incidentId: incidentB })).toMatchObject({ ok: false, code: "not_found" });
    expect(await post({ intent: "undo", actionId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false, code: "not_found" });
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, incidentB)))[0]?.status).toBe("open");
  });

  it("snoozes only the session shop's incidents and dismisses one of its own", async () => {
    expect(await post({ intent: "snooze" })).toMatchObject({ ok: true });
    const [a] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, incidentA));
    const [b] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, incidentB));
    expect(a?.snoozedUntil).not.toBeNull();
    expect(b?.snoozedUntil).toBeNull();
    expect(await post({ intent: "dismiss", incidentId: incidentA })).toMatchObject({ ok: true });
    expect((await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, incidentA)))[0]?.status).toBe("dismissed");
  });

  it("answers an apply that has no matching proposal with the stale message, not an error", async () => {
    await db.update(capacityIncidents).set({ status: "open" }).where(eq(capacityIncidents.id, incidentA));
    expect(await post({ intent: "apply", incidentId: incidentA, kind: "use_whole_products", confirm: "true", expectedVersions: "{}" })).toMatchObject({ ok: false, code: "stale", message: "The offer changed; review the proposal again." });
  });
});

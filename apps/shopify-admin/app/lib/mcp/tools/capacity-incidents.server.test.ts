import type * as RedisModule from "../../redis.server.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { capacityActions, capacityIncidents, mcpOperators, offerRewards, offers, variantCache, type CapacityIncident, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { preflightCapacity, type CapacityOptions } from "../../capacity-preflight.server.js";
import { recordCapacityIncident, snapshotHeldOffers } from "../../capacity-incidents.server.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { DiscountOps } from "../../capacity-apply.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerCapacityTools } from "./register-capacity.server.js";

vi.mock("../../redis.server.js", async (importOriginal) => ({ ...(await importOriginal<typeof RedisModule>()), redisDelete: vi.fn(async () => undefined) }));

let db: Db;
let close: () => Promise<void>;
let operator: Operator;
let clock = Date.now();
let publish = vi.fn<ShopPublishFn>(async () => null);

const budget = (maxCartSlots: number) => ({ storeActive: 5, ours: 2, others: 3, maxCartSlots });
const cap = (maxCartSlots = 11): CapacityOptions => ({ shardsEnabled: true, loadBudget: async () => budget(maxCartSlots) });
const unlimited = async () => ({ ok: true as const });

let seq = 0;
const gid = (kind: string) => `gid://shopify/${kind}/${++seq + 60_000_000_000}`;

async function seedVariants(shopId: string, products: number, perProduct: number) {
  const out: Array<{ product: string; variants: string[] }> = [];
  for (let p = 0; p < products; p++) {
    const product = gid("Product");
    const variants: string[] = [];
    for (let v = 0; v < perProduct; v++) {
      const variantGid = gid("ProductVariant");
      variants.push(variantGid);
      await db.insert(variantCache).values({ shopId, productGid: product, variantGid, title: `V${seq}`, price: "10", currencyCode: "USD", raw: {} });
    }
    out.push({ product, variants });
  }
  return out;
}

async function giftOffer(shopId: string, name: string, count: number, overrides: Parameters<typeof seedOffer>[2] = {}) {
  const offerId = await seedOffer(db, shopId, { internalName: name, ...overrides });
  await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_gift", discountType: "free", value: {}, target: { variantIds: Array.from({ length: count }, () => gid("ProductVariant")) }, quantity: 1, sortOrder: 0 });
  return offerId;
}

async function incidentFrom(shopId: string, offerIds: string[], opts: CapacityOptions = cap()): Promise<CapacityIncident> {
  const result = await preflightCapacity(db, shopId, offerIds, opts);
  if (result.ok) throw new Error("expected a capacity block");
  await recordCapacityIncident(db, { shopId, code: result.code, offerIds: result.offerIds, numbers: result.numbers, ...(result.splitRefusal ? { splitRefusal: result.splitRefusal } : {}), held: await snapshotHeldOffers(db, shopId, offerIds) }, { source: "cron", attended: false });
  const rows = await db.select().from(capacityIncidents).where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.status, "open")));
  return rows.find((row) => row.code === result.code)!;
}

/** A paused offer holding 450 variants (too big for one node) with a "use whole products" fix. */
async function wholeProductsFixture(domain: string) {
  const shopId = await seedShop(db, domain);
  const products = await seedVariants(shopId, 3, 150);
  const offerId = await seedOffer(db, shopId, { internalName: "sale", type: "discount", status: "paused" });
  await db.insert(offerRewards).values({
    shopId, offerId, rewardType: "product_discount", discountType: "percentage", value: { amount: 15, currencyCode: "USD" },
    target: { scopeMode: "sitewide", variantIds: products.flatMap((p) => p.variants), maxUnitsTotal: 5 }, sortOrder: 0,
  });
  const incident = await incidentFrom(shopId, [offerId]);
  return { shopId, domain, offerId, incident };
}

const nativeCandidates = Array.from({ length: 12 }, (_, i) => ({ id: `gid://shopify/DiscountAutomaticNode/${i + 1}`, title: `Other ${i + 1}`, type: "DiscountAutomaticBasic", appTitle: null, native: true }));
const otherApp = { id: "gid://shopify/DiscountAutomaticNode/777", title: "Nektar", type: "DiscountAutomaticApp", appTitle: "Nektar", native: false };
const setActive = vi.fn(async () => undefined);
const discounts: DiscountOps = { list: async () => [...nativeCandidates, otherApp], setActive };

type Out = { isError: boolean; sc: { code?: string; message?: string; summary?: string; data: Record<string, any>; warnings: { code: string }[]; details?: any } };
let client: Client;

async function connect(): Promise<void> {
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(clock), rateLimit: unlimited, publish };
  const server = new McpServer({ name: "promo-engine", version: "test" });
  registerCapacityTools(server, ctx, { capacity: cap(), discounts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "vitest", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
}
const call = async (name: string, args: Record<string, unknown>): Promise<Out> => {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, sc: result.structuredContent as Out["sc"] };
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  clock = Date.now();
  publish = vi.fn<ShopPublishFn>(async () => null);
  setActive.mockClear();
  resetMemoryRateLimits();
  await connect();
});

const offerStatus = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!.status;
const incidentRow = async (id: string) => (await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, id)))[0]!;

describe("capacity incidents over MCP", () => {
  it("registers the five incident tools and diagnostics_get; any operator role can call writes", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["capacity_incidents_list", "capacity_incident_apply", "capacity_incident_undo", "capacity_incident_dismiss", "capacity_incident_snooze", "diagnostics_get"]));
  });

  it("lists an open incident with the limit, numbers, affected offers and proposals with what changes for customers", async () => {
    const f = await wholeProductsFixture("cap-list.myshopify.com");
    const listed = await call("capacity_incidents_list", { shop: f.domain });
    expect(listed.isError).toBe(false);
    const [incident] = listed.sc.data["incidents"];
    expect(incident).toMatchObject({ incidentId: f.incident.id, status: "open", code: f.incident.code, affectedOffers: [{ id: f.offerId, name: "sale", status: "paused" }] });
    expect(incident.shopifyLimit.title).toBeTruthy();
    expect(Object.keys(incident.numbers).length).toBeGreaterThan(0);
    const whole = incident.proposals.find((p: { workaroundId: string }) => p.workaroundId === "use_whole_products");
    expect(whole).toMatchObject({ requiresConfirm: expect.any(Boolean), whatChangesForCustomers: expect.stringMatching(/\S/), offerVersions: expect.anything() });
    expect((await call("capacity_incidents_list", { shop: f.domain, status: "resolved" })).sc.data["incidents"]).toEqual([]);
    expect((await call("capacity_incidents_list", { shop: "nope.myshopify.com" })).sc.code).toBe("SHOP_NOT_FOUND");
  });

  it("dryRun previews without writing; apply publishes and resolves; undo reopens the incident", async () => {
    const f = await wholeProductsFixture("cap-roundtrip.myshopify.com");
    const args = { shop: f.domain, incidentId: f.incident.id, workaround: "use_whole_products", confirm: true };

    const dry = await call("capacity_incident_apply", { ...args, dryRun: true });
    expect(dry.isError).toBe(false);
    expect(dry.sc.summary).toMatch(/DRY RUN/);
    expect(dry.sc.data["offersTouched"]).toEqual([expect.objectContaining({ name: "sale" })]);
    expect(await offerStatus(f.offerId)).toBe("paused");
    expect(publish).not.toHaveBeenCalled();
    expect(await db.select().from(capacityActions).where(eq(capacityActions.incidentId, f.incident.id))).toHaveLength(0);

    const applied = await call("capacity_incident_apply", args);
    expect(applied.isError, JSON.stringify(applied.sc)).toBe(false);
    expect(applied.sc.data).toMatchObject({ ok: true, code: "applied", incidentStatus: "resolved", actionId: expect.anything() });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await offerStatus(f.offerId)).toBe("active");
    expect((await incidentRow(f.incident.id)).status).toBe("resolved");
    expect((await call("capacity_incidents_list", { shop: f.domain })).sc.data["incidents"]).toEqual([]);
    const resolved = (await call("capacity_incidents_list", { shop: f.domain, status: "resolved" })).sc.data;
    expect(resolved["incidents"][0].recentActions[0]).toMatchObject({ undoable: true, status: "applied" });
    expect(resolved["undoableActions"]).toHaveLength(1);

    const actionId = applied.sc.data["actionId"] as string;
    const undoDry = await call("capacity_incident_undo", { shop: f.domain, actionId, dryRun: true });
    expect(undoDry.sc.summary).toMatch(/DRY RUN/);
    expect(undoDry.sc.warnings).toEqual([]);
    const undone = await call("capacity_incident_undo", { shop: f.domain, actionId });
    expect(undone.isError, JSON.stringify(undone.sc)).toBe(false);
    expect(undone.sc.data).toMatchObject({ ok: true, code: "undone" });
    expect((await incidentRow(f.incident.id)).status).toBe("open");
    expect(await offerStatus(f.offerId)).toBe("paused");
    expect((await call("capacity_incidents_list", { shop: f.domain })).sc.data["incidents"]).toHaveLength(1);

    const again = await call("capacity_incident_undo", { shop: f.domain, actionId });
    expect(again.isError).toBe(true);
    expect(again.sc.code).toBe("INVALID_STATE");
  });

  it("refuses an undo after the 24 h window", async () => {
    const f = await wholeProductsFixture("cap-window.myshopify.com");
    const applied = await call("capacity_incident_apply", { shop: f.domain, incidentId: f.incident.id, workaround: "use_whole_products", confirm: true });
    expect(applied.isError).toBe(false);
    clock += 25 * 3_600_000;
    await connect();
    const actionId = applied.sc.data["actionId"] as string;
    const preview = await call("capacity_incident_undo", { shop: f.domain, actionId, dryRun: true });
    expect(preview.sc.warnings.map((w) => w.code)).toEqual(["UNDO_EXPIRED"]);
    const undone = await call("capacity_incident_undo", { shop: f.domain, actionId });
    expect(undone).toMatchObject({ isError: true, sc: { code: "INVALID_STATE" } });
    expect((await incidentRow(f.incident.id)).status).toBe("resolved");
  });

  it("a failed publish rolls back and reports PUBLISH_FAILED; a stale expectedVersions is STATE_CONFLICT", async () => {
    const f = await wholeProductsFixture("cap-fail.myshopify.com");
    const args = { shop: f.domain, incidentId: f.incident.id, workaround: "use_whole_products", confirm: true };
    expect(await call("capacity_incident_apply", { ...args, expectedVersions: { [f.offerId]: "2001-01-01T00:00:00.000Z" } })).toMatchObject({ isError: true, sc: { code: "STATE_CONFLICT" } });
    expect(await offerStatus(f.offerId)).toBe("paused");

    publish = vi.fn<ShopPublishFn>(async () => ({ message: "Shopify exploded", scope: "shop" as const }));
    await connect();
    const failed = await call("capacity_incident_apply", args);
    expect(failed).toMatchObject({ isError: true, sc: { code: "PUBLISH_FAILED" } });
    expect(await offerStatus(f.offerId)).toBe("paused");
    expect((await incidentRow(f.incident.id)).status).toBe("open");
  });

  it("dismiss and snooze: previews change nothing; execution moves the incident between the open, dismissed and snoozed lists", async () => {
    const f = await wholeProductsFixture("cap-dismiss.myshopify.com");
    const g = await wholeProductsFixture("cap-snooze.myshopify.com");

    const snoozeDry = await call("capacity_incident_snooze", { shop: g.domain, dryRun: true });
    expect(snoozeDry.sc.data["openIncidents"]).toBe(1);
    expect((await incidentRow(g.incident.id)).snoozedUntil).toBeNull();
    expect((await call("capacity_incident_snooze", { shop: g.domain })).isError).toBe(false);
    const snoozedUntil = (await incidentRow(g.incident.id)).snoozedUntil!;
    expect(snoozedUntil.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect((await call("capacity_incidents_list", { shop: g.domain })).sc.data["incidents"]).toEqual([]);
    expect((await call("capacity_incidents_list", { shop: g.domain, status: "snoozed" })).sc.data["incidents"]).toEqual([expect.objectContaining({ incidentId: g.incident.id, status: "snoozed" })]);
    expect((await call("capacity_incidents_list", { shop: f.domain })).sc.data["incidents"]).toHaveLength(1);

    expect((await call("capacity_incident_dismiss", { shop: f.domain, incidentId: f.incident.id, dryRun: true })).isError).toBe(false);
    expect((await incidentRow(f.incident.id)).status).toBe("open");
    expect((await call("capacity_incident_dismiss", { shop: f.domain, incidentId: f.incident.id })).isError).toBe(false);
    expect((await incidentRow(f.incident.id)).status).toBe("dismissed");
    expect((await call("capacity_incidents_list", { shop: f.domain })).sc.data["incidents"]).toEqual([]);
    expect((await call("capacity_incidents_list", { shop: f.domain, status: "dismissed" })).sc.data["incidents"]).toHaveLength(1);
    expect(await call("capacity_incident_dismiss", { shop: f.domain, incidentId: f.incident.id })).toMatchObject({ isError: true, sc: { code: "NOT_FOUND" } });
    expect(await call("capacity_incident_dismiss", { shop: f.domain, incidentId: g.incident.id })).toMatchObject({ isError: true });
  });

  it("deactivate_discounts only takes explicit native ids: another app's discount is refused and never touched", async () => {
    const shopId = await seedShop(db, "cap-discounts.myshopify.com");
    for (let i = 0; i < 8; i++) await giftOffer(shopId, `u-${i}`, 60, { priority: i });
    const tight = cap(2);
    const incident = await incidentFrom(shopId, [], tight);
    const mk = async (cfg: CapacityOptions) => {
      const server = new McpServer({ name: "promo-engine", version: "test" });
      registerCapacityTools(server, { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(clock), rateLimit: unlimited, publish }, { capacity: cfg, discounts });
      const [a, b] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "vitest", version: "1" });
      await Promise.all([server.connect(a), client.connect(b)]);
    };
    await mk(tight);

    const listed = await call("capacity_incidents_list", { shop: "cap-discounts.myshopify.com", includeDiscountCandidates: true });
    const proposal = listed.sc.data["incidents"][0].proposals.find((p: { workaroundId: string }) => p.workaroundId === "deactivate_discounts");
    expect(proposal.selection.items.map((i: { id: string }) => i.id)).not.toContain(otherApp.id);
    expect(proposal.selection.notSelectable).toEqual([expect.objectContaining({ id: otherApp.id })]);
    const needed = proposal.params["needed"] as number;

    const refused = await call("capacity_incident_apply", { shop: "cap-discounts.myshopify.com", incidentId: incident.id, workaround: "deactivate_discounts", confirm: true, selected: [otherApp.id, ...nativeCandidates.slice(0, needed - 1).map((c) => c.id)] });
    expect(refused).toMatchObject({ isError: true, sc: { code: "VALIDATION" } });
    expect(setActive).not.toHaveBeenCalled();

    const preview = await call("capacity_incident_apply", { shop: "cap-discounts.myshopify.com", incidentId: incident.id, workaround: "deactivate_discounts", selected: [], dryRun: true });
    expect(preview.sc.warnings.map((w) => w.code)).toContain("SELECTION_INVALID");
  });
});

describe("diagnostics_get", () => {
  it("returns the meter, config bytes, nodes, instruction estimate, combination domains and the capacity incidents", async () => {
    const f = await wholeProductsFixture("diag.myshopify.com");
    await seedOffer(db, f.shopId, { internalName: "live", status: "active" });
    const out = await call("diagnostics_get", { shop: f.domain });
    expect(out.isError, JSON.stringify(out.sc)).toBe(false);
    const data = out.sc.data;
    expect(data["health"]).toMatchObject({ activeOffers: 1, cachedProducts: 0, cachedVariants: 450, errorRate: "0" });
    expect(data["shopifyLimits"]).toMatchObject({ automaticDiscountCap: 25, storeActive: 5, ours: 2, others: 3, maxCartSlots: 11, shardsEnabled: false, level: "ok" });
    expect(data["config"]).toMatchObject({ metafieldLimitBytes: expect.any(Number), sharedConfigBytes: expect.any(Number), fullestNodePct: expect.any(Number) });
    expect(data["instructionEstimate"]).toMatchObject({ budgetPerNode: expect.any(Number), nodeFloor: expect.any(Number) });
    expect(data["nodes"]).toHaveProperty("planned");
    expect(data["combinationDomains"]).toMatchObject({ enabled: false });
    expect(data["transforms"].incidents).toEqual([expect.objectContaining({ id: f.incident.id, code: f.incident.code })]);
    expect(out.sc.warnings.map((w) => w.code)).toContain("OPEN_CAPACITY_INCIDENTS");
    expect(await call("diagnostics_get", { shop: "missing.myshopify.com" })).toMatchObject({ isError: true, sc: { code: "SHOP_NOT_FOUND" } });
  });
});

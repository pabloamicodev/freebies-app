import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditLogs, mcpOperators, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import { recordUninstallArchive } from "../../restore-archived-offers.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerPromoBulkTools } from "./register-promo-bulk.server.js";
import { promoDeleteTool, promoSetStatusTool, promosBulkTool, promosRestoreArchivedTool } from "./promo-bulk.server.js";

vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const SHOP = "bulk-test.myshopify.com";
const OTHER = "bulk-other.myshopify.com";
const ENV = { MCP_CONFIRM_SECRET: "x".repeat(40) } as unknown as NodeJS.ProcessEnv;

type Body = { code?: string; summary: string; data: Record<string, any>; warnings: { code: string }[]; meta: { dryRun?: boolean } };
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let shopId = "";
let otherId = "";
let operator: Operator;
let publish = vi.fn<ShopPublishFn>(async () => null);
const failing = () => vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
const ctx = (): McpContext => ({ db, env: ENV, operator, now: () => new Date(), rateLimit: async () => ({ ok: true as const }), publish });
const info = { requestId: "req-1", client: "vitest" };
const ref = (id: string, domain = SHOP) => `promo:${domain.replace(".myshopify.com", "")}:${id}`;

const status = (args: Record<string, unknown>) => promoSetStatusTool(ctx(), info, args as never);
const del = (args: Record<string, unknown>) => promoDeleteTool(ctx(), info, args as never);
const bulk = (args: Record<string, unknown>) => promosBulkTool(ctx(), info, args as never);
const restore = (args: Record<string, unknown>) => promosRestoreArchivedTool(ctx(), info, args as never);

const row = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0];
const statusOf = async (id: string) => (await row(id))?.status;

/** A draft that passes activation: one main condition and a reward. */
async function publishable(sid: string, overrides: Partial<typeof offers.$inferInsert> = {}) {
  const id = await seedOffer(db, sid, { internalName: `[bulk] ${Math.random().toString(36).slice(2, 8)}`, status: "draft", ...overrides });
  await db.insert(offerConditions).values({ shopId: sid, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({
    shopId: sid, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
    target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
  });
  return id;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, SHOP);
  otherId = await seedShop(db, OTHER);
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publish = vi.fn<ShopPublishFn>(async () => null);
  resetMemoryRateLimits();
});

describe("promo_set_status", () => {
  it("draft -> active publishes, writes the status and audits (a viewer operator can write)", async () => {
    const id = await publishable(shopId);
    const r = await status({ ref: ref(id), status: "active" });
    expect(r.isError).toBeFalsy();
    expect(body(r).data["statusBefore"]).toBe("draft");
    expect(["active", "scheduled"]).toContain(await statusOf(id));
    expect(publish).toHaveBeenCalledTimes(1);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.entityId, id)));
    expect(audit.length).toBeGreaterThan(0);
  });

  it("dryRun previews without writing or publishing", async () => {
    const id = await publishable(shopId);
    const r = await status({ ref: ref(id), status: "active", dryRun: true });
    expect(body(r).meta.dryRun).toBe(true);
    expect(await statusOf(id)).toBe("draft");
    expect(publish).not.toHaveBeenCalled();
  });

  it("draft without conditions or reward does not activate (VALIDATION)", async () => {
    const id = await seedOffer(db, shopId, { internalName: "[bulk] empty", status: "draft" });
    const r = await status({ ref: ref(id), status: "active" });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("VALIDATION");
    expect(await statusOf(id)).toBe("draft");
  });

  it("walks paused <-> active, live -> draft and any -> archived", async () => {
    const id = await publishable(shopId, { status: "active" });
    expect((await status({ ref: ref(id), status: "paused" })).isError).toBeFalsy();
    expect(await statusOf(id)).toBe("paused");
    expect((await status({ ref: ref(id), status: "active" })).isError).toBeFalsy();
    expect(["active", "scheduled"]).toContain(await statusOf(id));
    expect((await status({ ref: ref(id), status: "draft" })).isError).toBeFalsy();
    expect(await statusOf(id)).toBe("draft");
    expect((await status({ ref: ref(id), status: "archived" })).isError).toBeFalsy();
    expect(await statusOf(id)).toBe("archived");
    expect((await row(id))?.archivedAt).toBeTruthy();
  });

  it.each([
    ["active", "active"],
    ["paused", "paused"],
    ["draft", "draft"],
    ["archived", "active"],
    ["archived", "draft"],
    ["archived", "paused"],
    ["archived", "archived"],
    ["draft", "paused"],
  ] as const)("%s -> %s is INVALID_STATE and writes nothing", async (from, to) => {
    const id = await publishable(shopId, { status: from, archivedAt: from === "archived" ? new Date() : null });
    const r = await status({ ref: ref(id), status: to });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("INVALID_STATE");
    expect(await statusOf(id)).toBe(from);
    expect(publish).not.toHaveBeenCalled();
  });

  it("an expired offer cannot be activated", async () => {
    const id = await publishable(shopId, { status: "expired" });
    const r = await status({ ref: ref(id), status: "active" });
    expect(body(r).code).toBe("INVALID_STATE");
  });

  it("a failed publish rolls the status back (PUBLISH_FAILED)", async () => {
    const id = await publishable(shopId, { status: "paused" });
    publish = failing();
    const r = await status({ ref: ref(id), status: "active" });
    expect(body(r).code).toBe("PUBLISH_FAILED");
    expect(await statusOf(id)).toBe("paused");
  });

  it("live -> draft is rolled back when the publish fails", async () => {
    const id = await publishable(shopId, { status: "active" });
    publish = failing();
    const r = await status({ ref: ref(id), status: "draft" });
    expect(body(r).code).toBe("PUBLISH_FAILED");
    expect(await statusOf(id)).toBe("active");
  });

  it("a Shopify capacity block answers CAPACITY_LIMIT with the numbers and rolls back", async () => {
    const id = await publishable(shopId, { status: "paused" });
    publish = vi.fn<ShopPublishFn>(async () => ({
      message: "Config too large",
      scope: "shop",
      capacity: { code: "OFFER_TOO_LARGE" as const, offerIds: [id], numbers: { bytes: 11000, limit: 10000 } },
    }));
    const r = await status({ ref: ref(id), status: "active" });
    expect(body(r).code).toBe("CAPACITY_LIMIT");
    expect(JSON.stringify(r.structuredContent)).toContain("OFFER_TOO_LARGE");
    expect(await statusOf(id)).toBe("paused");
  });

  it("an unknown offer is NOT_FOUND", async () => {
    const r = await status({ ref: ref("00000000-0000-4000-8000-000000000000"), status: "paused" });
    expect(body(r).code).toBe("NOT_FOUND");
  });
});

describe("promo_delete", () => {
  it("deletes an active offer with its dependent rows and republishes", async () => {
    const id = await publishable(shopId, { status: "active" });
    const r = await del({ ref: ref(id) });
    expect(r.isError).toBeFalsy();
    expect(await row(id)).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await db.select().from(offerConditions).where(eq(offerConditions.offerId, id))).toHaveLength(0);
  });

  it("dryRun keeps the offer and says it is irreversible", async () => {
    const id = await publishable(shopId, { status: "active" });
    const r = await del({ ref: ref(id), dryRun: true });
    expect(body(r).data["reversible"]).toBe(false);
    expect(await row(id)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
  });

  it("a failed publish reports PUBLISH_FAILED but the offer is already gone", async () => {
    const id = await publishable(shopId, { status: "active" });
    publish = failing();
    const r = await del({ ref: ref(id) });
    expect(body(r).code).toBe("PUBLISH_FAILED");
    expect(await row(id)).toBeUndefined();
  });

  it("does not delete another shop's offer through a wrong shop, NOT_FOUND for it", async () => {
    const kept = await publishable(otherId);
    const wrong = await del({ ref: kept, shop: SHOP });
    expect(body(wrong).code).toBe("NOT_FOUND");
    expect(await row(kept)).toBeTruthy();
    expect(body(await del({ ref: ref("00000000-0000-4000-8000-000000000003") })).code).toBe("NOT_FOUND");
  });
});

describe("promos_bulk", () => {
  it("pause: reports the draft as invalid, pauses the live ones with ONE publish", async () => {
    const a = await publishable(shopId, { status: "active" });
    const b = await publishable(shopId, { status: "active" });
    const draft = await publishable(shopId);
    const r = await bulk({ action: "pause", refs: [ref(a), ref(draft), ref(b)] });
    expect(r.isError).toBeFalsy();
    const d = body(r).data;
    expect(d["succeeded"]).toBe(2);
    expect(d["failed"]).toBe(1);
    const failed = d["items"].find((i: any) => !i.ok);
    expect(failed.offerId).toBe(draft);
    expect(failed.error.code).toBe("invalid_state");
    expect(body(r).warnings.map((w) => w.code)).toContain("PARTIAL_FAILURE");
    expect(await statusOf(a)).toBe("paused");
    expect(await statusOf(b)).toBe("paused");
    expect(await statusOf(draft)).toBe("draft");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("one unknown offer does not abort the batch", async () => {
    const a = await publishable(shopId, { status: "active" });
    const r = await bulk({ action: "archive", refs: [ref("00000000-0000-4000-8000-000000000001"), ref(a)] });
    const items = body(r).data["items"];
    expect(items.find((i: any) => i.offerId === a).ok).toBe(true);
    expect(items.find((i: any) => !i.ok).error.code).toBe("not_found");
    expect(await statusOf(a)).toBe("archived");
  });

  it("archive rolls every archived offer back when the single publish fails", async () => {
    const a = await publishable(shopId, { status: "active" });
    const b = await publishable(shopId, { status: "paused" });
    publish = failing();
    const r = await bulk({ action: "archive", refs: [ref(a), ref(b)] });
    const d = body(r).data;
    expect(d["succeeded"]).toBe(0);
    expect(d["items"].every((i: any) => i.error.code === "publish_failed")).toBe(true);
    expect(await statusOf(a)).toBe("active");
    expect(await statusOf(b)).toBe("paused");
    expect((await row(a))?.archivedAt).toBeNull();
  });

  it("activate: paused resumes, draft publishes, a draft without conditions fails alone", async () => {
    const paused = await publishable(shopId, { status: "paused" });
    const draft = await publishable(shopId);
    const empty = await seedOffer(db, shopId, { internalName: "[bulk] nothing", status: "draft" });
    const r = await bulk({ action: "activate", refs: [ref(paused), ref(draft), ref(empty)] });
    const d = body(r).data;
    expect(d["succeeded"]).toBe(2);
    expect(d["failed"]).toBe(1);
    expect(["active", "scheduled"]).toContain(await statusOf(paused));
    expect(["active", "scheduled"]).toContain(await statusOf(draft));
    expect(await statusOf(empty)).toBe("draft");
  });

  it("delete: removes the eligible offers, republishes once, reports unknown ids", async () => {
    const a = await publishable(shopId, { status: "active" });
    const b = await publishable(shopId);
    const r = await bulk({ action: "delete", refs: [ref(a), ref(b), ref("00000000-0000-4000-8000-000000000002")] });
    expect(body(r).data["succeeded"]).toBe(2);
    expect(body(r).data["failed"]).toBe(1);
    expect(await row(a)).toBeUndefined();
    expect(await row(b)).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("duplicate: creates draft copies with unique names", async () => {
    const a = await publishable(shopId, { status: "active", internalName: "[bulk] dup source" });
    const r = await bulk({ action: "duplicate", refs: [ref(a)] });
    const item = body(r).data["items"][0];
    expect(item.ok).toBe(true);
    const copy = await row(item.newOfferId);
    expect(copy?.status).toBe("draft");
    expect(copy?.internalName).toContain("dup source");
    const again = await bulk({ action: "duplicate", refs: [ref(a)] });
    expect((await row(body(again).data["items"][0].newOfferId))?.internalName).not.toBe(copy?.internalName);
    expect(publish).not.toHaveBeenCalled();
  });

  it("dryRun reports per-item outcomes and changes nothing", async () => {
    const a = await publishable(shopId, { status: "active" });
    const draft = await publishable(shopId);
    const r = await bulk({ action: "pause", refs: [ref(a), ref(draft)], dryRun: true });
    expect(body(r).meta.dryRun).toBe(true);
    expect(body(r).data["succeeded"]).toBe(1);
    expect(body(r).data["failed"]).toBe(1);
    expect(await statusOf(a)).toBe("active");
    expect(publish).not.toHaveBeenCalled();
  });

  it("filter selects within one shop; refs and filter together are rejected", async () => {
    const tag = `zz${Math.random().toString(36).slice(2, 7)}`;
    const a = await publishable(shopId, { status: "active", internalName: `[bulk] ${tag} one` });
    await publishable(shopId, { status: "active", internalName: `[bulk] other` });
    const r = await bulk({ action: "pause", shop: SHOP, filter: { query: tag, status: ["active"] } });
    expect(body(r).data["items"].map((i: any) => i.offerId)).toEqual([a]);
    expect(await statusOf(a)).toBe("paused");
    const both = await bulk({ action: "pause", shop: SHOP, refs: [ref(a)], filter: { query: tag } });
    expect(body(both).code).toBe("VALIDATION");
    const none = await bulk({ action: "pause", shop: SHOP, filter: { query: "no-such-offer-name" } });
    expect(body(none).code).toBe("NOT_FOUND");
  });

  it("works across shops in one call", async () => {
    const a = await publishable(shopId, { status: "active" });
    const b = await publishable(otherId, { status: "active" });
    const r = await bulk({ action: "pause", refs: [ref(a), ref(b, OTHER)] });
    expect(body(r).data["succeeded"]).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe("promos_restore_archived", () => {
  it("restores the uninstall-archived offers and republishes; invalid ones stay archived", async () => {
    const good = await publishable(shopId, { status: "archived", archivedAt: new Date() });
    const bad = await seedOffer(db, shopId, { internalName: "[bulk] restore bad", status: "archived", archivedAt: new Date() });
    await recordUninstallArchive(db, shopId, [good, bad]);
    const dry = await restore({ shop: SHOP, dryRun: true });
    expect(body(dry).data["restorable"]).toBe(2);
    expect(await statusOf(good)).toBe("archived");
    const r = await restore({ shop: SHOP });
    expect(body(r).data["restored"]).toBe(1);
    expect(body(r).data["failed"]).toBe(1);
    expect(["active", "scheduled"]).toContain(await statusOf(good));
    expect(await statusOf(bad)).toBe("archived");
    expect(publish).toHaveBeenCalled();
  });

  it("a failed publish restores nothing (PUBLISH_FAILED)", async () => {
    const good = await publishable(shopId, { status: "archived", archivedAt: new Date() });
    await recordUninstallArchive(db, shopId, [good]);
    publish = failing();
    const r = await restore({ shop: SHOP });
    expect(body(r).code).toBe("PUBLISH_FAILED");
    expect(await statusOf(good)).toBe("archived");
  });
});

describe("registration", () => {
  it("lists the four tools through a real MCP client", async () => {
    const server = new McpServer({ name: "t", version: "1" });
    registerPromoBulkTools(server, ctx());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["promo_delete", "promo_set_status", "promos_bulk", "promos_restore_archived"]);
    const id = await publishable(shopId, { status: "active" });
    const res = await client.callTool({ name: "promo_set_status", arguments: { ref: ref(id), status: "paused" } });
    expect(res.isError).toBeFalsy();
    expect(await statusOf(id)).toBe("paused");
    await client.close();
  });
});

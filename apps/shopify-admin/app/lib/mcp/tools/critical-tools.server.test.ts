import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  appSettings,
  auditLogs,
  discountCodeBatches,
  discountCodes,
  mcpCallLog,
  mcpOperators,
  offerConditions,
  offerRewards,
  offerVersions,
  offers,
  type Db,
} from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import { isLimitsEnforced } from "../../limits-enforced.server.js";
import type { Operator } from "../auth.server.js";
import { createMcpServer, type McpContext } from "../server.server.js";
import { redactArgs } from "../call-log.server.js";
import {
  codesCreateBatchTool,
  codesDeleteTool,
  maskCode,
  promoActivateDraftTool,
  promosPauseAllTool,
  shopSetLimitsEnforcedTool,
} from "./critical-tools.server.js";

vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const TEST = "hpn-test-store.myshopify.com";
const PAUSE = "pause-all-test.myshopify.com";
const LIMITS = "limits-test.myshopify.com";
const LIVE = "hpn.myshopify.com";
const SECRET = "x".repeat(40);
const ENV = {
  MCP_WRITE_SHOPS: `${TEST}, ${PAUSE}, ${LIMITS}`,
  MCP_CONFIRM_SECRET: SECRET,
  LIMITS_TOGGLE_SHOPS: LIMITS,
} as unknown as NodeJS.ProcessEnv;

type Body = {
  code?: string;
  message?: string;
  summary: string;
  data: Record<string, any>;
  meta: { confirmToken?: string; dryRun?: boolean };
  warnings: { code: string }[];
};
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
const now = () => new Date();
const shopIds: Record<string, string> = {};
const operators: Record<string, Operator> = {};
let publish = vi.fn<ShopPublishFn>(async () => null);
const unlimited = async () => ({ ok: true as const });
const failing = () => vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
const info = { requestId: "req-1", client: "vitest" };
const ctxFor = (op: Operator, extra: Partial<McpContext> = {}): McpContext => ({ db, env: ENV, operator: op, now, rateLimit: unlimited, publish, ...extra });

type Runner = (ctx: McpContext, args: any) => Promise<CallToolResult>;
const runners: Record<string, Runner> = {
  promos_pause_all: (c, a) => promosPauseAllTool(c, info, a),
  promo_activate_draft: (c, a) => promoActivateDraftTool(c, info, a),
  codes_create_batch: (c, a) => codesCreateBatchTool(c, info, a),
  codes_delete: (c, a) => codesDeleteTool(c, info, a),
  shop_set_limits_enforced: (c, a) => shopSetLimitsEnforcedTool(c, info, a),
};
const run = (tool: string, args: Record<string, unknown>, op = operators["admin"]!, extra: Partial<McpContext> = {}) =>
  runners[tool]!(ctxFor(op, extra), args);

async function twoStep(tool: string, args: Record<string, unknown>, op = operators["admin"]!, extra: Partial<McpContext> = {}) {
  const dry = await run(tool, args, op, extra);
  expect(dry.isError, JSON.stringify(dry.structuredContent)).toBeFalsy();
  const token = body(dry).meta.confirmToken!;
  expect(token).toBeTruthy();
  const done = await run(tool, { ...args, dryRun: false, confirmToken: token }, op, extra);
  return { dry, done, token };
}

const row = async (id: string) => (await db.select().from(offers).where(eq(offers.id, id)))[0]!;
const audits = (shopId: string, entityId: string) => db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.entityId, entityId)));
const ref = (domain: string, id: string) => `promo:${domain.replace(".myshopify.com", "")}:${id}`;

async function publishable(shopId: string, overrides: Partial<typeof offers.$inferInsert> = {}) {
  const id = await seedOffer(db, shopId, { internalName: `[MCP test] ${Math.random().toString(36).slice(2, 8)}`, ...overrides });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100 },
    target: { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1" },
  });
  return id;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const [key, domain] of [["test", TEST], ["pause", PAUSE], ["limits", LIMITS], ["live", LIVE]] as const) {
    shopIds[key] = await seedShop(db, domain);
    await db.insert(appSettings).values({ shopId: shopIds[key]!, key: "mcp.writeMode", value: JSON.stringify("write") });
  }
  for (const role of ["viewer", "editor", "admin"] as const) {
    const [op] = await db.insert(mcpOperators).values({ email: `${role}@example.com`, name: role, role, shopAllowList: ["*"] }).returning();
    operators[role] = { id: op!.id, email: op!.email, name: op!.name, role, shopAllowList: ["*"] };
  }
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publish = vi.fn<ShopPublishFn>(async () => null);
  resetMemoryRateLimits();
});

describe("guards shared by every critical tool", () => {
  const shop = (domain: string) => ({ shop: domain, reason: "guard test", enforced: true });
  it("editor and viewer are FORBIDDEN, and an admin on a non-write shop gets SHOP_READ_ONLY (dry run and execute)", async () => {
    const live = await seedOffer(db, shopIds["live"]!, { status: "active" });
    const draft = await seedOffer(db, shopIds["test"]!, { status: "draft" });
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ["promos_pause_all", { shop: TEST, reason: "guard test" }, { shop: LIVE, reason: "guard test" }],
      ["promo_activate_draft", { ref: ref(TEST, draft) }, { ref: ref(LIVE, live) }],
      ["codes_create_batch", { ref: ref(TEST, draft), count: 3 }, { ref: ref(LIVE, live), count: 3 }],
      ["codes_delete", { ref: ref(TEST, draft), batchId: "00000000-0000-4000-8000-000000000000" }, { ref: ref(LIVE, live), batchId: "00000000-0000-4000-8000-000000000000" }],
      ["shop_set_limits_enforced", shop(TEST), shop(LIVE)],
    ];
    for (const [tool, allowed, blocked] of cases) {
      for (const role of ["viewer", "editor"] as const) {
        expect(body(await run(tool, allowed, operators[role])).code, `${tool} ${role}`).toBe("FORBIDDEN_ROLE");
      }
      const dry = await run(tool, blocked);
      expect(body(dry).code, `${tool} dry`).toBe("SHOP_READ_ONLY");
      const exec = await run(tool, { ...blocked, dryRun: false, confirmToken: "a.b" });
      expect(body(exec).code, `${tool} exec`).toBe("SHOP_READ_ONLY");
    }
    expect((await row(live)).status).toBe("active");
  });

  it("executing without a token is CONFIRM_REQUIRED, a token is single use, and critical executions are rate limited", async () => {
    const id = await seedOffer(db, shopIds["pause"]!, { status: "active" });
    const args = { shop: PAUSE, reason: "token test" };
    expect(body(await run("promos_pause_all", { ...args, dryRun: false })).code).toBe("CONFIRM_REQUIRED");
    const { done, token } = await twoStep("promos_pause_all", args);
    expect(done.isError).toBeFalsy();
    expect((await row(id)).status).toBe("paused");
    expect(body(await run("promos_pause_all", { ...args, dryRun: false, confirmToken: token })).code).toBe("CONFIRM_INVALID");

    await db.update(offers).set({ status: "active" }).where(eq(offers.id, id));
    const dry = await run("promos_pause_all", args);
    const limited = await run("promos_pause_all", { ...args, dryRun: false, confirmToken: body(dry).meta.confirmToken }, operators["admin"], {
      rateLimit: async (key) => (key.includes(":critical:") ? { ok: false as const, retryAfterSeconds: 30 } : { ok: true as const }),
    });
    expect(body(limited).code).toBe("RATE_LIMITED");
    expect((await row(id)).status).toBe("active");
    await db.update(offers).set({ status: "paused" }).where(eq(offers.id, id));
  });
});

describe("promos_pause_all", () => {
  it("dry run lists the live offers, execute pauses only active and scheduled ones with one publish and an mcp audit", async () => {
    const shopId = shopIds["pause"]!;
    const a = await seedOffer(db, shopId, { status: "active" });
    const s = await seedOffer(db, shopId, { status: "scheduled" });
    const d = await seedOffer(db, shopId, { status: "draft" });
    const p = await seedOffer(db, shopId, { status: "paused" });
    const { dry, done } = await twoStep("promos_pause_all", { shop: PAUSE, reason: "incident pause" });
    expect(body(dry).summary).toMatch(/^DRY RUN/);
    expect(body(dry).data["count"]).toBe(2);
    expect((body(dry).data["offers"] as { promoRef: string }[]).map((o) => o.promoRef).sort()).toEqual([ref(PAUSE, a), ref(PAUSE, s)].sort());
    expect(done.isError).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    expect([(await row(a)).status, (await row(s)).status, (await row(d)).status, (await row(p)).status]).toEqual(["paused", "paused", "draft", "paused"]);
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.action, "bulk_pause")));
    const log = logs.find((l) => JSON.stringify(l.after).includes("incident pause"))!;
    expect(log.performedBy).toBe(`mcp:${operators["admin"]!.id}`);
    expect(JSON.stringify(log.after)).toContain(a);
  });

  it("a failed publish is PUBLISH_FAILED with every status restored", async () => {
    const shopId = shopIds["pause"]!;
    const a = await seedOffer(db, shopId, { status: "active" });
    const s = await seedOffer(db, shopId, { status: "scheduled" });
    const { done } = await twoStep("promos_pause_all", { shop: PAUSE, reason: "will fail" }, operators["admin"], { publish: failing() });
    expect(body(done).code).toBe("PUBLISH_FAILED");
    expect(body(done).message).toContain("rolled back");
    expect([(await row(a)).status, (await row(s)).status]).toEqual(["active", "scheduled"]);
    await db.update(offers).set({ status: "paused" }).where(eq(offers.shopId, shopId));
  });

  it("STATE_CONFLICT when the live set changed after the dry run; nothing live is a no-op", async () => {
    const shopId = shopIds["pause"]!;
    const a = await seedOffer(db, shopId, { status: "active" });
    const dry = await run("promos_pause_all", { shop: PAUSE, reason: "stale one" });
    await seedOffer(db, shopId, { status: "active", internalName: `late-${Math.random()}` });
    const done = await run("promos_pause_all", { shop: PAUSE, reason: "stale one", dryRun: false, confirmToken: body(dry).meta.confirmToken });
    expect(body(done).code).toBe("STATE_CONFLICT");
    expect((await row(a)).status).toBe("active");

    await db.update(offers).set({ status: "paused" }).where(eq(offers.shopId, shopId));
    const empty = await twoStep("promos_pause_all", { shop: PAUSE, reason: "nothing here" });
    expect(body(empty.dry).warnings.map((w) => w.code)).toContain("NOTHING_TO_PAUSE");
    expect(body(empty.done).data["count"]).toBe(0);
  });

  it("the same idempotencyKey replays the stored result without pausing or publishing again", async () => {
    const shopId = shopIds["pause"]!;
    const a = await seedOffer(db, shopId, { status: "active" });
    const args = { shop: PAUSE, reason: "idempotent", idempotencyKey: "idem-pause-all-1" };
    const first = await twoStep("promos_pause_all", args);
    expect(first.done.isError).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    await db.update(offers).set({ status: "active" }).where(eq(offers.id, a));
    const replay = await run("promos_pause_all", { ...args, dryRun: false, confirmToken: first.token });
    expect(body(replay).warnings.map((w) => w.code)).toContain("IDEMPOTENT_REPLAY");
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await row(a)).status).toBe("active");
    await db.update(offers).set({ status: "paused" }).where(eq(offers.shopId, shopId));
  });
});

describe("promo_activate_draft", () => {
  it("publishes a draft through the admin sequence: status, version snapshot and audit", async () => {
    const id = await publishable(shopIds["test"]!, { status: "draft" });
    const { dry, done } = await twoStep("promo_activate_draft", { ref: ref(TEST, id) });
    expect(body(dry).data).toMatchObject({ statusBefore: "draft", statusAfter: "active" });
    expect(done.isError).toBeFalsy();
    expect((await row(id)).status).toBe("active");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await db.select().from(offerVersions).where(eq(offerVersions.offerId, id))).toHaveLength(1);
    const [log] = await audits(shopIds["test"]!, id);
    expect(log).toMatchObject({ action: "publish", performedBy: `mcp:${operators["admin"]!.id}` });
  });

  it("a future start date makes it scheduled", async () => {
    const id = await publishable(shopIds["test"]!, { status: "draft", startsAt: new Date(Date.now() + 7 * 86_400_000) });
    const { done } = await twoStep("promo_activate_draft", { ref: ref(TEST, id) });
    expect(body(done).data["statusAfter"]).toBe("scheduled");
  });

  it("a failed publish is PUBLISH_FAILED with the draft status restored and no version or audit row", async () => {
    const id = await publishable(shopIds["test"]!, { status: "draft" });
    const { done } = await twoStep("promo_activate_draft", { ref: ref(TEST, id) }, operators["admin"], { publish: failing() });
    expect(body(done).code).toBe("PUBLISH_FAILED");
    expect(body(done).message).toContain("rolled back");
    expect((await row(id)).status).toBe("draft");
    expect(await db.select().from(offerVersions).where(eq(offerVersions.offerId, id))).toHaveLength(0);
    expect(await audits(shopIds["test"]!, id)).toHaveLength(0);
  });

  it("refuses non-drafts and drafts without a condition or reward", async () => {
    const live = await publishable(shopIds["test"]!, { status: "active" });
    expect(body(await run("promo_activate_draft", { ref: ref(TEST, live) })).code).toBe("INVALID_STATE");
    const bare = await seedOffer(db, shopIds["test"]!, { status: "draft" });
    const res = await run("promo_activate_draft", { ref: ref(TEST, bare) });
    expect(body(res).code).toBe("VALIDATION");
    expect(body(res).message).toContain("main condition");
  });
});

describe("codes_create_batch", () => {
  it("creates the batch, never returns plaintext codes and logs only count and length", async () => {
    const id = await publishable(shopIds["test"]!, { status: "draft" });
    const args = { ref: ref(TEST, id), count: 25, prefix: "mcp-", length: 8 };
    const { dry, done } = await twoStep("codes_create_batch", args);
    expect(await db.select().from(discountCodes).where(eq(discountCodes.offerId, id))).toHaveLength(25);
    expect(body(dry).data["count"]).toBe(25);
    const stored = await db.select().from(discountCodes).where(eq(discountCodes.offerId, id));
    const text = JSON.stringify(done.structuredContent) + JSON.stringify(done.content) + JSON.stringify(dry.structuredContent);
    for (const c of stored) expect(text).not.toContain(c.code);
    const samples = body(done).data["maskedSamples"] as string[];
    expect(samples).toHaveLength(3);
    for (const s of samples) expect(s).toMatch(/^MCP-\*{8}$/);
    expect(body(done).data["created"]).toBe(25);
    expect((await row(id)).requiresCode).toBe(true);
    const logged = await db.select().from(mcpCallLog).where(eq(mcpCallLog.tool, "codes_create_batch"));
    const logText = JSON.stringify(logged.map((l) => [l.argsRedacted, l.resultRef]));
    for (const c of stored) expect(logText).not.toContain(c.code);
    expect(logged.some((l) => JSON.stringify(l.argsRedacted).includes("mcp-"))).toBe(false);
    expect(logged.some((l) => (l.argsRedacted as { count?: number }).count === 25 && (l.argsRedacted as { length?: number }).length === 8)).toBe(true);
    expect(redactArgs("codes_create_batch", { ref: "promo:a:b", count: 5, length: 8, prefix: "VIP-", code: "SECRET1" })).toEqual({
      ref: "promo:a:b", count: 5, length: 8, _omitted: ["code", "prefix"],
    });
  });

  it("rejects counts over 500, low-entropy specs and archived offers", async () => {
    const id = await publishable(shopIds["test"]!, { status: "draft" });
    const tooMany = await createMcpClient(operators["admin"]!);
    const res = await tooMany.callTool({ name: "codes_create_batch", arguments: { ref: ref(TEST, id), count: 501 } });
    expect(res.isError).toBe(true);
    const weak = await run("codes_create_batch", { ref: ref(TEST, id), count: 500, length: 4 });
    expect(body(weak).code).toBe("VALIDATION");
    const archived = await seedOffer(db, shopIds["test"]!, { status: "archived" });
    expect(body(await run("codes_create_batch", { ref: ref(TEST, archived), count: 3 })).code).toBe("INVALID_STATE");
    expect(await db.select().from(discountCodes).where(eq(discountCodes.offerId, id))).toHaveLength(0);
  });

  it("on a live offer a failed publish is PUBLISH_FAILED and the batch is removed", async () => {
    const id = await publishable(shopIds["test"]!, { status: "active" });
    const { done } = await twoStep("codes_create_batch", { ref: ref(TEST, id), count: 10 }, operators["admin"], { publish: failing() });
    expect(body(done).code).toBe("PUBLISH_FAILED");
    expect(await db.select().from(discountCodes).where(eq(discountCodes.offerId, id))).toHaveLength(0);
    expect(await db.select().from(discountCodeBatches).where(eq(discountCodeBatches.offerId, id))).toHaveLength(0);
    expect((await row(id)).requiresCode).toBe(false);
  });

  it("maskCode keeps only the prefix", () => {
    expect(maskCode("VIP-ABCD2345", "VIP-")).toBe("VIP-********");
    expect(maskCode("ABCD2345", "")).toBe("********");
  });
});

describe("codes_delete", () => {
  async function seedCodes() {
    const shopId = shopIds["test"]!;
    const offerId = await publishable(shopId, { status: "paused" });
    const [batch] = await db.insert(discountCodeBatches).values({ shopId, offerId, prefix: "D", length: 8, charset: "unambiguous", count: 4 }).returning();
    const mk = (code: string, extra: Partial<typeof discountCodes.$inferInsert> = {}) => ({ shopId, offerId, batchId: batch!.id, code: `${code}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, ...extra });
    const inserted = await db
      .insert(discountCodes)
      .values([mk("UNUSED"), mk("UNUSEDB"), mk("USED", { usageCount: 2 }), mk("SYNCED", { shopifySyncedAt: new Date() })])
      .returning({ id: discountCodes.id, usageCount: discountCodes.usageCount, syncedAt: discountCodes.shopifySyncedAt });
    return { shopId, offerId, batchId: batch!.id, inserted };
  }
  const left = async (offerId: string) => (await db.select().from(discountCodes).where(eq(discountCodes.offerId, offerId))).length;

  it("defaults to onlyUnused: used and still-on-Shopify codes survive; the dry run reports the counts", async () => {
    const { offerId, batchId } = await seedCodes();
    const { dry, done } = await twoStep("codes_delete", { ref: ref(TEST, offerId), batchId });
    expect(body(dry).data).toMatchObject({ matched: 4, deletable: 2, skippedUsed: 1, skippedOnShopify: 1 });
    expect(body(done).data["deleted"]).toBe(2);
    expect(await left(offerId)).toBe(2);
    const log = (await audits(shopIds["test"]!, offerId)).find((l) => l.action === "codes_delete")!;
    expect(log.performedBy).toBe(`mcp:${operators["admin"]!.id}`);
  });

  it("onlyUnused:false also deletes redeemed codes (with a warning) but never ones still on Shopify", async () => {
    const { offerId, batchId } = await seedCodes();
    const { dry, done } = await twoStep("codes_delete", { ref: ref(TEST, offerId), batchId, onlyUnused: false });
    expect(body(dry).warnings.map((w) => w.code)).toContain("DELETES_REDEEMED_CODES");
    expect(body(done).data["deleted"]).toBe(3);
    expect(await left(offerId)).toBe(1);
  });

  it("deletes by ids and refuses when nothing is deletable or both selectors are missing", async () => {
    const { offerId, inserted } = await seedCodes();
    const used = inserted.find((c) => c.usageCount > 0)!.id;
    const synced = inserted.find((c) => c.syncedAt)!.id;
    const refused = await run("codes_delete", { ref: ref(TEST, offerId), ids: [used, synced] });
    expect(body(refused).code).toBe("VALIDATION");
    expect(body(await run("codes_delete", { ref: ref(TEST, offerId) })).code).toBe("VALIDATION");
    const unused = inserted.filter((c) => c.usageCount === 0 && !c.syncedAt).map((c) => c.id);
    const { done } = await twoStep("codes_delete", { ref: ref(TEST, offerId), ids: unused });
    expect(body(done).data["deleted"]).toBe(2);
  });

  it("does not touch another offer's codes", async () => {
    const a = await seedCodes();
    const b = await seedCodes();
    const res = await run("codes_delete", { ref: ref(TEST, a.offerId), batchId: b.batchId });
    expect(body(res).code).toBe("NOT_FOUND");
    expect(await left(b.offerId)).toBe(4);
  });
});

describe("shop_set_limits_enforced", () => {
  it("is refused (VALIDATION) for a shop that is not in LIMITS_TOGGLE_SHOPS, even as an unlocked admin", async () => {
    const res = await run("shop_set_limits_enforced", { shop: TEST, enforced: true });
    expect(body(res).code).toBe("VALIDATION");
    expect(body(res).message).toContain("LIMITS_TOGGLE_SHOPS");
    expect(await isLimitsEnforced(db, shopIds["test"]!)).toBe(false);
  });

  it("dry run then execute flips the flag, republishes and audits; the same value again is a no-op", async () => {
    const { dry, done } = await twoStep("shop_set_limits_enforced", { shop: LIMITS, enforced: true });
    expect(body(dry).data).toMatchObject({ enforcedBefore: false, enforcedAfter: true });
    expect(body(dry).warnings.map((w) => w.code)).toContain("BACKFILL_NOT_VERIFIED");
    expect(done.isError).toBeFalsy();
    expect(await isLimitsEnforced(db, shopIds["limits"]!)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    const log = (await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopIds["limits"]!), eq(auditLogs.action, "limits_enforced_changed"))))[0]!;
    expect(log.performedBy).toBe(`mcp:${operators["admin"]!.id}`);

    const again = await twoStep("shop_set_limits_enforced", { shop: LIMITS, enforced: true });
    expect(body(again.done).data["changed"]).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("a failed publish is PUBLISH_FAILED and the flag goes back", async () => {
    expect(await isLimitsEnforced(db, shopIds["limits"]!)).toBe(true);
    const { done } = await twoStep("shop_set_limits_enforced", { shop: LIMITS, enforced: false }, operators["admin"], { publish: failing() });
    expect(body(done).code).toBe("PUBLISH_FAILED");
    expect(await isLimitsEnforced(db, shopIds["limits"]!)).toBe(true);
    const off = await twoStep("shop_set_limits_enforced", { shop: LIMITS, enforced: false });
    expect(off.done.isError).toBeFalsy();
    expect(await isLimitsEnforced(db, shopIds["limits"]!)).toBe(false);
  });
});

describe("registration", () => {
  it("lists the five critical tools as destructive, non-read-only", async () => {
    const client = await createMcpClient(operators["admin"]!);
    const { tools } = await client.listTools();
    for (const name of ["promos_pause_all", "promo_activate_draft", "codes_create_batch", "codes_delete", "shop_set_limits_enforced"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });
});

async function createMcpClient(op: Operator): Promise<Client> {
  const server = createMcpServer(ctxFor(op));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

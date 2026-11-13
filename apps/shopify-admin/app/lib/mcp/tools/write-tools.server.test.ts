import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  auditLogs,
  discountCodes,
  mcpCallLog,
  mcpCredentials,
  mcpOperators,
  offerConditions,
  offerRewards,
  offers,
  type Db,
} from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { deleteExpiredMcpCallState } from "../call-log-retention.server.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import * as lifecycle from "../../offer-lifecycle.server.js";
import type * as LifecycleModule from "../../offer-lifecycle.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import type { Operator } from "../auth.server.js";
import { createMcpServer, type McpContext } from "../server.server.js";
import { redactArgs } from "../call-log.server.js";
import { canonicalJson, hashArgs } from "../confirm.server.js";
import { lifecycleToolError } from "../write-runner.server.js";
import {
  codesSetStatusTool,
  createDraftFromTemplateTool,
  duplicateTool,
  republishShopTool,
  setPageExcludeUrlsTool,
  setScheduleTool,
  statusChange,
} from "./write-tools.server.js";

vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));
vi.mock("../../offer-lifecycle.server.js", async (importActual) => {
  const actual = await importActual<typeof LifecycleModule>();
  return { ...actual, setOfferSchedule: vi.fn(actual.setOfferSchedule) };
});

const TEST = "hpn-test-store.myshopify.com";
const SECOND = "second-test.myshopify.com";
const LIVE = "hpn.myshopify.com";
const ENV = {} as unknown as NodeJS.ProcessEnv;

type Body = {
  code?: string;
  message?: string;
  summary: string;
  data: Record<string, any>;
  meta: { confirmToken?: string; dryRun?: boolean };
  warnings: { code: string }[];
  nextActions: { tool: string; args: Record<string, unknown> }[];
};
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let clock = Date.now();
const now = () => new Date(clock);
const shopIds: Record<string, string> = {};
const operators: Record<string, Operator> = {};
let publish = vi.fn<ShopPublishFn>(async () => null);
const unlimited = async () => ({ ok: true as const });

const failing = () => vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
const ctxFor = (op: Operator, extra: Partial<McpContext> = {}): McpContext => ({ db, env: ENV, operator: op, now, rateLimit: unlimited, publish, ...extra });
const info = { requestId: "req-1", client: "vitest" };

type Runner = (ctx: McpContext, args: any) => Promise<CallToolResult>;
const runners: Record<string, Runner> = {
  promo_pause: (c, a) => statusChange(c, info, "promo_pause", a),
  promo_resume: (c, a) => statusChange(c, info, "promo_resume", a),
  promo_archive: (c, a) => statusChange(c, info, "promo_archive", a),
  promos_republish_shop: (c, a) => republishShopTool(c, info, a),
  promo_duplicate: (c, a) => duplicateTool(c, info, a),
  promo_create_draft_from_template: (c, a) => createDraftFromTemplateTool(c, info, a),
  promo_set_page_exclude_urls: (c, a) => setPageExcludeUrlsTool(c, info, a),
  promo_set_schedule: (c, a) => setScheduleTool(c, info, a),
  codes_set_status: (c, a) => codesSetStatusTool(c, info, a),
};
const run = (tool: string, args: Record<string, unknown>, op = operators["editor"]!, extra: Partial<McpContext> = {}) =>
  runners[tool]!(ctxFor(op, extra), args);

/** Optional preview (dryRun:true), then the direct execute: no token is involved. Returns both results. */
async function twoStep(tool: string, args: Record<string, unknown>, op = operators["editor"]!, extra: Partial<McpContext> = {}) {
  const dry = await run(tool, { ...args, dryRun: true }, op, extra);
  expect(dry.isError, JSON.stringify(dry.structuredContent)).toBeFalsy();
  expect(body(dry).meta.confirmToken).toBeUndefined();
  const done = await run(tool, args, op, extra);
  return { dry, done };
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
const withPageCondition = (shopId: string, offerId: string, value: Record<string, unknown> = { pageTypes: ["product", "home"] }) =>
  db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "page_types", operator: "in", value, sortOrder: 5, isEnabled: true });
const callLogs = (tool?: string) => db.select().from(mcpCallLog).where(tool ? eq(mcpCallLog.tool, tool) : undefined);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // No per-shop write lock exists any more: no env list and no mcp.writeMode setting is seeded anywhere.
  for (const [key, domain] of [["test", TEST], ["second", SECOND], ["live", LIVE]] as const) {
    shopIds[key] = await seedShop(db, domain);
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
  clock = Date.now();
  publish = vi.fn<ShopPublishFn>(async () => null);
  resetMemoryRateLimits();
});

describe("argument hashing (idempotency binding)", () => {
  it("ignores key order and the control fields, but not real arguments", () => {
    expect(hashArgs({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      hashArgs({ a: [2, { c: 2, d: 1 }], b: 1, idempotencyKey: "ignored", expectedUpdatedAt: "2026-11-01T00:00:00.000Z", dryRun: true, expectedDiffHash: "h" }),
    );
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
  });
});

describe("redactArgs", () => {
  it("keeps only allow-listed keys: free text, secrets, emails, phones and codes are dropped", () => {
    const out = redactArgs("promo_pause", {
      confirmToken: "abc.def", ref: "promo:a:b", reason: "call Jane on +34 600 123 456", q: "summer", name: "Secret launch",
      customerEmail: "jane@example.com", discountCode: "SUMMER-AAAA", shop: "jane@example.com", dryRun: false,
      idempotencyKey: "idem-key-0001", ids: ["x", "y"], excludeUrls: ["/a?e=jane@example.com"],
    }) as Record<string, unknown>;
    expect(out).toEqual({
      ref: "promo:a:b", shop: "[masked]", dryRun: false, idsCount: 2, excludeUrlsCount: 1,
      _omitted: ["confirmToken", "customerEmail", "discountCode", "name", "q", "reason"],
    });
    const text = JSON.stringify(out);
    for (const leaked of ["abc.def", "Jane", "600 123", "summer", "Secret launch", "jane@", "SUMMER-AAAA"]) expect(text).not.toContain(leaked);
  });

  it("read tools log their filters but not q or free text", () => {
    expect(redactArgs("promos_active", { shops: ["a"], status: ["active"], q: "vip customers", limit: 10 })).toEqual({
      shops: ["a"], status: ["active"], limit: 10, _omitted: ["q"],
    });
  });
});

describe("pause / resume / archive", () => {
  it("dryRun:true previews and changes nothing; executing without any token pauses, publishes once and audits as mcp:<operator>", async () => {
    const id = await seedOffer(db, shopIds["test"]!, { status: "active", internalName: "[MCP test] pause me" });
    const before = await row(id);
    const args = { ref: ref(TEST, id), reason: "testing the MCP" };
    const dry = await run("promo_pause", { ...args, dryRun: true });
    expect(body(dry).meta.dryRun).toBe(true);
    expect(body(dry).meta.confirmToken).toBeUndefined();
    expect(body(dry).data).toMatchObject({ statusBefore: "active", statusAfter: "paused", willPublish: true });
    expect(body(dry).summary).toContain("DRY RUN");
    expect((await row(id)).status).toBe("active");
    expect(publish).not.toHaveBeenCalled();
    expect(await audits(shopIds["test"]!, id)).toHaveLength(0);

    const done = await run("promo_pause", args);
    expect(done.isError).toBeFalsy();
    expect(body(done).meta.dryRun).toBe(false);
    expect(body(done).data).toMatchObject({ statusBefore: "active", statusAfter: "paused" });
    expect((await row(id)).status).toBe("paused");
    expect((await row(id)).updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime() - 1);
    expect(publish).toHaveBeenCalledTimes(1);
    const [entry] = await audits(shopIds["test"]!, id);
    expect(entry).toMatchObject({ action: "pause", performedBy: `mcp:${operators["editor"]!.id}` });
    expect(entry!.after).toMatchObject({ status: "paused", _mcp: { operator: operators["editor"]!.id, client: "vitest", tool: "promo_pause", requestId: "req-1", reason: "testing the MCP" } });
  });

  it("resume re-validates and archive archives", async () => {
    const paused = await publishable(shopIds["test"]!, { status: "paused" });
    const resumed = await twoStep("promo_resume", { ref: ref(TEST, paused) });
    expect(resumed.done.isError).toBeFalsy();
    expect((await row(paused)).status).toBe("active");

    const archived = await twoStep("promo_archive", { ref: ref(TEST, paused), reason: "cleanup" }, operators["admin"]);
    expect(archived.done.isError).toBeFalsy();
    expect((await row(paused)).status).toBe("archived");
    expect((await audits(shopIds["test"]!, paused)).map((a) => a.action).sort()).toEqual(["archive", "resume"]);
  });

  it("an invalid transition is INVALID_STATE", async () => {
    const id = await seedOffer(db, shopIds["test"]!, { status: "draft" });
    const res = await run("promo_pause", { ref: ref(TEST, id), reason: "nope nope" });
    expect(body(res).code).toBe("INVALID_STATE");
  });

  it("a failed publish is PUBLISH_FAILED with the status rolled back, for pause, resume and archive", async () => {
    const active = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const paused = await publishable(shopIds["test"]!, { status: "paused" });
    const keep = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const bad = failing();
    for (const [tool, id, args, status] of [
      ["promo_pause", active, { reason: "will fail" }, "active"],
      ["promo_resume", paused, {}, "paused"],
      ["promo_archive", keep, {}, "active"],
    ] as const) {
      const op = tool === "promo_archive" ? operators["admin"]! : operators["editor"]!;
      const { done } = await twoStep(tool, { ref: ref(TEST, id), ...args }, op, { publish: bad });
      expect(body(done).code, tool).toBe("PUBLISH_FAILED");
      expect(body(done).message).toContain("rolled back");
      expect((await row(id)).status).toBe(status);
      expect(await audits(shopIds["test"]!, id)).toHaveLength(0);
    }
  });
});

describe("no confirmation step", () => {
  async function fresh() {
    const id = await seedOffer(db, shopIds["test"]!, { status: "active" });
    return { id, args: { ref: ref(TEST, id), reason: "direct test" } };
  }

  it("executes immediately without dryRun or any token (no MCP_CONFIRM_SECRET exists)", async () => {
    const { id, args } = await fresh();
    const res = await run("promo_pause", args);
    expect(res.isError).toBeFalsy();
    expect(body(res).meta.dryRun).toBe(false);
    expect((await row(id)).status).toBe("paused");
  });

  it("dryRun:true never writes, and its apply nextAction carries the offer's updatedAt", async () => {
    const { id, args } = await fresh();
    const updatedAt = (await row(id)).updatedAt;
    const dry = await run("promo_pause", { ...args, dryRun: true });
    expect(body(dry).nextActions.at(-1)).toMatchObject({ tool: "promo_pause", args: { ref: args.ref, dryRun: false, expectedUpdatedAt: updatedAt.toISOString() } });
    expect((await row(id)).status).toBe("active");
    expect(publish).not.toHaveBeenCalled();
  });

  it("expectedUpdatedAt is optional optimistic concurrency: a stale value is STATE_CONFLICT, the current one applies", async () => {
    const { id, args } = await fresh();
    const seen = (await row(id)).updatedAt;
    await db.update(offers).set({ publicTitle: "edited by a merchant", updatedAt: new Date(seen.getTime() + 5_000) }).where(eq(offers.id, id));
    const stale = await run("promo_pause", { ...args, expectedUpdatedAt: seen.toISOString() });
    expect(body(stale).code).toBe("STATE_CONFLICT");
    expect((await row(id)).status).toBe("active");
    expect(publish).not.toHaveBeenCalled();
    const current = (await row(id)).updatedAt.toISOString();
    expect((await run("promo_pause", { ...args, expectedUpdatedAt: current })).isError).toBeFalsy();
    expect((await row(id)).status).toBe("paused");
  });

  it("a malformed expectedUpdatedAt is VALIDATION and nothing is written", async () => {
    const { id, args } = await fresh();
    expect(body(await run("promo_pause", { ...args, expectedUpdatedAt: "yesterday-ish" })).code).toBe("VALIDATION");
    expect((await row(id)).status).toBe("active");
  });
});

describe("full access: no write lock, no roles", () => {
  it("every role writes on every shop, with no per-shop setting or env list anywhere", async () => {
    for (const role of ["viewer", "editor", "admin"] as const) {
      const id = await seedOffer(db, shopIds["live"]!, { status: "active" });
      const res = await run("promo_pause", { ref: ref(LIVE, id), reason: `as ${role}` }, operators[role]);
      expect(res.isError, role).toBeFalsy();
      expect((await row(id)).status).toBe("paused");
      expect((await audits(shopIds["live"]!, id))[0]).toMatchObject({ performedBy: `mcp:${operators[role]!.id}` });
    }
  });

  it("a viewer runs every write tool, including archive and republish", async () => {
    const viewer = operators["viewer"]!;
    const id = await publishable(shopIds["test"]!, { status: "active" });
    await withPageCondition(shopIds["test"]!, id);
    const archiveMe = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const codes = await db.insert(discountCodes).values({ shopId: shopIds["test"]!, offerId: id, code: `V-${id.slice(0, 6)}` }).returning({ id: discountCodes.id });
    const calls: [string, Record<string, unknown>][] = [
      ["promo_set_page_exclude_urls", { ref: ref(TEST, id), excludeUrls: ["/viewer"] }],
      ["promo_set_schedule", { ref: ref(TEST, id), startsAt: "2020-01-01T00:00", endsAt: "2031-01-01T00:00" }],
      ["codes_set_status", { ref: ref(TEST, id), status: "disabled", ids: [codes[0]!.id] }],
      ["promo_duplicate", { ref: ref(TEST, id) }],
      ["promo_create_draft_from_template", { shop: TEST, templateId: id, name: "[MCP test] viewer draft" }],
      ["promos_republish_shop", { shop: LIVE }],
      ["promo_pause", { ref: ref(TEST, id), reason: "viewer pause" }],
      ["promo_resume", { ref: ref(TEST, id) }],
      ["promo_archive", { ref: ref(TEST, archiveMe) }],
    ];
    for (const [tool, args] of calls) {
      const res = await run(tool, args, viewer);
      expect(res.isError, `${tool}: ${JSON.stringify(res.structuredContent)}`).toBeFalsy();
    }
    expect((await row(archiveMe)).status).toBe("archived");
    expect(publish).toHaveBeenCalled();
  });

  it("no tool ever answers FORBIDDEN or SHOP_READ_ONLY", async () => {
    const id = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const args: Record<string, Record<string, unknown>> = {
      promo_pause: { ref: ref(TEST, id), reason: "viewer try" },
      promo_resume: { ref: ref(TEST, id) },
      promo_archive: { ref: ref(TEST, id) },
      promos_republish_shop: { shop: LIVE },
      promo_duplicate: { ref: ref(TEST, id) },
      promo_create_draft_from_template: { shop: TEST, templateId: id, name: "x" },
      promo_set_page_exclude_urls: { ref: ref(TEST, id), excludeUrls: [] },
      promo_set_schedule: { ref: ref(TEST, id), endsAt: null },
      codes_set_status: { ref: ref(TEST, id), status: "disabled", all: true },
    };
    for (const [tool, a] of Object.entries(args)) {
      const code = body(await run(tool, { ...a, dryRun: true }, operators["viewer"])).code;
      expect(["FORBIDDEN", "SHOP_READ_ONLY"], tool).not.toContain(code);
    }
    expect((await row(id)).status).toBe("active");
  });

  it("a shop outside the operator's allow list is still SHOP_NOT_FOUND (identity scoping stays)", async () => {
    const limited: Operator = { ...operators["editor"]!, shopAllowList: [SECOND] };
    const id = await seedOffer(db, shopIds["test"]!, { status: "active" });
    expect(body(await run("promo_pause", { ref: ref(TEST, id), reason: "not visible" }, limited)).code).toBe("SHOP_NOT_FOUND");
    expect((await row(id)).status).toBe("active");
  });
});

describe("lifecycleToolError and Shopify capacity", () => {
  const capacity = { code: "AUTOMATIC_DISCOUNT_LIMIT", offerIds: ["o1"], numbers: { needed: 1, storeActive: 25, others: 24 } };
  it("a capacity block is CAPACITY_LIMIT naming the cap and the workarounds, on validation and publish failures", () => {
    for (const failure of [
      { ok: false as const, code: "validation" as const, error: "Too many discounts", capacity },
      { ok: false as const, code: "publish_failed" as const, error: "Too many discounts", capacity, rolledBack: true as const, statusBefore: "draft", statusAfter: "draft" },
    ]) {
      const e = lifecycleToolError(failure as never, "promo:x:y");
      expect(e.payload.code).toBe("CAPACITY_LIMIT");
      expect(e.payload.details?.capacity).toEqual(capacity);
      expect(e.payload.details?.limit).toMatch(/25 active automatic discounts/);
      expect(e.payload.details?.workarounds?.map((w) => w.kind)).toEqual(["deactivate_discounts"]);
    }
    expect(lifecycleToolError({ ok: false, code: "validation", error: "plain" }).payload.code).toBe("VALIDATION");
  });

  it("promo_resume surfaces the capacity block from the publish flow as CAPACITY_LIMIT and rolls back", async () => {
    const paused = await publishable(shopIds["test"]!, { status: "paused" });
    const blocked = vi.fn<ShopPublishFn>(async () => ({ message: "Shopify allows 25 automatic discounts", scope: "shop", capacity }));
    const res = await run("promo_resume", { ref: ref(TEST, paused) }, operators["editor"], { publish: blocked });
    expect(body(res).code).toBe("CAPACITY_LIMIT");
    expect((res.structuredContent as { details: { workarounds: unknown[] } }).details.workarounds.length).toBeGreaterThan(0);
    expect((await row(paused)).status).toBe("paused");
  });
});

describe("promos_republish_shop", () => {
  it("previews the live offers and capacity, then republishes once and audits", async () => {
    const live = await publishable(shopIds["second"]!, { status: "active" });
    const { dry, done } = await twoStep("promos_republish_shop", { shop: SECOND }, operators["admin"]);
    expect(body(dry).data).toMatchObject({ shopDomain: SECOND, liveOffers: 1 });
    expect(body(dry).data["capacity"]).toMatchObject({ limit: 9500 });
    expect(done.isError).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    const log = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopIds["second"]!), eq(auditLogs.action, "republish_shop")));
    expect(log[0]).toMatchObject({ performedBy: `mcp:${operators["admin"]!.id}` });
    expect((await row(live)).status).toBe("active");
  });

  it("a failed publish is PUBLISH_FAILED", async () => {
    const { done } = await twoStep("promos_republish_shop", { shop: SECOND }, operators["admin"], { publish: failing() });
    expect(body(done).code).toBe("PUBLISH_FAILED");
  });
});

describe("promo_duplicate and promo_create_draft_from_template", () => {
  async function source(shopId = shopIds["test"]!) {
    const id = await publishable(shopId, { status: "active", internalName: "[MCP test] source" + Math.random().toString(36).slice(2, 6) });
    await db.insert(discountCodes).values({ shopId, offerId: id, code: `CODE-${id.slice(0, 8)}` });
    return id;
  }

  it("copies as a draft with a unique name, without codes, and audits", async () => {
    const id = await source();
    const name = (await row(id)).internalName;
    const first = await twoStep("promo_duplicate", { ref: ref(TEST, id) });
    const newId = body(first.done).data["offerId"] as string;
    expect(body(first.done).data["status"]).toBe("draft");
    const copy = await row(newId);
    expect(copy).toMatchObject({ status: "draft", internalName: `${name}-copy`, shopId: shopIds["test"] });
    expect(await db.select().from(offerConditions).where(eq(offerConditions.offerId, newId))).toHaveLength(1);
    expect(await db.select().from(offerRewards).where(eq(offerRewards.offerId, newId))).toHaveLength(1);
    expect(await db.select().from(discountCodes).where(eq(discountCodes.offerId, newId))).toHaveLength(0);
    expect((await audits(shopIds["test"]!, newId))[0]).toMatchObject({ action: "duplicate", performedBy: `mcp:${operators["editor"]!.id}` });
    expect(publish).not.toHaveBeenCalled();

    const second = await twoStep("promo_duplicate", { ref: ref(TEST, id) });
    expect((await row(body(second.done).data["offerId"] as string)).internalName).toBe(`${name}-copy (2)`);
    const named = await twoStep("promo_duplicate", { ref: ref(TEST, id), name: "[MCP test] custom" });
    expect((await row(body(named.done).data["offerId"] as string)).internalName).toBe("[MCP test] custom");
  });

  it("an unknown targetShop is SHOP_NOT_FOUND and targetShop equal to the source is a plain same-shop copy", async () => {
    const id = await source();
    expect(body(await run("promo_duplicate", { ref: ref(TEST, id), targetShop: "nowhere.myshopify.com" })).code).toBe("SHOP_NOT_FOUND");
    const same = await twoStep("promo_duplicate", { ref: ref(TEST, id), targetShop: TEST });
    expect((await row(body(same.done).data["offerId"] as string)).shopId).toBe(shopIds["test"]);
    expect(body(same.dry).data["resourceMapping"]).toBeUndefined();
  });

  it("an override that fails after the draft exists returns the draft with a warning, and an idempotent retry replays it", async () => {
    const id = await source();
    const args = { shop: TEST, templateId: id, name: "[MCP test] partial", overrides: { startsAt: "2031-03-01T10:00" }, idempotencyKey: "idem-partial-1" };
    // On a direct execute, call 1 is the override probe against the template (real, the default); call 2 is the override on the new draft (forced to fail).
    const real = vi.mocked(lifecycle.setOfferSchedule).getMockImplementation()!;
    vi.mocked(lifecycle.setOfferSchedule)
      .mockImplementationOnce(real)
      .mockResolvedValueOnce({ ok: false, code: "validation", error: "Override rejected" });
    const done = await run("promo_create_draft_from_template", args);
    expect(done.isError).toBeFalsy();
    const first = body(done);
    expect(first.warnings.map((w) => w.code)).toContain("OVERRIDE_FAILED");
    expect(first.data).toMatchObject({ status: "draft", overridesApplied: false });
    const drafts = async () => (await db.select().from(offers).where(eq(offers.internalName, "[MCP test] partial"))).length;
    expect(await drafts()).toBe(1);

    const replay = await run("promo_create_draft_from_template", args);
    expect(body(replay).warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["IDEMPOTENT_REPLAY", "OVERRIDE_FAILED"]));
    expect(body(replay).data["promoRef"]).toBe(first.data["promoRef"]);
    expect(await drafts()).toBe(1);
  });

  it("a source changed since the expectedUpdatedAt the preview returned is STATE_CONFLICT and nothing is created", async () => {
    const id = await source();
    const dry = await run("promo_duplicate", { ref: ref(TEST, id), dryRun: true });
    const seen = body(dry).nextActions.at(-1)!.args["expectedUpdatedAt"] as string;
    expect(seen).toBe((await row(id)).updatedAt.toISOString());
    await db.update(offers).set({ updatedAt: new Date(Date.now() + 9_000) }).where(eq(offers.id, id));
    const count = (await db.select().from(offers).where(eq(offers.shopId, shopIds["test"]!))).length;
    const res = await run("promo_duplicate", { ref: ref(TEST, id), expectedUpdatedAt: seen });
    expect(body(res).code).toBe("STATE_CONFLICT");
    expect((await db.select().from(offers).where(eq(offers.shopId, shopIds["test"]!))).length).toBe(count);
  });

  it("create_draft_from_template clones the template and applies validated overrides", async () => {
    const id = await source();
    await withPageCondition(shopIds["test"]!, id);
    const args = {
      shop: TEST,
      templateId: id,
      name: "[MCP test] from template",
      overrides: { startsAt: "2031-03-01T10:00", endsAt: "2031-04-01T10:00", excludeUrls: ["/products/skip-me"] },
    };
    const { dry, done } = await twoStep("promo_create_draft_from_template", args);
    expect(body(dry).data["resultingStatus"]).toBe("draft");
    const newId = body(done).data["offerId"] as string;
    const copy = await row(newId);
    expect(copy).toMatchObject({ status: "draft", internalName: "[MCP test] from template" });
    expect(copy.startsAt?.toISOString()).toBe("2031-03-01T10:00:00.000Z");
    const pages = (await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, newId), eq(offerConditions.conditionType, "page_types"))))[0]!;
    expect((pages.value as { excludeUrls: string[] }).excludeUrls).toEqual(["/products/skip-me"]);
    // The template itself is untouched.
    expect((await row(id)).startsAt).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it("an invalid override fails before anything is created, on a direct execute too", async () => {
    const id = await source();
    const before = (await db.select().from(offers).where(eq(offers.shopId, shopIds["test"]!))).length;
    const res = await run("promo_create_draft_from_template", {
      shop: TEST, templateId: ref(TEST, id), name: "[MCP test] bad", overrides: { startsAt: "2031-05-01T10:00", endsAt: "2031-04-01T10:00" },
    });
    expect(body(res).code).toBe("VALIDATION");
    expect((await db.select().from(offers).where(eq(offers.shopId, shopIds["test"]!))).length).toBe(before);
  });
});

describe("promo_set_page_exclude_urls", () => {
  it("previews before/after, applies on a live offer with one publish, audits, and reports the stored list", async () => {
    const id = await publishable(shopIds["test"]!, { status: "active" });
    await withPageCondition(shopIds["test"]!, id, { pageTypes: ["product", "home"], excludeUrls: ["/old"] });
    const { dry, done } = await twoStep("promo_set_page_exclude_urls", { ref: ref(TEST, id), excludeUrls: ["/products/a", "/products/b"] });
    expect(body(dry).data["before"]).toMatchObject({ excludeUrls: ["/old"] });
    expect(body(dry).data["after"]).toMatchObject({ excludeUrls: ["/products/a", "/products/b"] });
    expect(done.isError).toBeFalsy();
    const cond = (await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, id), eq(offerConditions.conditionType, "page_types"))))[0]!;
    expect((cond.value as { excludeUrls: string[] }).excludeUrls).toEqual(["/products/a", "/products/b"]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await audits(shopIds["test"]!, id))[0]).toMatchObject({ action: "set_page_urls", performedBy: `mcp:${operators["editor"]!.id}` });
  });

  it("an offer without a Store pages condition is INVALID_STATE; a failed publish is PUBLISH_FAILED", async () => {
    const bare = await publishable(shopIds["test"]!, { status: "draft" });
    expect(body(await run("promo_set_page_exclude_urls", { ref: ref(TEST, bare), excludeUrls: ["/x"] })).code).toBe("INVALID_STATE");
    const live = await publishable(shopIds["test"]!, { status: "active" });
    await withPageCondition(shopIds["test"]!, live);
    const { done } = await twoStep("promo_set_page_exclude_urls", { ref: ref(TEST, live), excludeUrls: ["/products/z"] }, operators["editor"], { publish: failing() });
    expect(body(done).code).toBe("PUBLISH_FAILED");
    expect(body(done).message).toContain("saved");
  });
});

describe("promo_set_schedule", () => {
  it("reschedules in the shop timezone and republishes a live offer", async () => {
    const id = await publishable(shopIds["test"]!, { status: "active" });
    const { dry, done } = await twoStep("promo_set_schedule", { ref: ref(TEST, id), startsAt: "2020-01-01T00:00", endsAt: "2031-06-30T23:59" });
    expect(body(dry).data).toMatchObject({ statusBefore: "active", statusAfter: "active", startsAt: "2020-01-01T00:00:00.000Z", endsAt: "2031-06-30T23:59:00.000Z", timezone: "UTC" });
    expect(done.isError).toBeFalsy();
    expect((await row(id)).endsAt?.toISOString()).toBe("2031-06-30T23:59:00.000Z");
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await audits(shopIds["test"]!, id))[0]).toMatchObject({ action: "set_schedule" });
  });

  it("needs a date, rejects an end before the start, and a failed publish is PUBLISH_FAILED", async () => {
    const id = await publishable(shopIds["test"]!, { status: "active" });
    expect(body(await run("promo_set_schedule", { ref: ref(TEST, id) })).code).toBe("VALIDATION");
    expect(body(await run("promo_set_schedule", { ref: ref(TEST, id), startsAt: "2031-06-02T00:00", endsAt: "2031-06-01T00:00" })).code).toBe("VALIDATION");
    const { done } = await twoStep("promo_set_schedule", { ref: ref(TEST, id), startsAt: "2020-01-01T00:00", endsAt: "2031-07-01T00:00" }, operators["editor"], { publish: failing() });
    expect(body(done).code).toBe("PUBLISH_FAILED");
  });
});

describe("codes_set_status", () => {
  async function withCodes(status: "active" | "paused" = "active") {
    const id = await publishable(shopIds["test"]!, { status });
    const codes = await db
      .insert(discountCodes)
      .values([
        { shopId: shopIds["test"]!, offerId: id, code: `A-${id.slice(0, 6)}` },
        { shopId: shopIds["test"]!, offerId: id, code: `B-${id.slice(0, 6)}` },
        { shopId: shopIds["test"]!, offerId: id, code: `C-${id.slice(0, 6)}`, status: "exhausted" },
      ])
      .returning({ id: discountCodes.id });
    return { id, codes: codes.map((c) => c.id) };
  }
  const statuses = async (offerId: string) => (await db.select({ code: discountCodes.code, status: discountCodes.status }).from(discountCodes).where(eq(discountCodes.offerId, offerId))).map((c) => c.status).sort();

  it("deactivates all non-exhausted codes and republishes a live offer", async () => {
    const { id } = await withCodes();
    const { dry, done } = await twoStep("codes_set_status", { ref: ref(TEST, id), status: "disabled", all: true });
    expect(body(dry).data["codesToChange"]).toBe(2);
    expect(body(done).data["codesChanged"]).toBe(2);
    expect(await statuses(id)).toEqual(["disabled", "disabled", "exhausted"]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await audits(shopIds["test"]!, id))[0]).toMatchObject({ action: "codes_set_status", performedBy: `mcp:${operators["editor"]!.id}` });
  });

  it("a failed publish restores the previous code statuses", async () => {
    const { id } = await withCodes();
    const bad = failing();
    const { done } = await twoStep("codes_set_status", { ref: ref(TEST, id), status: "disabled", all: true }, operators["editor"], { publish: bad });
    expect(body(done).code).toBe("PUBLISH_FAILED");
    expect(await statuses(id)).toEqual(["active", "active", "exhausted"]);
    // The restored statuses are pushed through the normal publish path once more, and the message says how that went.
    expect(bad.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(body(done).message).toMatch(/next successful publish will sync them/);
  });

  it("restores statuses and reports the re-sync when the second publish works", async () => {
    const { id } = await withCodes();
    let calls = 0;
    const flaky = vi.fn<ShopPublishFn>(async () => (++calls === 1 ? { message: "blip", scope: "shop" } : null));
    const { done } = await twoStep("codes_set_status", { ref: ref(TEST, id), status: "disabled", all: true }, operators["editor"], { publish: flaky });
    expect(body(done).code).toBe("PUBLISH_FAILED");
    expect(body(done).message).toMatch(/re-synced to Shopify/);
    expect(await statuses(id)).toEqual(["active", "active", "exhausted"]);
  });

  it("targets by ids, validates the selector and never touches another offer's codes", async () => {
    const a = await withCodes("paused");
    const b = await withCodes("paused");
    expect(body(await run("codes_set_status", { ref: ref(TEST, a.id), status: "disabled" })).code).toBe("VALIDATION");
    expect(body(await run("codes_set_status", { ref: ref(TEST, a.id), status: "disabled", all: true, ids: [a.codes[0]] })).code).toBe("VALIDATION");
    const { done } = await twoStep("codes_set_status", { ref: ref(TEST, a.id), status: "disabled", ids: [a.codes[0], b.codes[0]] });
    expect(body(done).data["codesChanged"]).toBe(1);
    expect(await statuses(b.id)).toEqual(["active", "active", "exhausted"]);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("replays the stored result for 24 h without running again, and rejects the key with other arguments", async () => {
    const id = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const args = { ref: ref(TEST, id), reason: "idempotent pause", idempotencyKey: "idem-key-0001" };
    const first = await twoStep("promo_pause", args);
    expect(first.done.isError).toBeFalsy();
    await db.update(offers).set({ status: "active" }).where(eq(offers.id, id));

    // Same key: the stored result comes back and nothing runs.
    const replay = await run("promo_pause", args);
    expect(replay.isError).toBeFalsy();
    expect(body(replay).warnings.map((w) => w.code)).toContain("IDEMPOTENT_REPLAY");
    expect(body(replay).data).toEqual(body(first.done).data);
    expect((await row(id)).status).toBe("active");
    expect(publish).toHaveBeenCalledTimes(1);

    const other = await run("promo_pause", { ...args, reason: "a different reason" });
    expect(body(other).code).toBe("VALIDATION");
    // Another operator with the same key is not a replay.
    const rows = await db.select().from(mcpCallLog).where(eq(mcpCallLog.idempotencyKey, "idem-key-0001"));
    expect(rows).toHaveLength(1);

    clock += 25 * 3_600_000;
    // After 24 h the key is free again: the same call runs for real.
    const expired = await run("promo_pause", args);
    expect(expired.isError).toBeFalsy();
    expect(body(expired).warnings.map((w) => w.code)).not.toContain("IDEMPOTENT_REPLAY");
    expect((await row(id)).status).toBe("paused");
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("a failed execution frees the key so a retry can use it", async () => {
    const id = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const args = { ref: ref(TEST, id), reason: "retry me", idempotencyKey: "idem-key-0002" };
    const failed = await twoStep("promo_pause", args, operators["editor"], { publish: failing() });
    expect(body(failed.done).code).toBe("PUBLISH_FAILED");
    const retry = await run("promo_pause", args);
    expect(retry.isError).toBeFalsy();
    expect((await row(id)).status).toBe("paused");
  });
});

describe("mcp_call_log", () => {
  it("logs previews, executions and failures with redacted args and the outcome", async () => {
    const id = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const args = { ref: ref(TEST, id), reason: "log me please" };
    await run("promo_pause", { ...args, dryRun: true });
    await run("promo_pause", args);
    await run("promo_pause", args, operators["viewer"]);
    const rows = (await callLogs("promo_pause")).filter((r) => (r.argsRedacted as { ref?: string } | null)?.ref === args.ref);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["INVALID_STATE", "ok", "ok"]);
    const executed = rows.find((r) => r.confirmJti && r.outcome === "ok")!;
    expect(executed).toMatchObject({ operatorId: operators["editor"]!.id, shops: [TEST], outcome: "ok" });
    expect(executed.durationMs).not.toBeNull();
    // Free text never reaches the table, in any column.
    const everything = JSON.stringify(await db.select().from(mcpCallLog));
    expect(everything).not.toContain("log me please");
    expect(executed.argsRedacted).toMatchObject({ ref: args.ref, _omitted: expect.arrayContaining(["reason"]) });
    expect((executed.resultRef as { result: { data: unknown } }).result.data).toBeTruthy();
  });
});

describe("rate limits", () => {
  it("writes: 10 a minute per operator (previews count), then RATE_LIMITED with retryAfterSeconds", async () => {
    const [op] = await db.insert(mcpOperators).values({ email: "rate@example.com", name: "r", role: "editor", shopAllowList: ["*"] }).returning();
    const rate: Operator = { id: op!.id, email: op!.email, name: "r", role: "editor", shopAllowList: ["*"] };
    const id = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const real = { rateLimit: undefined } as Partial<McpContext>;
    const args = { ref: ref(TEST, id), reason: "rate limit", dryRun: true };
    for (let i = 0; i < 10; i++) expect((await run("promo_pause", args, rate, real)).isError).toBeFalsy();
    const blocked = await run("promo_pause", args, rate, real);
    expect(body(blocked).code).toBe("RATE_LIMITED");
    expect((blocked.structuredContent as { retryAfterSeconds: number; retryable: boolean }).retryAfterSeconds).toBeGreaterThan(0);
    expect((blocked.structuredContent as { retryable: boolean }).retryable).toBe(true);
  });

  it("every write, high-impact ones included, uses the write class (no stricter critical class)", async () => {
    const calls: string[] = [];
    const limiter = async (key: string, limit: number) => {
      calls.push(`${key.split(":")[1]}:${limit}`);
      return { ok: true as const };
    };
    const id = await seedOffer(db, shopIds["test"]!, { status: "active" });
    await twoStep("promo_archive", { ref: ref(TEST, id) }, operators["admin"], { rateLimit: limiter });
    expect(calls).toEqual(["write:10", "write:10"]);

    const deny = async (key: string) => (key.includes(":write:") ? { ok: false as const, retryAfterSeconds: 30 } : { ok: true as const });
    const other = await seedOffer(db, shopIds["test"]!, { status: "active" });
    const res = await run("promo_archive", { ref: ref(TEST, other) }, operators["admin"], { rateLimit: deny });
    expect(body(res).code).toBe("RATE_LIMITED");
    expect((await row(other)).status).toBe("active");
  });
});

describe("registered over MCP", () => {
  async function connect(op: Operator, extra: Partial<McpContext> = {}) {
    const server = createMcpServer(ctxFor(op, extra));
    const client = new Client({ name: "vitest-client", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, stop: async () => { await client.close(); await server.close(); } };
  }

  it("annotations: every write tool is non-read-only, archive is the only destructive one; reads stay read-only", async () => {
    const { client, stop } = await connect(operators["editor"]!);
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    const writes = ["promo_pause", "promo_resume", "promo_archive", "promos_republish_shop", "promo_duplicate", "promo_create_draft_from_template", "promo_set_page_exclude_urls", "promo_set_schedule", "codes_set_status"];
    for (const name of writes) {
      expect(byName[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: name === "promo_archive" });
    }
    expect(byName["promo_detail"]).toMatchObject({ readOnlyHint: true });
    await stop();
  });

  it("an optional preview then a direct execute through the protocol, logging the client name in the audit row", async () => {
    const id = await seedOffer(db, shopIds["test"]!, { status: "active", internalName: "[MCP test] over the wire" });
    const { client, stop } = await connect(operators["editor"]!);
    const dry = (await client.callTool({ name: "promo_pause", arguments: { ref: ref(TEST, id), reason: "end to end", dryRun: true } })) as CallToolResult;
    expect(body(dry).meta.dryRun).toBe(true);
    expect((await row(id)).status).toBe("active");
    const done = (await client.callTool({ name: "promo_pause", arguments: { ref: ref(TEST, id), reason: "end to end" } })) as CallToolResult;
    expect(done.isError).toBeFalsy();
    expect((await row(id)).status).toBe("paused");
    expect((await audits(shopIds["test"]!, id))[0]!.after).toMatchObject({ _mcp: { client: "vitest-client", tool: "promo_pause" } });
    await stop();
  });

  it("every write tool documents dryRun and has no confirmToken, role or write-lock wording", async () => {
    const { client, stop } = await connect(operators["viewer"]!);
    const writes = (await client.listTools()).tools.filter((t) => t.annotations?.readOnlyHint === false);
    expect(writes.length).toBeGreaterThanOrEqual(14);
    for (const t of writes) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props, t.name).toContain("dryRun");
      expect(props, t.name).toContain("idempotencyKey");
      expect(props, t.name).not.toContain("confirmToken");
      expect(t.description, t.name).not.toMatch(/confirmToken|SHOP_READ_ONLY|admin role|Admin only|write-enabled/i);
      expect(t.description, t.name).toContain("dryRun:true");
    }
    await stop();
  });

  it("rejects unknown override keys at the schema", async () => {
    const id = await publishable(shopIds["test"]!, { status: "draft" });
    const { client, stop } = await connect(operators["editor"]!);
    const res = (await client.callTool({ name: "promo_create_draft_from_template", arguments: { shop: TEST, templateId: id, name: "x", overrides: { status: "active" } } })) as CallToolResult;
    expect(res.isError).toBe(true);
    await stop();
  });

  it("reads go through the read limit and are logged", async () => {
    const calls: string[] = [];
    const limiter = async (key: string) => (calls.push(key.split(":")[1]!), { ok: true as const });
    const { client, stop } = await connect(operators["viewer"]!, { rateLimit: limiter });
    const res = (await client.callTool({ name: "shops_list", arguments: {} })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(["read"]);
    expect((await callLogs("shops_list")).some((r) => r.outcome === "ok" && r.operatorId === operators["viewer"]!.id)).toBe(true);
    await stop();

    const denied = await connect(operators["viewer"]!, { rateLimit: async () => ({ ok: false as const, retryAfterSeconds: 7 }) });
    const blocked = (await denied.client.callTool({ name: "shops_list", arguments: {} })) as CallToolResult;
    expect(body(blocked).code).toBe("RATE_LIMITED");
    await denied.stop();
  });
});

describe("retention", () => {
  it("deleteExpiredMcpCallState deletes old call-log rows and long-expired PATs only", async () => {
    const base = new Date("2027-01-01T00:00:00Z");
    const day = 86_400_000;
    const opId = operators["viewer"]!.id;
    await db.insert(mcpCallLog).values([
      { operatorId: opId, tool: "retention_old", outcome: "ok", createdAt: new Date(base.getTime() - 91 * day) },
      { operatorId: opId, tool: "retention_new", outcome: "ok", createdAt: new Date(base.getTime() - 10 * day) },
    ]);
    await db.insert(mcpCredentials).values([
      { operatorId: opId, kind: "pat", tokenHash: "h-old", prefix: "p", expiresAt: new Date(base.getTime() - 8 * day) },
      { operatorId: opId, kind: "pat", tokenHash: "h-recent", prefix: "p", expiresAt: new Date(base.getTime() - 2 * day) },
      { operatorId: opId, kind: "pat", tokenHash: "h-live", prefix: "p", expiresAt: new Date(base.getTime() + day) },
    ]);
    const result = await deleteExpiredMcpCallState(db, base);
    expect(result.callLog).toBeGreaterThanOrEqual(1);
    expect(result.expiredPats).toBe(1);
    expect((await callLogs("retention_old")).length).toBe(0);
    expect((await callLogs("retention_new")).length).toBe(1);
    const left = (await db.select({ h: mcpCredentials.tokenHash }).from(mcpCredentials)).map((c) => c.h);
    expect(left).toEqual(expect.arrayContaining(["h-recent", "h-live"]));
    expect(left).not.toContain("h-old");
  });
});

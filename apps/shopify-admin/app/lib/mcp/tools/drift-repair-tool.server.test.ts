import type * as PromoDb from "@promo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { appSettings, auditLogs, mcpCallLog, mcpOperators, shops, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";

let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => currentDb,
}));
vi.mock("../../token-crypto.server.js", () => ({ decryptToken: async () => "token" }));
vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));
vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const { driftRepairSettingsTool } = await import("./critical-tools.server.js");
const { ManifestCollector, writePublishManifest } = await import("../../publish-manifest.server.js");
const { setDriftRepairPaused } = await import("../../drift-repair-settings.server.js");
const { runDiscountDriftRepair } = await import("../../discount-reconciliation.server.js");

const TEST = "drift-mcp-test.myshopify.com";
const LIVE = "drift-mcp-live.myshopify.com";
const ENV = { MCP_WRITE_SHOPS: TEST, MCP_CONFIRM_SECRET: "x".repeat(40) } as unknown as NodeJS.ProcessEnv;
const GOOD = JSON.stringify({ offers: [{ id: "o1" }], version: "1" });
const TAMPERED = '{"offers":[]}';

type Body = { code?: string; summary: string; data: Record<string, any>; meta: { confirmToken?: string }; details?: { reason?: string }; warnings: { code: string }[] };
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let liveId: string;
let cart: string;
let delivery: string;
const operators: Record<string, Operator> = {};
const unlimited = async () => ({ ok: true as const });

type Fake = { nodes: Record<string, { value: string | null; appValue?: string | null; status: string }>; queries: string[] };
let fake: Fake;
const graphQL = vi.fn(async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
  fake.queries.push(query.includes("mutation") ? "mutation" : "read");
  if (query.includes("PromoEngineDriftCheck")) {
    return {
      nodes: (variables!.ids as string[]).map((id) => {
        const node = fake.nodes[id];
        if (!node) return null;
        const appValue = node.appValue === undefined ? node.value : node.appValue;
        return {
          __typename: "DiscountAutomaticNode",
          id,
          m0: node.value ? { value: node.value } : null,
          m1: appValue ? { value: appValue } : null, automaticDiscount: { status: node.status, appliesOnSubscription: true, appliesOnOneTimePurchase: true },
        };
      }),
    };
  }
  if (query.includes("PromoEngineActivateAutomatic")) {
    fake.nodes[variables!.id as string]!.status = "ACTIVE";
    return { discountAutomaticActivate: { userErrors: [] } };
  }
  throw new Error(`unexpected query ${query.slice(0, 40)}`);
});
const resetFake = () => {
  fake = {
    nodes: {
      [cart]: { value: TAMPERED, appValue: GOOD, status: "ACTIVE" },
      [delivery]: { value: GOOD, status: "ACTIVE" },
    },
    queries: [],
  };
  graphQL.mockClear();
};
let publish = vi.fn<ShopPublishFn>();
const restoreOnPublish = () =>
  vi.fn<ShopPublishFn>(async () => {
    for (const node of Object.values(fake.nodes)) Object.assign(node, { value: GOOD, appValue: GOOD });
    return null;
  });

const info = { requestId: "req-1", client: "vitest" };
const ctxFor = (op: Operator): McpContext => ({ db, env: ENV, operator: op, now: () => new Date(), rateLimit: unlimited, publish });
const run = (args: Record<string, unknown>, op = operators["admin"]!) =>
  driftRepairSettingsTool(ctxFor(op), info, args as never, { graphQL: graphQL as never, settleMs: 0 });

async function twoStep(args: Record<string, unknown> = { shop: TEST }) {
  const dry = await run(args);
  expect(dry.isError, JSON.stringify(dry.structuredContent)).toBeFalsy();
  const token = body(dry).meta.confirmToken!;
  const done = await run({ ...args, dryRun: false, confirmToken: token });
  return { dry, done, token };
}

const audits = async () => (await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.action, "drift_repair")))).length;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  currentDb = db;
  shopId = await seedShop(db, TEST);
  liveId = await seedShop(db, LIVE);
  for (const id of [shopId, liveId]) await db.insert(appSettings).values({ shopId: id, key: "mcp.writeMode", value: JSON.stringify("write") });
  cart = "gid://shopify/DiscountAutomaticNode/cart-1";
  delivery = "gid://shopify/DiscountAutomaticNode/delivery-1";
  await db.update(shops).set({ discountId: cart, deliveryDiscountId: delivery }).where(eq(shops.id, shopId));
  const collector = new ManifestCollector();
  collector.record(cart, "cart", GOOD);
  collector.record(delivery, "delivery", GOOD);
  await writePublishManifest(shopId, collector.build());
  for (const role of ["viewer", "editor", "admin"] as const) {
    const [op] = await db.insert(mcpOperators).values({ email: `${role}@example.com`, name: role, role, shopAllowList: ["*"] }).returning();
    operators[role] = { id: op!.id, email: op!.email, name: op!.name, role, shopAllowList: ["*"] };
  }
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  resetFake();
  publish = restoreOnPublish();
  resetMemoryRateLimits();
});

describe("drift_repair_settings", () => {
  it("dry run shows the per-item diff and writes nothing", async () => {
    const before = await audits();
    const dry = await run({ shop: TEST });
    expect(dry.isError, JSON.stringify(dry.structuredContent)).toBeFalsy();
    expect(body(dry).summary).toMatch(/^DRY RUN/);
    expect(body(dry).meta.confirmToken).toBeTruthy();
    const items = body(dry).data["items"] as any[];
    expect(items.map((i) => i.issue)).toEqual(["config_mismatch"]);
    expect(items[0]).toMatchObject({
      target: "metafield",
      nodeId: cart,
      namespace: "promo_engine",
      current: { missing: false },
      bytesBefore: TAMPERED.length,
      bytesAfter: GOOD.length,
    });
    expect(items[0].current.hash).not.toBe(items[0].expected.hash);
    expect(body(dry).data["wouldWrite"].join(" ")).toContain("publish the shop config");
    expect(publish).not.toHaveBeenCalled();
    expect(fake.queries).not.toContain("mutation");
    expect(fake.nodes[cart]!.value).toBe(TAMPERED);
    expect(await audits()).toBe(before);
  });

  it("dry run reports an inactive automatic node with current vs expected and the write it would do", async () => {
    fake.nodes[delivery]!.status = "INACTIVE";
    const dry = await run({ shop: TEST });
    const item = (body(dry).data["items"] as any[]).find((i) => i.issue === "inactive_node");
    expect(item).toMatchObject({ target: "discount_node", nodeId: delivery, current: { status: "INACTIVE" }, expected: { status: "ACTIVE" } });
    expect(body(dry).data["wouldWrite"]).toContain(`discountAutomaticActivate ${delivery}`);
    expect(fake.nodes[delivery]!.status).toBe("INACTIVE");
    expect(fake.queries).not.toContain("mutation");
  });

  it("confirm executes the repair, audits as mcp:<operator> with _mcp, and logs the call", async () => {
    const { done } = await twoStep();
    expect(done.isError, JSON.stringify(done.structuredContent)).toBeFalsy();
    expect(await audits()).toBe(1);
    expect(body(done).data["outcome"]).toBe("repaired");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(fake.nodes[cart]!.value).toBe(GOOD);
    const [log] = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.action, "drift_repair")));
    expect(log!.performedBy).toBe(`mcp:${operators["admin"]!.id}`);
    expect(JSON.stringify(log!.after)).toContain("_mcp");
    expect(JSON.stringify(log!.after)).toContain("repaired");
    const calls = await db.select().from(mcpCallLog).where(eq(mcpCallLog.tool, "drift_repair_settings"));
    expect(calls.map((c) => c.outcome)).toContain("ok");
  });

  it("a confirmToken is single use", async () => {
    const { done, token } = await twoStep();
    expect(done.isError).toBeFalsy();
    resetFake();
    const again = await run({ shop: TEST, dryRun: false, confirmToken: token });
    expect(body(again).code).toBe("CONFIRM_INVALID");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("a diff that changed since the dry run is STATE_CONFLICT and nothing is published", async () => {
    const before = await audits();
    const dry = await run({ shop: TEST });
    fake.nodes[delivery]!.value = TAMPERED;
    const done = await run({ shop: TEST, dryRun: false, confirmToken: body(dry).meta.confirmToken });
    expect(body(done).code).toBe("STATE_CONFLICT");
    expect(publish).not.toHaveBeenCalled();
    expect(await audits()).toBe(before);
  });

  it("an idempotencyKey replays the stored result without publishing again", async () => {
    const key = "drift-repair-key-1";
    const dry = await run({ shop: TEST, idempotencyKey: key });
    const args = { shop: TEST, dryRun: false, confirmToken: body(dry).meta.confirmToken, idempotencyKey: key };
    expect((await run(args)).isError).toBeFalsy();
    const replay = await run(args);
    expect(replay.isError).toBeFalsy();
    expect(body(replay).warnings.map((w) => w.code)).toContain("IDEMPOTENT_REPLAY");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("is refused while drift repair is paused for the shop", async () => {
    await setDriftRepairPaused(shopId, true);
    try {
      const dry = await run({ shop: TEST });
      expect(body(dry).warnings.map((w) => w.code)).toContain("REPAIR_PAUSED");
      const done = await run({ shop: TEST, dryRun: false, confirmToken: body(dry).meta.confirmToken });
      expect(body(done).code).toBe("INVALID_STATE");
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await setDriftRepairPaused(shopId, false);
    }
  });

  it("a healthy shop gets NO_DRIFT and executing changes nothing", async () => {
    fake.nodes[cart]!.value = GOOD;
    const { dry, done } = await twoStep();
    expect(body(dry).warnings.map((w) => w.code)).toContain("NO_DRIFT");
    expect(done.isError).toBeFalsy();
    expect(publish).not.toHaveBeenCalled();
  });

  it("viewer and editor are FORBIDDEN (reason ROLE)", async () => {
    for (const role of ["viewer", "editor"] as const) {
      const result = await run({ shop: TEST }, operators[role]);
      expect(body(result).code).toBe("FORBIDDEN");
      expect(body(result).details?.reason).toBe("ROLE");
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("an admin on a shop that is not write-enabled gets SHOP_READ_ONLY on dry run and execute", async () => {
    expect(body(await run({ shop: LIVE })).code).toBe("SHOP_READ_ONLY");
    expect(body(await run({ shop: LIVE, dryRun: false, confirmToken: "a.b" })).code).toBe("SHOP_READ_ONLY");
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("cron path through repairShopDrift", () => {
  it("still repairs and counts through runDiscountDriftRepair without writing an audit entry", async () => {
    const before = await audits();
    const result = await runDiscountDriftRepair({ graphQL: graphQL as never, publish: publish as never, settleMs: 0 });
    expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(publish).toHaveBeenCalledWith(shopId, TEST);
    expect(await audits()).toBe(before);
  });
});

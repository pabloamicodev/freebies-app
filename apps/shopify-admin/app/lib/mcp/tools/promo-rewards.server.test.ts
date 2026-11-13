import type * as IndexTypeModule from "../../offer-authoring/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditLogs, mcpOperators, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { ShopPublishFn } from "../../offer-publish-flow.server.js";
import { addReward, setTierMode } from "../../offer-rewards.server.js";
import type { Operator } from "../auth.server.js";
import { createMcpServer, type McpContext } from "../server.server.js";
import { rewardDeleteTool, rewardUpsertTool } from "./promo-rewards.server.js";

vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));
// Package 03 owns the real authoring module; this stand-in pins the contract the tool relies on (schema + toStoredRewards).
vi.mock("../../offer-authoring/index.js", async (importOriginal) => {
  const { z } = await import("zod");
  return {
    ...(await importOriginal<typeof IndexTypeModule>()),
    AuthoringRewardSchema: z.object({ kind: z.literal("order_discount"), percent: z.number().min(1).max(100), copies: z.number().int().min(1).max(3).optional() }),
    toStoredRewards: async (rewards: Array<{ percent: number; copies?: number }>, deps: { shopCurrency: string }) => ({
      ok: true,
      value: rewards.flatMap((r) =>
        Array.from({ length: r.copies ?? 1 }, () => ({
          rewardType: "order_discount",
          discountType: "percentage",
          value: { amount: r.percent, currencyCode: deps.shopCurrency },
          target: { scope: "cart" },
        })),
      ),
    }),
  };
});

const SHOP = "rewards-test.myshopify.com";
let db: Db;
let close: () => Promise<void>;
let shopId: string;
let operator: Operator;
let publish = vi.fn<ShopPublishFn>(async () => null);
const unlimited = async () => ({ ok: true as const });
const ctx = (): McpContext => ({ db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: unlimited, publish });
const info = { requestId: "req-1", client: "vitest" };
const out = (r: CallToolResult) => r.structuredContent as unknown as { code?: string; message?: string; summary: string; data: Record<string, any> };
const ref = (id: string) => `promo:rewards-test:${id}`;
const rewardRows = (offerId: string) => db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)).orderBy(offerRewards.sortOrder);
const audits = (offerId: string) => db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.entityId, offerId)));
const orderReward = (percent: number) => ({ rewardType: "order_discount", discountType: "percentage", value: { amount: percent, currencyCode: "USD" }, target: { scope: "cart" } }) as const;

async function offerWith(status: "draft" | "active", rewards: Array<Record<string, unknown>> = [orderReward(10)]) {
  const id = await seedOffer(db, shopId, { type: "discount", status, internalName: `[rewards] ${Math.random().toString(36).slice(2, 8)}` });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 10000 }, sortOrder: 0, isEnabled: true });
  for (const [i, r] of rewards.entries()) await db.insert(offerRewards).values({ shopId, offerId: id, sortOrder: i, ...r } as typeof offerRewards.$inferInsert);
  return id;
}
const gift = (n: number) => ({ rewardType: "product_gift", discountType: "free", value: { amount: 100 }, target: { productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}` } }) as const;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, SHOP);
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

describe("promo_reward_upsert", () => {
  it("adds a stored reward to a draft offer: appended, audited with the MCP actor, nothing published", async () => {
    const id = await offerWith("draft");
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), stored: orderReward(25) }));
    expect(res.code).toBeUndefined();
    expect(res.data["action"]).toBe("add");
    const rows = await rewardRows(id);
    expect(rows.map((r) => [r.sortOrder, (r.value as { amount: number }).amount])).toEqual([[0, 10], [1, 25]]);
    expect(res.data["rewards"][0].rewardId).toBe(rows[1]!.id);
    expect(publish).not.toHaveBeenCalled();
    const [audit] = await audits(id);
    expect(audit).toMatchObject({ action: "add_reward", performedBy: `mcp:${operator.id}` });
    expect(audit!.after).toMatchObject({ rewardType: "order_discount", _mcp: { tool: "promo_reward_upsert" } });
  });

  it("republishes a live offer after an add", async () => {
    const id = await offerWith("active");
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), stored: orderReward(30) }));
    expect(res.code).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await rewardRows(id)).toHaveLength(2);
  });

  it("updates one reward in place (rewardId) and keeps the others", async () => {
    const id = await offerWith("draft", [orderReward(10), orderReward(15)]);
    const [first] = await rewardRows(id);
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), rewardId: first!.id, stored: orderReward(40) }));
    expect(res.data["action"]).toBe("update");
    const rows = await rewardRows(id);
    expect(rows.map((r) => (r.value as { amount: number }).amount)).toEqual([40, 15]);
  });

  it("dryRun validates and previews but writes, audits and publishes nothing", async () => {
    const id = await offerWith("active");
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), stored: orderReward(50), dryRun: true }));
    expect(res.summary).toContain("DRY RUN");
    expect(res.data["rewards"]).toHaveLength(1);
    expect(await rewardRows(id)).toHaveLength(1);
    expect(await audits(id)).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects an invalid stored reward with VALIDATION and writes nothing", async () => {
    const id = await offerWith("draft");
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), stored: { ...orderReward(10), value: { amount: 250, currencyCode: "USD" } } }));
    expect(res.code).toBe("VALIDATION");
    expect(await rewardRows(id)).toHaveLength(1);
  });

  it("needs exactly one of reward and stored", async () => {
    const id = await offerWith("draft");
    expect(out(await rewardUpsertTool(ctx(), info, { ref: ref(id) })).code).toBe("VALIDATION");
    expect(out(await rewardUpsertTool(ctx(), info, { ref: ref(id), stored: orderReward(10), reward: { kind: "order_discount", percent: 5 } })).code).toBe("VALIDATION");
  });

  it("an authoring reward is parsed and stored (several stored rows are added, but cannot replace one)", async () => {
    const id = await offerWith("draft");
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), reward: { kind: "order_discount", percent: 20, copies: 2 } }));
    expect(res.code).toBeUndefined();
    expect(await rewardRows(id)).toHaveLength(3);
    const [first] = await rewardRows(id);
    expect(out(await rewardUpsertTool(ctx(), info, { ref: ref(id), rewardId: first!.id, reward: { kind: "order_discount", percent: 20, copies: 2 } })).code).toBe("VALIDATION");
    const bad = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), reward: { kind: "order_discount", percent: 500 } }));
    expect(bad.code).toBe("VALIDATION");
    expect(bad.message).toContain("percent");
  });

  it("updating a reward that is not in the offer is NOT_FOUND", async () => {
    const id = await offerWith("draft");
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), rewardId: "11111111-1111-4111-8111-111111111111", stored: orderReward(10) }));
    expect(res.code).toBe("NOT_FOUND");
  });

  it("a failed publish keeps the saved reward and answers PUBLISH_FAILED", async () => {
    const id = await offerWith("active");
    publish = vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), stored: orderReward(35) }));
    expect(res.code).toBe("PUBLISH_FAILED");
    expect(await rewardRows(id)).toHaveLength(2);
  });

  it("gift tiers: minCartSubtotal is stored in minor units, must be unique, and lowers the main threshold", async () => {
    const id = await offerWith("draft", [gift(1)]);
    const res = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), stored: { ...gift(2), minCartSubtotal: 50 } }));
    expect(res.code).toBeUndefined();
    const rows = await rewardRows(id);
    expect(rows[1]!.minCartSubtotalCents).toBe(5000);
    const [main] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, id));
    expect((main!.value as { thresholdCents: number }).thresholdCents).toBe(5000);
    const dup = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), stored: { ...gift(3), minCartSubtotal: 50 } }));
    expect(dup.code).toBe("VALIDATION");
    expect(dup.message).toContain("unlocks at that cart subtotal");
    // posting null clears the tier, an update without the field keeps it
    const kept = out(await rewardUpsertTool(ctx(), info, { ref: ref(id), rewardId: rows[1]!.id, stored: gift(2) }));
    expect(kept.code).toBeUndefined();
    expect((await rewardRows(id))[1]!.minCartSubtotalCents).toBe(5000);
    await rewardUpsertTool(ctx(), info, { ref: ref(id), rewardId: rows[1]!.id, stored: { ...gift(2), minCartSubtotal: null } });
    expect((await rewardRows(id))[1]!.minCartSubtotalCents).toBeNull();
  });
});

describe("promo_reward_delete", () => {
  it("deletes a reward of a draft offer and audits it", async () => {
    const id = await offerWith("draft", [orderReward(10), orderReward(20)]);
    const [first] = await rewardRows(id);
    const res = out(await rewardDeleteTool(ctx(), info, { ref: ref(id), rewardId: first!.id }));
    expect(res.data["remaining"]).toBe(1);
    expect(await rewardRows(id)).toHaveLength(1);
    expect((await audits(first!.id)).map((a) => a.action)).toEqual(["delete_reward"]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("republishes a live offer, but refuses to delete its last reward", async () => {
    const id = await offerWith("active", [orderReward(10), orderReward(20)]);
    const [first, second] = await rewardRows(id);
    expect(out(await rewardDeleteTool(ctx(), info, { ref: ref(id), rewardId: first!.id })).code).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    const refused = out(await rewardDeleteTool(ctx(), info, { ref: ref(id), rewardId: second!.id }));
    expect(refused.code).toBe("VALIDATION");
    expect(refused.message).toContain("last reward");
    expect(await rewardRows(id)).toHaveLength(1);
  });

  it("dryRun deletes nothing; an unknown reward is NOT_FOUND", async () => {
    const id = await offerWith("draft", [orderReward(10), orderReward(20)]);
    const [first] = await rewardRows(id);
    const dry = out(await rewardDeleteTool(ctx(), info, { ref: ref(id), rewardId: first!.id, dryRun: true }));
    expect(dry.summary).toContain("DRY RUN");
    expect(await rewardRows(id)).toHaveLength(2);
    expect(out(await rewardDeleteTool(ctx(), info, { ref: ref(id), rewardId: "11111111-1111-4111-8111-111111111111" })).code).toBe("NOT_FOUND");
  });
});

describe("offer-rewards service", () => {
  const deps = () => ({ db, shopId, shopDomain: SHOP, shopCurrency: "USD", timezone: "UTC" });

  it("setTierMode writes the mode, republishes a live offer and audits", async () => {
    const id = await offerWith("active", [gift(1)]);
    const result = await setTierMode(deps(), id, "highest", { performedBy: "mcp:x", publish });
    expect(result.ok).toBe(true);
    const [row] = await db.select({ tierMode: offers.tierMode }).from(offers).where(eq(offers.id, id));
    expect(row!.tierMode).toBe("highest");
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await audits(id)).map((a) => a.action)).toContain("set_tier_mode");
    const dry = await setTierMode(deps(), id, "cumulative", { performedBy: "mcp:x", publish, dryRun: true });
    expect(dry.ok && dry.value.dryRun).toBe(true);
    expect((await db.select({ tierMode: offers.tierMode }).from(offers).where(eq(offers.id, id)))[0]!.tierMode).toBe("highest");
  });

  it("a stale expectedUpdatedAt is a state failure and writes nothing", async () => {
    const id = await offerWith("draft");
    const result = await addReward(deps(), id, { record: { ...orderReward(5), quantity: null, isAutoAdd: false, isCustomerSelectable: false, trackMode: "product", label: null } }, { performedBy: "mcp:x", expectedUpdatedAt: new Date(0) });
    expect(result).toEqual({ ok: false, code: "state", error: expect.anything() });
    expect(await rewardRows(id)).toHaveLength(1);
  });

  it("an offer of another shop is not found", async () => {
    const other = await seedShop(db, "other-rewards.myshopify.com");
    const id = await offerWith("draft");
    const result = await setTierMode({ ...deps(), shopId: other }, id, "highest", { performedBy: "mcp:x" });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("registration", () => {
  it("registers promo_reward_upsert and promo_reward_delete with documented inputs", async () => {
    const server = createMcpServer(ctx());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const upsert = tools.find((t) => t.name === "promo_reward_upsert");
    const del = tools.find((t) => t.name === "promo_reward_delete");
    expect(upsert?.description).toContain("Example");
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(Object.keys(upsert!.inputSchema.properties!)).toEqual(expect.arrayContaining(["ref", "rewardId", "reward", "stored", "dryRun", "idempotencyKey"]));
    const id = await offerWith("draft");
    const res = (await client.callTool({ name: "promo_reward_upsert", arguments: { ref: ref(id), stored: orderReward(12) } })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(await rewardRows(id)).toHaveLength(2);
    await client.close();
  });
});

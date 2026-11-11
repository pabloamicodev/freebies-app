import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";
import { createTestDb, seedShop } from "./test-support/pglite-db.js";
import { isShardInstructionBudgetEnabled, setShardInstructionBudgetEnabled } from "./function-shards-flag.server.js";

let db: Db;
let close: () => Promise<void>;
let n = 0;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});
afterEach(() => vi.unstubAllEnvs());

const freshShop = async () => seedShop(db, `instructions-${(n += 1)}.myshopify.com`);

describe("function_shards.instruction_budget", () => {
  it("is on by default in production and only an explicit false turns a shop off", async () => {
    const shopId = await freshShop();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    expect(await isShardInstructionBudgetEnabled(db, shopId)).toBe(true);
    await setShardInstructionBudgetEnabled(db, shopId, false);
    expect(await isShardInstructionBudgetEnabled(db, shopId)).toBe(false);
    await setShardInstructionBudgetEnabled(db, shopId, true);
    expect(await isShardInstructionBudgetEnabled(db, shopId)).toBe(true);
  });

  it("the vitest default is off, and an explicit row still wins over it", async () => {
    const shopId = await freshShop();
    vi.stubEnv("FUNCTION_SHARD_INSTRUCTIONS_DEFAULT", "off");
    expect(await isShardInstructionBudgetEnabled(db, shopId)).toBe(false);
    await setShardInstructionBudgetEnabled(db, shopId, true);
    expect(await isShardInstructionBudgetEnabled(db, shopId)).toBe(true);
  });

  it("the test-only default cannot switch production off", async () => {
    const shopId = await freshShop();
    vi.stubEnv("FUNCTION_SHARD_INSTRUCTIONS_DEFAULT", "off");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    expect(await isShardInstructionBudgetEnabled(db, shopId)).toBe(true);
  });

  it("FUNCTION_SHARD_INSTRUCTIONS=off is the kill switch for every shop, whatever they stored", async () => {
    const shopId = await freshShop();
    await setShardInstructionBudgetEnabled(db, shopId, true);
    vi.stubEnv("FUNCTION_SHARD_INSTRUCTIONS", "off");
    expect(await isShardInstructionBudgetEnabled(db, shopId)).toBe(false);
  });
});

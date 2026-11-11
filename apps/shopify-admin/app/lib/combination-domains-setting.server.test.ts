import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appSettings, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedShop } from "./test-support/pglite-db.js";
import { changeCombinationDomains } from "./combination-domains-setting.server.js";
import { isShardDomainsEnabled, setFunctionShardsEnabled, setShardDomainsEnabled, SHARD_DOMAINS_SETTING } from "./function-shards-flag.server.js";

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let n = 0;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});
afterEach(() => vi.unstubAllEnvs());

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const stored = async () =>
  (await db.select({ value: appSettings.value }).from(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, SHARD_DOMAINS_SETTING))))[0]?.value;

describe("changeCombinationDomains", () => {
  const fresh = async () => {
    n += 1;
    shopId = await seedShop(db, `domains-${n}.myshopify.com`);
  };

  it("stores the setting and republishes", async () => {
    await fresh();
    await setFunctionShardsEnabled(db, shopId, true);
    await setShardDomainsEnabled(db, shopId, false);
    const publish = vi.fn(async () => null);
    expect(await changeCombinationDomains(db, shopId, form({ intent: "set_combination_domains", enabled: "true" }), publish)).toEqual({ success: true });
    expect(await stored()).toBe("true");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("reverts the setting when the republish fails", async () => {
    await fresh();
    await setFunctionShardsEnabled(db, shopId, true);
    await setShardDomainsEnabled(db, shopId, false);
    const result = await changeCombinationDomains(db, shopId, form({ intent: "set_combination_domains", enabled: "true" }), async () => "boom");
    expect(result).toEqual({ error: expect.stringContaining("boom") });
    expect(await stored()).toBe("false");
  });

  it("with sharding off it stores the setting without republishing and says when it takes effect", async () => {
    await fresh();
    await setFunctionShardsEnabled(db, shopId, false);
    await setShardDomainsEnabled(db, shopId, true);
    const publish = vi.fn(async () => null);
    const result = await changeCombinationDomains(db, shopId, form({ intent: "set_combination_domains", enabled: "false" }), publish);
    expect(result).toEqual({ success: true, note: expect.stringContaining("takes effect when sharding is turned on") });
    expect(await stored()).toBe("false");
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses without storing or republishing while FUNCTION_SHARD_DOMAINS=off is active", async () => {
    await fresh();
    vi.stubEnv("FUNCTION_SHARD_DOMAINS", "off");
    const publish = vi.fn(async () => null);
    const result = await changeCombinationDomains(db, shopId, form({ intent: "set_combination_domains", enabled: "false" }), publish);
    expect(result).toEqual({ error: expect.stringContaining("switched off for every store") });
    expect(await stored()).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent or a malformed value", async () => {
    await fresh();
    const publish = vi.fn(async () => null);
    expect(await changeCombinationDomains(db, shopId, form({ intent: "other", enabled: "true" }), publish)).toEqual({ error: "Unknown action." });
    expect(await changeCombinationDomains(db, shopId, form({ intent: "set_combination_domains", enabled: "yes" }), publish)).toEqual({ error: "Unknown action." });
    expect(publish).not.toHaveBeenCalled();
    expect(await stored()).toBeUndefined();
  });
});

describe("FUNCTION_SHARD_DOMAINS_DEFAULT", () => {
  it("is honored in tests only: outside NODE_ENV=test and VITEST it cannot switch the default off", async () => {
    n += 1;
    shopId = await seedShop(db, `domains-default-${n}.myshopify.com`);
    vi.stubEnv("FUNCTION_SHARD_DOMAINS_DEFAULT", "off");
    expect(await isShardDomainsEnabled(db, shopId)).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    expect(await isShardDomainsEnabled(db, shopId)).toBe(true);
  });
});

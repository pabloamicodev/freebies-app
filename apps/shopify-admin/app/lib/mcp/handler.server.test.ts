import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appSettings, shops, type Db } from "@promo/db";
import { eq } from "drizzle-orm";
import { handleMcpRequest, type RateLimiter } from "./handler.server.js";
import { createOperatorWithPat } from "./auth.server.js";
import { clearFanOutCache } from "./multi-shop.server.js";
import { loader, action } from "../../routes/api.mcp.js";
import { createTestDb, seedOffer, seedShop } from "../test-support/pglite-db.js";

const env = {
  MCP_ENABLED: "true",
  MCP_TOKEN_PEPPER: "test-pepper-0123456789",
  MCP_WRITE_SHOPS: "hpn-test-store.myshopify.com",
} as NodeJS.ProcessEnv;
const allowAll: RateLimiter = async () => ({ ok: true });

let db: Db;
let close: () => Promise<void>;
let pat: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ pat } = await createOperatorWithPat(db, { email: "owner@example.com", name: "Owner", role: "admin", shopAllowList: ["*"] }, env));
  const testShop = await seedShop(db, "hpn-test-store.myshopify.com");
  await seedShop(db, "hpn.myshopify.com");
  const uninstalled = await seedShop(db, "gone.myshopify.com");
  await db.update(shops).set({ uninstalledAt: new Date() }).where(eq(shops.id, uninstalled));
  await db.update(shops).set({ currencyCode: "EUR", timezone: "Europe/Madrid" }).where(eq(shops.myshopifyDomain, "hpn.myshopify.com"));
  await db.insert(appSettings).values({ shopId: testShop, key: "mcp.writeMode", value: JSON.stringify("write") });
  await seedOffer(db, testShop, { status: "active" });
  await seedOffer(db, testShop, { status: "draft" });
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => clearFanOutCache());

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${pat}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
const call = (body: unknown, headers?: Record<string, string>, e = env) =>
  handleMcpRequest(rpc(body, headers), { db, env: e, rateLimit: allowAll });

describe("MCP_ENABLED gate", () => {
  it("is 404 without MCP_ENABLED, even with a valid token", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined, { ...env, MCP_ENABLED: undefined });
    expect(res.status).toBe(404);
  });
  it("is 404 for any value other than 'true'", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined, { ...env, MCP_ENABLED: "1" });
    expect(res.status).toBe(404);
  });
  it("is 503 UPSTREAM_UNAVAILABLE without a usable pepper, before any DB call", async () => {
    const throwingDb = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as unknown as Db;
    for (const MCP_TOKEN_PEPPER of [undefined, "", "short"]) {
      const res = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {
        db: throwingDb,
        env: { ...env, MCP_TOKEN_PEPPER },
        rateLimit: allowAll,
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toEqual({ code: "UPSTREAM_UNAVAILABLE", message: "MCP not configured" });
    }
  });
  describe("route module", () => {
    const saved = process.env["MCP_ENABLED"];
    afterEach(() => {
      if (saved === undefined) delete process.env["MCP_ENABLED"];
      else process.env["MCP_ENABLED"] = saved;
    });
    it("loader and action answer 404 and never touch the database", async () => {
      delete process.env["MCP_ENABLED"];
      const request = () => new Request("http://localhost/api/mcp", { method: "POST", body: "{}" });
      expect((await loader({ request: request() } as never)).status).toBe(404);
      expect((await action({ request: request() } as never)).status).toBe(404);
    });
  });
  it("vercel.json files never carry an alias", () => {
    for (const file of ["../../../../../vercel.json", "../../../vercel.json"]) {
      const text = readFileSync(resolve(__dirname, file), "utf8");
      expect(JSON.parse(text)).not.toHaveProperty("alias");
    }
  });
});

describe("auth on the route", () => {
  it("401 with WWW-Authenticate for missing, wrong and expired tokens", async () => {
    for (const authorization of ["", "Bearer pemcp_wrong"]) {
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    const { pat: expired } = await createOperatorWithPat(
      db,
      { email: "old@example.com", name: "Old", role: "viewer", shopAllowList: ["*"], ttlDays: 1 },
      env,
      new Date("2020-01-01T00:00:00Z"),
    );
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
  });
  it("429 with Retry-After when rate limited, before touching the DB", async () => {
    const res = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {
      db,
      env,
      rateLimit: async () => ({ ok: false, retryAfterSeconds: 7 }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });
});

describe("MCP protocol over the route (pglite)", () => {
  it("initialize", async () => {
    const res = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = await res.json();
    expect(json.result.serverInfo.name).toBe("promo-engine");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("tools/list exposes shops_list as read-only", async () => {
    const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const json = await res.json();
    const tool = json.result.tools.find((t: { name: string }) => t.name === "shops_list");
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it("tools/call shops_list returns the contract with write mode locked to hpn-test-store", async () => {
    const res = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "shops_list", arguments: {} } });
    const json = await res.json();
    expect(json.result.isError).toBeFalsy();
    const out = json.result.structuredContent;
    expect(Object.keys(out).sort()).toEqual(["data", "links", "meta", "nextActions", "summary", "warnings"].concat("perShop").sort());
    expect(out.meta.generatedAt).toMatch(/Z$/);
    const byDomain = Object.fromEntries(out.data.shops.map((s: { shopDomain: string }) => [s.shopDomain, s]));
    expect(Object.keys(byDomain).sort()).toEqual(["hpn-test-store.myshopify.com", "hpn.myshopify.com"]);
    expect(byDomain["hpn-test-store.myshopify.com"]).toMatchObject({
      shopHandle: "hpn-test-store",
      currency: "USD",
      timezone: "UTC",
      writeMode: "write",
      activeOffers: 1,
    });
    expect(byDomain["hpn.myshopify.com"]).toMatchObject({ currency: "EUR", timezone: "Europe/Madrid", writeMode: "read_only" });
    expect(JSON.stringify(out)).not.toMatch(/access_token|accessToken/i);
    expect(out.perShop.every((p: { status: string }) => p.status === "ok")).toBe(true);
    expect(json.result.content[0].text).toContain("2 shops visible");
  });

  it("the env lock wins over the per-shop setting, and vice versa", async () => {
    const hpn = await db.select().from(shops).where(eq(shops.myshopifyDomain, "hpn.myshopify.com"));
    await db.insert(appSettings).values({ shopId: hpn[0]!.id, key: "mcp.writeMode", value: JSON.stringify("write") });
    const res = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "shops_list", arguments: {} } });
    const modes = Object.fromEntries(
      (await res.json()).result.structuredContent.data.shops.map((s: { shopDomain: string; writeMode: string }) => [s.shopDomain, s.writeMode]),
    );
    expect(modes["hpn.myshopify.com"]).toBe("read_only");

    clearFanOutCache();
    const noSetting = await call(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "shops_list", arguments: {} } },
      undefined,
      { ...env, MCP_WRITE_SHOPS: "" },
    );
    const m2 = (await noSetting.json()).result.structuredContent.data.shops.map((s: { writeMode: string }) => s.writeMode);
    expect(m2).toEqual(["read_only", "read_only"]);
  });

  it("an allow-listed operator sees only its shops and asking for another is SHOP_NOT_FOUND", async () => {
    const { pat: scoped } = await createOperatorWithPat(
      db,
      { email: "scoped@example.com", name: "S", role: "viewer", shopAllowList: ["hpn.myshopify.com"] },
      env,
    );
    const headers = { authorization: `Bearer ${scoped}` };
    const ok = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "shops_list", arguments: {} } }, headers);
    expect((await ok.json()).result.structuredContent.data.shops.map((s: { shopDomain: string }) => s.shopDomain)).toEqual(["hpn.myshopify.com"]);

    const bad = await call(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "shops_list", arguments: { shops: ["hpn-test-store"] } } },
      headers,
    );
    const json = await bad.json();
    expect(json.result.isError).toBe(true);
    expect(json.result.structuredContent).toMatchObject({ code: "SHOP_NOT_FOUND", mcp: "promo-engine" });
    expect(json.result.structuredContent.suggestedAction.tool).toBe("shops_list");
  });

  it("an operator with an empty allow list sees no shops", async () => {
    const { pat: none } = await createOperatorWithPat(db, { email: "none@example.com", name: "N", role: "viewer", shopAllowList: [] }, env);
    const res = await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "shops_list", arguments: {} } }, { authorization: `Bearer ${none}` });
    expect((await res.json()).result.structuredContent.data.shops).toEqual([]);
  });

  it("uses the Vercel-set client IP for the per-IP limit", async () => {
    const keys: string[] = [];
    await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "x-forwarded-for": "6.6.6.6", "x-vercel-forwarded-for": "7.7.7.7" }), {
      db,
      env,
      rateLimit: async (key) => (keys.push(key), { ok: true }),
    });
    expect(keys[0]).toBe("mcp:ip:7.7.7.7");
  });

  it("filters by handle", async () => {
    const res = await call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "shops_list", arguments: { shops: ["hpn"] } } });
    const shopsOut = (await res.json()).result.structuredContent.data.shops;
    expect(shopsOut).toHaveLength(1);
  });
});

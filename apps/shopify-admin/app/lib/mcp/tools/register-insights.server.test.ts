import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appSettings, type Db } from "@promo/db";
import { handleMcpRequest, type RateLimiter } from "../handler.server.js";
import { createOperatorWithPat } from "../auth.server.js";
import { clearFanOutCache } from "../multi-shop.server.js";
import { createTestDb, seedOffer } from "../../test-support/pglite-db.js";
import { insertEvents, seedWorld } from "./insights-test-fixtures.js";

const env = { MCP_ENABLED: "true", MCP_TOKEN_PEPPER: "test-pepper-0123456789", MCP_WRITE_SHOPS: "alpha.myshopify.com" } as NodeJS.ProcessEnv;
const allowAll: RateLimiter = async () => ({ ok: true });

let db: Db;
let close: () => Promise<void>;
let adminPat: string;
let scopedPat: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const world = await seedWorld(db);
  await db.insert(appSettings).values({ shopId: world.alpha, key: "mcp.writeMode", value: JSON.stringify("write") });
  const offer = await seedOffer(db, world.alpha, { internalName: "Alpha gift" });
  await insertEvents(db, { shopId: world.alpha, offerId: offer, name: "promo_engine:widget_viewed", at: new Date().toISOString(), n: 3 });
  ({ pat: adminPat } = await createOperatorWithPat(db, { email: "admin@example.com", name: "Admin", role: "admin", shopAllowList: ["*"] }, env));
  ({ pat: scopedPat } = await createOperatorWithPat(db, { email: "scoped@example.com", name: "Scoped", role: "viewer", shopAllowList: ["beta.myshopify.com"] }, env));
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => clearFanOutCache());

async function rpc(method: string, params: unknown, pat = adminPat) {
  const res = await handleMcpRequest(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${pat}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    { db, env, rateLimit: allowAll },
  );
  return (await res.json()).result;
}
const callTool = (name: string, args: unknown = {}, pat?: string) => rpc("tools/call", { name, arguments: args }, pat);

describe("insights tools over the MCP endpoint", () => {
  it("registers the five tools as read-only", async () => {
    const { tools } = await rpc("tools/list", {});
    const byName = Object.fromEntries(tools.map((t: { name: string }) => [t.name, t]));
    for (const name of ["mcp_whoami", "promo_performance", "promo_audit_log", "promo_health", "suggest_promo_tests", "shops_list"]) {
      expect(byName[name], name).toBeDefined();
      expect(byName[name].annotations.readOnlyHint).toBe(true);
    }
  });

  it("mcp_whoami reports operator, role, visible shops and write mode", async () => {
    const out = (await callTool("mcp_whoami")).structuredContent;
    expect(out.data.operator).toMatchObject({ email: "admin@example.com", role: "admin", shopAccess: "all" });
    expect(out.data.shops.map((s: { shopDomain: string; writeMode: string }) => [s.shopDomain, s.writeMode])).toEqual([
      ["alpha.myshopify.com", "write"],
      ["beta.myshopify.com", "read_only"],
    ]);
    expect(out.data.server.writeEnabledShops).toEqual(["alpha.myshopify.com"]);
    expect(JSON.stringify(out)).not.toMatch(/pemcp_|pepper|token_hash/i);
  });

  it("mcp_whoami for a scoped viewer hides the other shops", async () => {
    const out = (await callTool("mcp_whoami", {}, scopedPat)).structuredContent;
    expect(out.data.operator).toMatchObject({ role: "viewer", shopAccess: "list" });
    expect(out.data.shops.map((s: { shopDomain: string }) => s.shopDomain)).toEqual(["beta.myshopify.com"]);
    expect(out.data.server.writeEnabledShops).toEqual([]);
  });

  it("promo_performance answers with the contract and validates input", async () => {
    const ok = await callTool("promo_performance", { lastDays: 30 });
    expect(ok.isError).toBeFalsy();
    expect(Object.keys(ok.structuredContent).sort()).toEqual(["data", "links", "meta", "nextActions", "perShop", "summary", "warnings"]);
    expect(ok.structuredContent.data.totals.counts.views).toBe(3);

    const tooLong = await callTool("promo_performance", { lastDays: 365 });
    expect(tooLong.isError).toBe(true);

    const hidden = await callTool("promo_performance", { shops: ["alpha"] }, scopedPat);
    expect(hidden.isError).toBe(true);
    expect(hidden.structuredContent).toMatchObject({ code: "SHOP_NOT_FOUND", mcp: "promo-engine" });
  });

  it("promo_audit_log and promo_health run for a viewer scope", async () => {
    const audit = await callTool("promo_audit_log", {}, scopedPat);
    expect(audit.isError).toBeFalsy();
    expect(audit.structuredContent.data.events).toEqual([]);
    const health = await callTool("promo_health", {}, scopedPat);
    expect(health.isError).toBeFalsy();
    expect(health.structuredContent.data.counts.total).toBe(0);
  });
});

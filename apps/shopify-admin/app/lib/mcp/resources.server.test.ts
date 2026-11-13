import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@promo/db";
import { handleMcpRequest, type RateLimiter } from "./handler.server.js";
import { createOperatorWithPat } from "./auth.server.js";
import { clearFanOutCache } from "./multi-shop.server.js";
import { createTestDb, seedOffer } from "../test-support/pglite-db.js";
import { seedWorld } from "./tools/insights-test-fixtures.js";
import { z } from "zod";
import { CREATE_OFFER_ARGS } from "./resources.server.js";
import { promoCreateInput } from "./tools/promo-authoring.server.js";

const env = { MCP_ENABLED: "true", MCP_TOKEN_PEPPER: "test-pepper-0123456789" } as NodeJS.ProcessEnv;
const allowAll: RateLimiter = async () => ({ ok: true });

let db: Db;
let close: () => Promise<void>;
let adminPat: string;
let scopedPat: string;
let alphaOffer: string;
let betaOffer: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const world = await seedWorld(db);
  alphaOffer = await seedOffer(db, world.alpha, { internalName: "Alpha gift" });
  betaOffer = await seedOffer(db, world.beta, { internalName: "Beta gift" });
  ({ pat: adminPat } = await createOperatorWithPat(db, { email: "admin@example.com", name: "Admin", role: "admin", shopAllowList: ["*"] }, env));
  ({ pat: scopedPat } = await createOperatorWithPat(db, { email: "scoped@example.com", name: "Scoped", role: "viewer", shopAllowList: ["beta.myshopify.com"] }, env));
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => clearFanOutCache());

async function rpc(method: string, params: unknown = {}, pat = adminPat) {
  const res = await handleMcpRequest(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${pat}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    { db, env, rateLimit: allowAll },
  );
  return res.json();
}
const read = (uri: string, pat?: string) => rpc("resources/read", { uri }, pat);

describe("MCP resources", () => {
  it("lists static docs and only visible shop capacity resources", async () => {
    const all = (await rpc("resources/list")).result.resources.map((r: { uri: string }) => r.uri);
    expect(all).toEqual(expect.arrayContaining(["docs://offer-types", "docs://page-conditions", "docs://tool-catalog", "docs://full-access", "docs://authoring","shop://alpha.myshopify.com/capacity", "shop://beta.myshopify.com/capacity"]));
    expect(all.join()).not.toContain("gone.myshopify.com");
    const scoped = (await rpc("resources/list", {}, scopedPat)).result.resources.map((r: { uri: string }) => r.uri);
    expect(scoped).toContain("shop://beta.myshopify.com/capacity");
    expect(scoped.join()).not.toContain("alpha.myshopify.com");
  });

  it("lists the templates", async () => {
    const t = (await rpc("resources/templates/list")).result.resourceTemplates.map((r: { uriTemplate: string }) => r.uriTemplate);
    expect(t).toEqual(expect.arrayContaining(["shop://{shop}/capacity", "promo://{shop}/{offerId}"]));
  });

  it("reads shop capacity like discount_capacity", async () => {
    const body = JSON.parse((await read("shop://alpha.myshopify.com/capacity")).result.contents[0].text);
    expect(body.data.shops).toHaveLength(1);
    expect(body.data.shops[0]).toMatchObject({ shopDomain: "alpha.myshopify.com", limit: 9500 });
  });

  it("reads promo detail", async () => {
    const body = JSON.parse((await read(`promo://alpha.myshopify.com/${alphaOffer}`)).result.contents[0].text);
    expect(JSON.stringify(body)).toContain("Alpha gift");
  });

  it("reads the docs", async () => {
    const offerTypes = (await read("docs://offer-types")).result.contents[0].text as string;
    expect(offerTypes).toContain("times the gift SET is granted");
    expect(offerTypes).toContain("Picker");
    const page = (await read("docs://page-conditions")).result.contents[0].text as string;
    expect(page).toContain("excludeUrls");
    expect(page).toContain("test group");
  });

  it("tool catalog lists every registered tool exactly once and nothing else", async () => {
    const registered = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name) as string[];
    const catalog = (await read("docs://tool-catalog")).result.contents[0].text as string;
    const listed = [...catalog.matchAll(/^- `([a-z0-9_]+)` \((?:read|write)\)/gm)].map((m) => m[1]!);
    expect(new Set(listed).size).toBe(listed.length);
    expect(registered.filter((n) => !listed.includes(n))).toEqual([]);
    expect(listed.filter((n) => !registered.includes(n))).toEqual([]);
    for (const area of ["Catalog", "Authoring", "Conditions", "Rewards", "Gifts", "Codes", "Shipping and subscription", "Combinations and priority", "Widgets and boosters", "Lifecycle and bulk", "Translations", "Preview", "Settings", "Capacity and diagnostics", "Analytics, logs and debug", "CSV"]) {
      expect(catalog).toContain(`## ${area}`);
    }
  });

  it("describes full access and never the old gating", async () => {
    const texts: string[] = [];
    for (const uri of ["docs://tool-catalog", "docs://full-access", "docs://authoring", "docs://offer-types", "docs://page-conditions"]) {
      texts.push((await read(uri)).result.contents[0].text as string);
    }
    const access = texts[1]!;
    for (const s of ["every authenticated operator", "dryRun", "idempotencyKey", "expectedUpdatedAt", "CAPACITY_LIMIT", "workarounds", "audit", "GraphiQL", "promo_audit_log"]) {
      expect(access.toLowerCase()).toContain(s.toLowerCase());
    }
    const all = texts.join("\n");
    expect(all).not.toMatch(/SHOP_READ_ONLY|MCP_WRITE_SHOPS|MCP_CONFIRM_SECRET|read-only shop/i);
    expect(all).not.toMatch(/confirmToken[^\n]*(required|must|then execute)/i);
  });

  it("the worked example is a valid promo_create input", async () => {
    const parsed = z.strictObject(promoCreateInput).safeParse(CREATE_OFFER_ARGS);
    expect(parsed.success).toBe(true);
    const doc = (await read("docs://authoring")).result.contents[0].text as string;
    for (const s of ["9208279269615", "quantityTiers", "catalog_search", "promo_preview_cart", "promo_set_status", "promo_detail"]) expect(doc).toContain(s);
  });

  it("rejects invisible or unknown shops and never returns their data", async () => {
    for (const uri of [
      "shop://alpha.myshopify.com/capacity",
      `promo://alpha.myshopify.com/${alphaOffer}`,
      "shop://gone.myshopify.com/capacity",
      "shop://nope.myshopify.com/capacity",
    ]) {
      const res = await read(uri, scopedPat);
      expect(res.error, uri).toBeTruthy();
      expect(res.result).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain("Alpha gift");
    }
    const ok = await read(`promo://beta.myshopify.com/${betaOffer}`, scopedPat);
    expect(ok.error).toBeUndefined();
  });
});

describe("MCP prompts", () => {
  it("lists the prompts", async () => {
    const names = (await rpc("prompts/list")).result.prompts.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["promo_weekly_readout", "promo_test_ideas", "why_not_applying", "create_offer", "rollback_mcp_change"]));
  });

  it("create_offer walks catalog_search, promo_create, preview, activate, detail in order, with the OneSol example", async () => {
    const t = await prompt("create_offer", { shop: "onesolsupps", request: "Protein bundle 1x 20%, 2x 30%" });
    const order = ["catalog_search", "promo_create", "promo_preview_cart", "promo_set_status", "promo_detail"].map((s) => t.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const s of ["9208279269615", "quantityTiers", "CAPACITY_LIMIT", "idempotencyKey"]) expect(t).toContain(s);
    expect(t).not.toContain("confirmToken");
  });

  it("rollback_mcp_change reads the audit log and pauses first", async () => {
    const t = await prompt("rollback_mcp_change", { ref: "promo:alpha:abc" });
    for (const s of ["promo_audit_log", "paused", "promo_update", "promo:alpha:abc"]) expect(t).toContain(s);
  });

  const prompt = async (name: string, args: Record<string, string>) =>
    (await rpc("prompts/get", { name, arguments: args })).result.messages[0].content.text as string;

  it("weekly readout guides to the three tools", async () => {
    const t = await prompt("promo_weekly_readout", { shops: "alpha", lastDays: "14" });
    for (const s of ["promos_active", "promo_performance", "promo_health", "lastDays=14", "alpha"]) expect(t).toContain(s);
  });

  it("test ideas joins both MCPs", async () => {
    const t = await prompt("promo_test_ideas", { shop: "alpha.myshopify.com", goal: "AOV" });
    for (const s of ["suggest_promo_tests", "experiments_list", "results_get", "shopDomain", "AOV"]) expect(t).toContain(s);
  });

  it("why_not_applying uses conditions explain and detail", async () => {
    const t = await prompt("why_not_applying", { ref: "promo:alpha:abc", pageUrl: "/products/mug" });
    for (const s of ["page_conditions_explain", "promo_detail", "/products/mug"]) expect(t).toContain(s);
  });
});

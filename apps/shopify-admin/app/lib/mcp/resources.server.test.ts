import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@promo/db";
import { handleMcpRequest, type RateLimiter } from "./handler.server.js";
import { createOperatorWithPat } from "./auth.server.js";
import { clearFanOutCache } from "./multi-shop.server.js";
import { createTestDb, seedOffer } from "../test-support/pglite-db.js";
import { seedWorld } from "./tools/insights-test-fixtures.js";

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
    expect(all).toEqual(expect.arrayContaining(["docs://offer-types", "docs://page-conditions", "shop://alpha.myshopify.com/capacity", "shop://beta.myshopify.com/capacity"]));
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
  it("lists the three prompts", async () => {
    const names = (await rpc("prompts/list")).result.prompts.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["promo_weekly_readout", "promo_test_ideas", "why_not_applying"]));
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

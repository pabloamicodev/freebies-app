import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleDefinitions, bundleTiers, offerConditions, type Db } from "@promo/db";
import { clearFanOutCache } from "../multi-shop.server.js";
import { createTestDb, seedOffer } from "../../test-support/pglite-db.js";

const gql = vi.hoisted(() => ({
  calls: [] as { shopDomain: string; accessToken: string; query: string }[],
  directory: JSON.stringify({
    v: 1,
    experiments: [
      { id: "abcd1234", name: "PDP hero", status: "RUNNING", mode: "inline", variants: [{ key: "control", name: "Control", control: true }, { key: "b", name: "B" }] },
    ],
  }),
}));

vi.mock("../../shopify-fetch.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shopify-fetch.server.js")>()),
  shopifyGraphQL: async (args: { shopDomain: string; accessToken: string; query: string }) => {
    gql.calls.push(args);
    if (args.shopDomain === "beta.myshopify.com") throw new Error("Shopify down");
    return { shop: { metafield: { value: gql.directory } } };
  },
}));

import { NOW, SECRET_VALUES, insertEvents, now, operatorAll, seedWorld } from "./insights-test-fixtures.js";
import { suggestPromoTests } from "./suggest-promo-tests.server.js";

let db: Db;
let close: () => Promise<void>;
let world: Awaited<ReturnType<typeof seedWorld>>;
const ids: Record<string, string> = {};

const DAY = "2026-10-25T10:00:00.000Z";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  world = await seedWorld(db);

  ids["giftA"] = await seedOffer(db, world.alpha, { type: "gift", internalName: "Gift A" });
  ids["limited"] = await seedOffer(db, world.alpha, { type: "gift", internalName: "Gift limited" });
  ids["bound"] = await seedOffer(db, world.alpha, { type: "gift", internalName: "Gift bound" });
  ids["stale"] = await seedOffer(db, world.alpha, { type: "gift", internalName: "Gift stale" });
  ids["lowAdd"] = await seedOffer(db, world.alpha, { type: "gift", internalName: "Gift low add" });
  ids["bundleFlat"] = await seedOffer(db, world.alpha, { type: "bundle", internalName: "Bundle flat" });
  ids["bundleTiered"] = await seedOffer(db, world.alpha, { type: "bundle", internalName: "Bundle tiered" });
  ids["paused"] = await seedOffer(db, world.alpha, { type: "gift", internalName: "Gift paused", status: "paused" });
  ids["betaGift"] = await seedOffer(db, world.beta, { type: "gift", internalName: "Beta gift" });
  await seedOffer(db, world.gone, { type: "gift", internalName: "Gone gift" });

  const cond = (shopId: string, offerId: string, conditionType: string, value: Record<string, unknown>) =>
    ({ shopId, offerId, scope: "main" as const, conditionType, operator: "gte" as const, value });
  await db.insert(offerConditions).values([
    cond(world.alpha, ids["giftA"]!, "cart_value", { thresholdCents: 4800, currencyCode: "USD" }),
    cond(world.alpha, ids["limited"]!, "one_use_per_customer", {}),
    cond(world.alpha, ids["limited"]!, "cart_value", { thresholdCents: 100, currencyCode: "USD" }),
    cond(world.alpha, ids["bound"]!, "experiment", { experimentId: "abcd1234", experimentName: "PDP hero", variantKeys: ["b"] }),
    cond(world.alpha, ids["stale"]!, "experiment", { experimentId: "deadbeef", variantKeys: ["a"] }),
    cond(world.alpha, ids["lowAdd"]!, "one_use_per_customer", {}),
  ]);
  const [flat] = await db.insert(bundleDefinitions).values({ shopId: world.alpha, offerId: ids["bundleFlat"]!, bundleType: "classic", title: "Flat" }).returning({ id: bundleDefinitions.id });
  const [tiered] = await db.insert(bundleDefinitions).values({ shopId: world.alpha, offerId: ids["bundleTiered"]!, bundleType: "classic", title: "Tiered" }).returning({ id: bundleDefinitions.id });
  expect(flat).toBeDefined();
  await db.insert(bundleTiers).values({ shopId: world.alpha, bundleId: tiered!.id, minQuantity: 2, label: "2+", discountType: "percentage", value: { default: 10 } });

  // AOV 50.00 USD from 10 attributed orders on Gift A; the paused and uninstalled offers must not matter.
  for (let i = 0; i < 10; i++) {
    await insertEvents(db, { shopId: world.alpha, offerId: ids["giftA"]!, name: "order_placed_attributed", at: DAY, orderId: `gid://shopify/Order/${100 + i}`, properties: { subtotalCents: 5000 } });
  }
  await insertEvents(db, { shopId: world.alpha, offerId: ids["giftA"]!, name: "promo_engine:widget_viewed", at: DAY, n: 40 });
  await insertEvents(db, { shopId: world.alpha, offerId: ids["giftA"]!, name: "promo_engine:gift_auto_added", at: DAY, n: 20 });
  await insertEvents(db, { shopId: world.alpha, offerId: ids["lowAdd"]!, name: "promo_engine:widget_viewed", at: DAY, n: 200 });
  await insertEvents(db, { shopId: world.alpha, offerId: ids["lowAdd"]!, name: "promo_engine:gift_added", at: DAY, n: 2 });
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  clearFanOutCache();
  gql.calls.length = 0;
});

const run = async (args: Parameters<typeof suggestPromoTests>[2] = {}) => suggestPromoTests(db, await world.visible(), args, now);
const alphaShop = (res: Awaited<ReturnType<typeof run>>) => res.data.shops.find((s) => s.shopDomain === "alpha.myshopify.com")!;

describe("suggest_promo_tests", () => {
  it("detects the gaps with their offers", async () => {
    const res = await run();
    const gaps = alphaShop(res).gaps.map((g) => `${g.kind}:${g.offerName ?? "-"}`).sort();
    expect(gaps).toEqual(
      [
        "gift_no_limit:Gift A",
        "gift_threshold_near_aov:Gift A",
        "bundle_no_tiers:Bundle flat",
        "low_add_rate:Gift low add",
        "binding_stale:Gift stale",
        "offer_no_impressions:Gift bound",
        "offer_no_impressions:Gift limited",
        "offer_no_impressions:Gift stale",
        "offer_no_impressions:Bundle flat",
        "offer_no_impressions:Bundle tiered",
      ].sort(),
    );
    expect(gaps.join()).not.toContain("Gift paused");
  });

  it("does not fire gaps for offers with a limit, tiers or an experiment binding", async () => {
    const candidates = (await run()).data.candidates;
    const titles = candidates.map((c) => c.title);
    expect(titles.some((t) => t.includes("Gift limited"))).toBe(false);
    expect(titles.some((t) => t.includes("Bundle tiered"))).toBe(false);
    expect(titles.some((t) => t.includes("Gift bound"))).toBe(false);
    expect(titles.some((t) => t.includes("Gift stale"))).toBe(false);
  });

  it("builds TestIdea candidates with baseline, evidence and experiment-engine next actions", async () => {
    const res = await run({ goal: "aov" });
    const c = res.data.candidates;
    expect(c.map((x) => x.gap)).toEqual(["gift_threshold_near_aov", "bundle_no_tiers", "gift_no_limit", "gift_no_limit", "low_add_rate"]);
    const threshold = c[0]!;
    expect(threshold).toMatchObject({
      shopDomain: "alpha.myshopify.com",
      suggestedExperimentType: "OFFER_TEST",
      primaryMetric: "aov",
      shopRefs: ["alpha.myshopify.com"],
      promoRef: `promo:alpha:${ids["giftA"]}`,
      confidence: "low",
    });
    expect(threshold.baseline).toMatchObject({ metric: "aov", value: "50.00 USD" });
    expect(threshold.arms.map((a) => a.key)).toEqual(["control", "higher_threshold"]);
    expect(threshold.arms[0]!.promoRef).toBe(`promo:alpha:${ids["giftA"]}`);
    expect(threshold.arms[1]!.promoRef).toBeUndefined();
    expect(threshold.risks.length).toBeGreaterThan(0);
    expect(threshold.evidence[0]).toMatchObject({ source: "promo-engine" });

    const ee = threshold.nextActions.find((a) => a.mcp === "experiment-engine")!;
    expect(ee).toMatchObject({ tool: "experiments_create", risk: "write" });
    expect(ee.args).toMatchObject({ shop: "alpha.myshopify.com", type: "OFFER_TEST", primaryMetric: "aov", dryRun: true });
    expect((ee.args["variants"] as unknown[]).length).toBe(2);
    expect(threshold.nextActions.find((a) => a.mcp === "promo-engine")).toMatchObject({ tool: "promo_duplicate", risk: "write" });

    const content = c.find((x) => x.gap === "low_add_rate")!;
    expect(content.suggestedExperimentType).toBe("CONTENT_TEST");
    expect(content.baseline?.value).toBe("1.00% add rate");
  });

  it("orders candidates by goal without hiding any", async () => {
    const aov = (await run({ goal: "aov" })).data.candidates.map((x) => x.gap);
    const conversion = (await run({ goal: "conversion" })).data.candidates.map((x) => x.gap);
    const retention = (await run({ goal: "retention" })).data.candidates.map((x) => x.gap);
    expect(conversion[0]).toBe("low_add_rate");
    expect(retention[0]).toBe("gift_no_limit");
    expect([...conversion].sort()).toEqual([...aov].sort());
    expect([...retention].sort()).toEqual([...aov].sort());
  });

  it("returns the experiment directory per shop, flags unreadable ones and the bindings", async () => {
    const res = await run();
    const alpha = res.data.experimentDirectory.find((d) => d.shopDomain === "alpha.myshopify.com")!;
    expect(alpha.available).toBe(true);
    expect(alpha.experiments[0]).toMatchObject({ id: "abcd1234", name: "PDP hero", status: "RUNNING", mode: "inline" });
    expect(alpha.experiments[0]!.variants.map((v) => v.key)).toEqual(["control", "b"]);
    const beta = res.data.experimentDirectory.find((d) => d.shopDomain === "beta.myshopify.com")!;
    expect(beta).toEqual({ shopDomain: "beta.myshopify.com", available: false, experiments: [] });
    expect(res.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["EE_DIRECTORY_UNAVAILABLE", "BINDING_STALE"]));

    const bindings = Object.fromEntries(res.data.experimentBindings.map((b) => [b.offerName, b]));
    expect(bindings["Gift bound"]).toMatchObject({ experimentId: "abcd1234", experimentName: "PDP hero", variantKeys: ["b"], inDirectory: true, directoryStatus: "RUNNING" });
    expect(bindings["Gift stale"]).toMatchObject({ experimentId: "deadbeef", inDirectory: false });
  });

  it("only stubs the Shopify read: one directory query per visible shop, never the Experiment Engine", async () => {
    const res = await run();
    expect(gql.calls.map((c) => c.shopDomain).sort()).toEqual(["alpha.myshopify.com", "beta.myshopify.com"]);
    expect(gql.calls.every((c) => c.query.includes("metafield"))).toBe(true);
    expect(res.nextActions.map((a) => `${a.mcp}:${a.tool}`)).toContain("experiment-engine:experiments_list");
    expect(res.nextActions.find((a) => a.tool === "experiments_list")!.args).toEqual({ shops: ["alpha.myshopify.com", "beta.myshopify.com"] });
  });

  it("summarizes active promos with performance, baseline per shop and hides uninstalled or paused ones", async () => {
    const res = await run();
    const alpha = alphaShop(res);
    const names = alpha.activePromos.map((p) => p.name);
    expect(names).not.toContain("Gift paused");
    expect(names).toHaveLength(7);
    const giftA = alpha.activePromos.find((p) => p.name === "Gift A")!;
    expect(giftA.performance.counts).toMatchObject({ views: 40, adds: 20, orders: 10 });
    expect(giftA.performance.rates.addRate).toBe(0.5);
    expect(alpha.baseline.aov).toEqual([{ amount: "50.00", currency: "USD" }]);
    expect(res.data.shops.map((s) => s.shopDomain)).toEqual(["alpha.myshopify.com", "beta.myshopify.com"]);
    expect(res.data.shops.find((s) => s.shopDomain === "beta.myshopify.com")!.baseline.aov).toEqual([]);
    await expect(run({ shops: ["gone"] })).rejects.toMatchObject({ payload: { code: "SHOP_NOT_FOUND" } });
  });

  it("does not suggest a threshold test without order data", async () => {
    const res = await run({ shops: ["beta"] });
    expect(res.data.candidates.map((c) => c.gap)).toEqual(["gift_no_limit"]);
    expect(res.data.shops[0]!.gaps.map((g) => g.kind)).not.toContain("gift_threshold_near_aov");
  });

  it("paginates candidates and validates the cursor", async () => {
    const first = await run({ limit: 2 });
    expect(first.data.candidates).toHaveLength(2);
    expect(first.meta.page?.hasMore).toBe(true);
    const second = await run({ limit: 2, cursor: first.meta.page!.cursor! });
    expect(second.data.candidates).toHaveLength(2);
    expect(second.meta.page?.hasMore).toBe(true);
    const third = await run({ limit: 2, cursor: second.meta.page!.cursor! });
    expect(third.data.candidates).toHaveLength(1);
    expect(third.meta.page?.hasMore).toBe(false);
    await expect(run({ cursor: "###" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
  });

  it("never outputs identifiers, tokens or customer data", async () => {
    const json = JSON.stringify(await run());
    for (const secret of Object.values(SECRET_VALUES)) expect(json).not.toContain(secret);
    expect(json).not.toMatch(/accessToken|access_token|customer_?id|session_?id|cart_?token|order_?id/i);
    expect(json).not.toContain("Gone gift");
  });

  it("an allow-listed operator only gets its own shop's data", async () => {
    const visible = await world.visible({ ...operatorAll, shopAllowList: ["beta.myshopify.com"] });
    const res = await suggestPromoTests(db, visible, {}, now);
    expect(res.data.shops.map((s) => s.shopDomain)).toEqual(["beta.myshopify.com"]);
    expect(gql.calls.map((c) => c.shopDomain)).toEqual(["beta.myshopify.com"]);
  });

  it("window defaults to 30 days", async () => {
    const res = await run();
    expect(res.meta.window).toEqual({ start: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(), end: NOW.toISOString() });
  });
});

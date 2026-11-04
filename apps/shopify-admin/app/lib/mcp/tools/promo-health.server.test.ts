import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, offers, shops, type Db } from "@promo/db";
import { clearFanOutCache } from "../multi-shop.server.js";
import { setOfferPublishErrors } from "../../offer-publish-errors.server.js";
import { createTestDb, seedOffer } from "../../test-support/pglite-db.js";
import { now, operatorAll, seedWorld } from "./insights-test-fixtures.js";
import { promoHealth } from "./promo-health.server.js";

let db: Db;
let close: () => Promise<void>;
let world: Awaited<ReturnType<typeof seedWorld>>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  world = await seedWorld(db);
  // alpha is wired (both nodes); beta has no nodes at all.
  await db.update(shops).set({ discountId: "gid://shopify/DiscountAutomaticNode/1", deliveryDiscountId: "gid://shopify/DiscountAutomaticNode/2" }).where(eq(shops.id, world.alpha));
  await db.update(shops).set({ publishPendingAt: new Date("2026-11-01T11:00:00.000Z") }).where(eq(shops.id, world.alpha));

  const compiled = { v: 1 };
  ids["broken"] = await seedOffer(db, world.alpha, { internalName: "Broken publish", compiledConfig: compiled });
  ids["paused"] = await seedOffer(db, world.alpha, { internalName: "System paused", status: "paused" });
  ids["resumed"] = await seedOffer(db, world.alpha, { internalName: "Resumed later", status: "active", compiledConfig: compiled });
  ids["nocompile"] = await seedOffer(db, world.alpha, { internalName: "Not compiled", status: "active" });
  ids["expired"] = await seedOffer(db, world.alpha, { internalName: "Past end", status: "active", compiledConfig: compiled, endsAt: new Date("2026-10-30T00:00:00Z") });
  ids["stuck"] = await seedOffer(db, world.alpha, { internalName: "Past start", status: "scheduled", startsAt: new Date("2026-10-31T00:00:00Z") });
  ids["fine"] = await seedOffer(db, world.alpha, { internalName: "Healthy", status: "active", compiledConfig: compiled });
  ids["archived"] = await seedOffer(db, world.alpha, { internalName: "Archived with error", status: "archived" });
  ids["betaActive"] = await seedOffer(db, world.beta, { internalName: "Beta live", status: "active", compiledConfig: compiled });
  ids["goneActive"] = await seedOffer(db, world.gone, { internalName: "Gone live", status: "active" });

  await setOfferPublishErrors(world.alpha, { [ids["broken"]!]: "Cannot publish: bad code", [ids["archived"]!]: "stale" }, db);
  await db.insert(auditLogs).values([
    {
      shopId: world.alpha, entityType: "offer", entityId: ids["paused"]!, action: "system_pause", performedBy: "system",
      before: { status: "active" }, after: { status: "paused", reason: "compile_error", error: "Bad product" }, createdAt: new Date("2026-10-31T08:00:00Z"),
    },
    {
      shopId: world.alpha, entityType: "offer", entityId: ids["resumed"]!, action: "system_pause", performedBy: "system",
      after: { status: "paused", reason: "compile_error" }, createdAt: new Date("2026-10-31T09:00:00Z"),
    },
    {
      shopId: world.alpha, entityType: "offer", entityId: ids["paused"]!, action: "system_pause", performedBy: "system",
      after: { reason: "old" }, createdAt: new Date("2026-08-01T09:00:00Z"),
    },
  ]);
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => clearFanOutCache());

const run = async (args: Parameters<typeof promoHealth>[2] = {}) => promoHealth(db, await world.visible(), args, now);
const kinds = (res: Awaited<ReturnType<typeof run>>) => res.data.findings.map((f) => `${f.shopHandle}:${f.kind}:${f.offerName ?? "-"}`);

describe("promo_health", () => {
  it("finds publish errors, system pauses, pending publishes and drift, prioritized", async () => {
    const res = await run();
    expect(kinds(res).sort()).toEqual(
      [
        "alpha:publish_error:Broken publish",
        "alpha:system_pause:System paused",
        "alpha:publish_pending:-",
        "alpha:offer_not_compiled:Not compiled",
        "alpha:schedule_drift:Past end",
        "alpha:schedule_drift:Past start",
        "beta:missing_discount_node:-",
      ].sort(),
    );
    const severities = res.data.findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, z) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(z)));
    expect(res.data.counts.total).toBe(7);
    expect(res.data.counts.bySeverity).toEqual({ high: 5, medium: 2, low: 0 });
    expect(res.data.counts.byKind.schedule_drift).toBe(2);
  });

  it("ignores archived offers, resumed offers, healthy offers and uninstalled shops", async () => {
    const text = JSON.stringify(await run());
    expect(text).not.toContain("Archived with error");
    expect(text).not.toContain("Resumed later");
    expect(text).not.toContain("Healthy");
    expect(text).not.toContain("Gone live");
    expect(text).not.toContain("gone.myshopify.com");
  });

  it("explains a system pause with its reason and uses the pending age for severity", async () => {
    const res = await run({ shops: ["alpha"] });
    const pause = res.data.findings.find((f) => f.kind === "system_pause")!;
    expect(pause.message).toContain("compile_error");
    expect(pause.message).toContain("Bad product");
    expect(pause.since).toBe("2026-10-31T08:00:00.000Z");
    expect(pause.promoRef).toBe(`promo:alpha:${ids["paused"]}`);
    const pending = res.data.findings.find((f) => f.kind === "publish_pending")!;
    expect(pending.severity).toBe("high");
    expect(pending.message).toContain("60 minute");
  });

  it("only looks as far back as lastDays for system pauses", async () => {
    const res = await run({ shops: ["alpha"], lastDays: 1 });
    expect(res.data.findings.some((f) => f.kind === "system_pause")).toBe(false);
  });

  it("each finding points to a next read tool", async () => {
    const res = await run();
    const tools = res.nextActions.map((a) => `${a.mcp}:${a.tool}`);
    expect(tools).toContain("promo-engine:promo_detail");
    expect(tools).toContain("promo-engine:promo_audit_log");
    expect(tools).toContain("promo-engine:discount_capacity");
    expect(res.nextActions.every((a) => a.risk === "read")).toBe(true);
    expect(res.nextActions.find((a) => a.tool === "promo_detail")!.args).toHaveProperty("ref");
  });

  it("is quiet for a healthy shop and pages through findings", async () => {
    await db.delete(offers).where(eq(offers.id, ids["betaActive"]!));
    clearFanOutCache();
    const beta = await run({ shops: ["beta"] });
    expect(beta.data.findings).toEqual([]);
    expect(beta.summary).toMatch(/No health issues/);

    const first = await run({ limit: 3 });
    expect(first.data.findings).toHaveLength(3);
    expect(first.meta.page?.hasMore).toBe(true);
    const second = await run({ limit: 3, cursor: first.meta.page!.cursor! });
    expect(second.data.findings.length).toBeGreaterThan(0);
    expect(second.data.findings[0]).not.toEqual(first.data.findings[0]);
  });

  it("scopes to the operator's shops", async () => {
    const visible = await world.visible({ ...operatorAll, shopAllowList: ["beta.myshopify.com"] });
    const res = await promoHealth(db, visible, {}, now);
    expect(res.data.findings.every((f) => f.shopDomain === "beta.myshopify.com")).toBe(true);
    await expect(promoHealth(db, visible, { shops: ["alpha"] }, now)).rejects.toMatchObject({ payload: { code: "SHOP_NOT_FOUND" } });
  });
});

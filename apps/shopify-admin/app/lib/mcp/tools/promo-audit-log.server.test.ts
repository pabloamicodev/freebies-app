import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditLogs, type Db } from "@promo/db";
import { createTestDb, seedOffer } from "../../test-support/pglite-db.js";
import { now, operatorAll, seedWorld } from "./insights-test-fixtures.js";
import { maskCode } from "./catalog-shared.server.js";
import { changesOf, maskActor, promoAuditLog, sanitizeAuditJson } from "./promo-audit-log.server.js";

let db: Db;
let close: () => Promise<void>;
let world: Awaited<ReturnType<typeof seedWorld>>;
let offerA: string;
let offerB: string;

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  world = await seedWorld(db);
  offerA = await seedOffer(db, world.alpha, { internalName: "Alpha gift" });
  offerB = await seedOffer(db, world.beta, { internalName: "Beta gift" });
  await db.insert(auditLogs).values([
    {
      shopId: world.alpha, entityType: "offer", entityId: offerA, action: "toggle_status", performedBy: "mcp:op-1",
      before: { status: "active", accessToken: "shpat_live_secret", nested: { password: "hunter2", keep: 1 } },
      after: {
        status: "paused", email: "buyer@example.com", customerId: "gid://shopify/Customer/1",
        note: "contact jane.doe@example.com now", _mcp: { operator: "op-1", client: "claude" },
        integrationCredentials: { apiKey: "k" }, session_id: "s1", cartToken: "c1", orderId: "o1",
      },
      createdAt: at("2026-10-30T10:00:00.000Z"),
    },
    {
      shopId: world.alpha, entityType: "offer", entityId: offerA, action: "system_pause", performedBy: "system",
      before: { status: "active" }, after: { status: "paused", reason: "compile_error" },
      createdAt: at("2026-10-29T10:00:00.000Z"),
    },
    {
      shopId: world.alpha, entityType: "offer", entityId: offerA, action: "update", performedBy: "staff.member@shop.com",
      before: { priority: 1 }, after: { priority: 5 }, createdAt: at("2026-10-28T10:00:00.000Z"),
    },
    {
      shopId: world.alpha, entityType: "shop_settings", entityId: "x", action: "update", performedBy: "mcp:op-2",
      before: null, after: { limits: true }, createdAt: at("2026-10-27T10:00:00.000Z"),
    },
    {
      shopId: world.beta, entityType: "offer", entityId: offerB, action: "archive", performedBy: "mcp:op-1",
      before: { status: "active" }, after: { status: "archived" }, createdAt: at("2026-10-26T10:00:00.000Z"),
    },
    {
      shopId: world.gone, entityType: "offer", entityId: "11111111-1111-1111-1111-111111111111", action: "update", performedBy: "mcp:op-1",
      after: { leaked: true }, createdAt: at("2026-10-26T11:00:00.000Z"),
    },
    {
      shopId: world.alpha, entityType: "offer", entityId: offerA, action: "update", performedBy: "mcp:op-1",
      after: { old: true }, createdAt: at("2026-08-01T10:00:00.000Z"),
    },
  ]);
}, 60_000);
afterAll(async () => {
  await close();
});

const run = async (args: Parameters<typeof promoAuditLog>[2] = {}) => promoAuditLog(db, await world.visible(), args, now);

describe("promo_audit_log", () => {
  it("lists newest first across visible shops, hides uninstalled shops and entries older than 30 days", async () => {
    const res = await run();
    expect(res.data.events.map((e) => e.action)).toEqual(["toggle_status", "system_pause", "update", "update", "archive"]);
    expect(res.data.events.every((e) => e.shopDomain !== "gone.myshopify.com")).toBe(true);
    expect(JSON.stringify(res)).not.toContain("leaked");
    expect(res.meta.window?.start).toBe("2026-10-02T12:00:00.000Z");
  });

  it("strips secrets and PII keys, masks emails in text and keeps readable fields", async () => {
    const e = (await run()).data.events[0]!;
    expect(e.before).toEqual({ status: "active", nested: { keep: 1 } });
    expect(e.after).toEqual({ status: "paused", note: "contact [email] now", _mcp: { operator: "op-1", client: "claude" } });
    const json = JSON.stringify(await run());
    for (const leak of ["shpat_live_secret", "hunter2", "buyer@example.com", "jane.doe", "gid://shopify/Customer/1", "integrationCredentials", "session_id", "cartToken"]) {
      expect(json).not.toContain(leak);
    }
    expect([...e.changes].sort((a, z) => a.field.localeCompare(z.field))).toEqual([
      { field: "_mcp", before: null, after: { operator: "op-1", client: "claude" } },
      { field: "status", before: "active", after: "paused" },
      { field: "nested", before: { keep: 1 }, after: null },
      { field: "note", before: null, after: "contact [email] now" },
    ].sort((a, z) => a.field.localeCompare(z.field)));
  });

  it("masks discount codes in strings, arrays, nested values and free-text diffs", () => {
    const out = sanitizeAuditJson({
      code: "SUMMER2026",
      codes: ["ABCDEF12", "XY"],
      requestedCode: "REQUESTED9",
      existingDiscount: "Shopify discount",
      nested: { discount_code: "NESTED123" },
      diff: ['condition[0].value: db={"code":"FREEBIE50"} preset={"codes":["AAAAAA","BBBBBB"]}'],
    });
    const json = JSON.stringify(out);
    for (const real of ["SUMMER2026", "ABCDEF12", "REQUESTED9", "NESTED123", "FREEBIE50", "AAAAAA", "BBBBBB"]) expect(json).not.toContain(real);
    expect(out).toMatchObject({ code: maskCode("SUMMER2026"), codes: [maskCode("ABCDEF12"), maskCode("XY")], existingDiscount: "Shopify discount" });
  });

  it("never returns the codes of a code_collision_resolved row, in before, after, changes or summary", async () => {
    const entityId = await seedOffer(db, world.alpha, { internalName: "Collision" });
    await db.insert(auditLogs).values({
      shopId: world.alpha, entityType: "offer", entityId, action: "code_collision_resolved", performedBy: "system",
      before: { code: "WELCOME10" }, after: { code: "WELCOME10-K7", existingDiscount: "Old campaign" },
      createdAt: at("2025-12-01T10:00:00.000Z"),
    });
    const res = await run({ ref: `promo:alpha:${entityId}`, since: "2025-11-15T00:00:00Z" });
    expect(res.data.events).toHaveLength(1);
    const json = JSON.stringify(res);
    expect(json).not.toContain("WELCOME10");
    expect(res.data.events[0]!.before).toEqual({ code: maskCode("WELCOME10") });
    expect(res.data.events[0]!.changes.find((c) => c.field === "code")).toEqual({ field: "code", before: maskCode("WELCOME10"), after: maskCode("WELCOME10-K7") });
  });

  it("classifies and masks actors", async () => {
    const events = (await run()).data.events;
    expect(events.map((e) => [e.actorKind, e.actor])).toEqual([
      ["mcp", "mcp:op-1"],
      ["system", "system"],
      ["merchant", "s***@shop.com"],
      ["mcp", "mcp:op-2"],
      ["mcp", "mcp:op-1"],
    ]);
    expect(JSON.stringify(events)).not.toContain("staff.member");
  });

  it("filters by ref, shops, actor and since", async () => {
    const byRef = await run({ ref: `promo:alpha:${offerA}` });
    expect(byRef.data.events.map((e) => e.action)).toEqual(["toggle_status", "system_pause", "update"]);
    expect(byRef.data.events[0]!.promoRef).toBe(`promo:alpha:${offerA}`);

    expect((await run({ shops: ["beta"] })).data.events.map((e) => e.action)).toEqual(["archive"]);
    expect((await run({ actor: "op-1" })).data.events.map((e) => e.action)).toEqual(["toggle_status", "archive"]);
    expect((await run({ actor: "mcp:op-2" })).data.events).toHaveLength(1);
    expect((await run({ actor: "system" })).data.events.map((e) => e.action)).toEqual(["system_pause"]);
    expect((await run({ since: "2026-10-29T00:00:00Z" })).data.events).toHaveLength(2);
    expect((await run({ since: "2026-07-30T00:00:00Z" })).data.events).toHaveLength(6);
  });

  it("clamps since to 365 days and rejects bad input", async () => {
    const res = await run({ since: "2020-01-01T00:00:00Z" });
    expect(res.warnings.map((w) => w.code)).toEqual(["SINCE_CLAMPED"]);
    await expect(run({ since: "nope" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
    await expect(run({ ref: "bad" })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
    await expect(run({ shops: ["gone"] })).rejects.toMatchObject({ payload: { code: "SHOP_NOT_FOUND" } });
  });

  it("pages with a keyset cursor without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await run({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.data.events.map((e) => e.id));
      if (!page.meta.page?.hasMore) break;
      cursor = page.meta.page.cursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const tokyo: string[] = [];
    await db.execute(sql`SET TIME ZONE 'Asia/Tokyo'`);
    try {
      let c2: string | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await run({ limit: 2, ...(c2 ? { cursor: c2 } : {}) });
        tokyo.push(...page.data.events.map((e) => e.id));
        if (!page.meta.page?.hasMore) break;
        c2 = page.meta.page.cursor;
      }
    } finally {
      await db.execute(sql`RESET TIME ZONE`);
    }
    expect(tokyo).toEqual(seen);
    await expect(run({ cursor: encodeURIComponent("zzz") })).rejects.toMatchObject({ payload: { code: "VALIDATION" } });
  });

  it("an allow-listed operator never sees another shop's trail", async () => {
    const visible = await world.visible({ ...operatorAll, shopAllowList: ["alpha.myshopify.com"] });
    const res = await promoAuditLog(db, visible, {}, now);
    expect(res.data.events.every((e) => e.shopDomain === "alpha.myshopify.com")).toBe(true);
    await expect(promoAuditLog(db, visible, { ref: `promo:beta:${offerB}` }, now)).rejects.toMatchObject({ payload: { code: "SHOP_NOT_FOUND" } });
  });
});

describe("audit helpers", () => {
  it("sanitizeAuditJson bounds depth, arrays and strings", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(JSON.stringify(sanitizeAuditJson(deep))).toContain("[truncated]");
    expect((sanitizeAuditJson(Array.from({ length: 200 }, (_, i) => i)) as number[]).length).toBe(50);
    expect((sanitizeAuditJson("x".repeat(2000)) as string).length).toBe(500);
    expect(sanitizeAuditJson(undefined)).toBeNull();
  });
  it("changesOf compares top-level fields", () => {
    expect(changesOf({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual([
      { field: "b", before: 2, after: 3 },
      { field: "c", before: null, after: 4 },
    ]);
    expect(changesOf(null, null)).toEqual([]);
  });
  it("maskActor keeps ids and masks emails", () => {
    expect(maskActor(null)).toBeNull();
    expect(maskActor("a.b@c.io")).toBe("a***@c.io");
    expect(maskActor("mcp:op")).toBe("mcp:op");
  });
});

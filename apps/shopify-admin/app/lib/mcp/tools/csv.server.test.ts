import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditLogs, mcpOperators, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import { MAX_CSV_BYTES, MAX_CSV_COLUMNS, MAX_CSV_ROWS, parseCSV } from "../../csv.js";
import { exportOffersCsv } from "../../offer-csv-export.server.js";
import { importOffersCsv } from "../../offer-csv-import.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerCsvTools } from "./register-csv.server.js";

const SOURCE = "csv-source.myshopify.com";
const TARGET = "csv-target.myshopify.com";

type Body = { code?: string; message?: string; summary: string; data: Record<string, any>; warnings: { code: string }[]; meta: { dryRun?: boolean } };

let db: Db;
let close: () => Promise<void>;
let client: Client;
let operator: Operator;
let publish = vi.fn<ShopPublishFn>(async () => null);
const ids: Record<string, string> = {};
const names: Record<string, string> = {};

const call = async (tool: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  return { result, body: result.structuredContent as unknown as Body };
};

async function snapshot(shopId: string) {
  const rows = await db.select().from(offers).where(eq(offers.shopId, shopId));
  const out: Record<string, unknown> = {};
  for (const offer of rows) {
    const conditions = await db.select().from(offerConditions).where(eq(offerConditions.offerId, offer.id));
    const rewards = await db.select().from(offerRewards).where(eq(offerRewards.offerId, offer.id));
    out[offer.internalName] = {
      type: offer.type,
      publicTitle: offer.publicTitle,
      priority: offer.priority,
      requiresCode: offer.requiresCode,
      codeRedemption: offer.codeRedemption,
      discountTags: offer.discountTags,
      conditions: conditions.map((c) => [c.scope, c.conditionType, c.value]),
      rewards: rewards.map((r) => [r.rewardType, r.discountType, r.discountType === "percentage" ? r.value : null, r.target, r.quantity, r.isAutoAdd, r.trackMode]),
    };
  }
  return out;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ids["source"] = await seedShop(db, SOURCE);
  ids["target"] = await seedShop(db, TARGET);
  const [op] = await db.insert(mcpOperators).values({ email: "csv@example.com", name: "csv", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };

  const gift = await seedOffer(db, ids["source"], { internalName: "csv-gift", publicTitle: "Free gift over 50", type: "gift", status: "active", priority: 120, discountTags: ["a", "b"] });
  await db.insert(offerConditions).values({ shopId: ids["source"], offerId: gift, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({ shopId: ids["source"], offerId: gift, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" }, target: { variantIds: ["gid://shopify/ProductVariant/11", "gid://shopify/ProductVariant/12"] }, quantity: 2, isAutoAdd: true, trackMode: "variant" });
  const pct = await seedOffer(db, ids["source"], { internalName: "csv-pct", publicTitle: "Ten percent", type: "discount", status: "paused", priority: 300 });
  await db.insert(offerConditions).values({ shopId: ids["source"], offerId: pct, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 3000, currencyCode: "USD", includeGiftValues: false }, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({ shopId: ids["source"], offerId: pct, rewardType: "order_discount", discountType: "percentage", value: { amount: 10, currencyCode: "USD" }, target: { scope: "cart" }, quantity: 1 });
  await seedOffer(db, ids["source"], { internalName: "csv-bare, with \"quotes\"", publicTitle: "Bare", type: "upsell", status: "draft", requiresCode: true, codeRedemption: "automatic" });
  names["gift"] = gift;
  names["pct"] = pct;

  const server = new McpServer({ name: "csv-test", version: "0" });
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: async () => ({ ok: true as const }), publish };
  registerCsvTools(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "vitest", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => resetMemoryRateLimits());

describe("offers_export_csv", () => {
  it("returns the admin export columns for every offer of the shop", async () => {
    const { result, body } = await call("offers_export_csv", { shop: SOURCE });
    expect(result.isError).toBeFalsy();
    expect(body.data["offerCount"]).toBe(3);
    expect(body.data["truncated"]).toBe(false);
    const rows = parseCSV(body.data["csv"] as string);
    expect(rows[0]).toEqual(body.data["columns"]);
    expect(rows[0]!.slice(0, 5)).toEqual(["offer_id", "internal_name", "public_title", "type", "status"]);
    expect(rows).toHaveLength(1 + (body.data["rowCount"] as number));
    expect(rows.map((r) => r[1])).toContain("csv-gift");
  });

  it("matches the shared builder byte for byte (the routes use the same function)", async () => {
    const direct = await exportOffersCsv(db, { shopId: ids["source"]!, shopCurrency: "USD" });
    const { body } = await call("offers_export_csv", { shop: SOURCE });
    expect(body.data["csv"]).toBe(direct.csv);
  });

  it("exports only the given refs and warns about missing ones", async () => {
    const { body } = await call("offers_export_csv", { shop: SOURCE, refs: [`promo:csv-source:${names["gift"]}`, "00000000-0000-4000-8000-000000000000"] });
    expect(body.data["offerCount"]).toBe(1);
    expect(parseCSV(body.data["csv"] as string)[1]![1]).toBe("csv-gift");
    expect(body.warnings.map((w) => w.code)).toContain("OFFERS_NOT_FOUND");
  });

  it("stops at an offer boundary when the size cap is hit", async () => {
    const full = await exportOffersCsv(db, { shopId: ids["source"]!, shopCurrency: "USD" });
    const capped = await exportOffersCsv(db, { shopId: ids["source"]!, shopCurrency: "USD" }, { maxBytes: Math.floor(full.csv.length / 2) });
    expect(capped.truncated).toBe(true);
    expect(capped.matchedOffers).toBe(3);
    expect(capped.offerCount).toBeLessThan(3);
    expect(parseCSV(capped.csv)).toHaveLength(1 + capped.rowCount);
  });
});

describe("export -> import round trip", () => {
  it("dryRun validates and writes nothing, then apply recreates equivalent offers as drafts", async () => {
    const { body: exported } = await call("offers_export_csv", { shop: SOURCE });
    const csv = exported.data["csv"] as string;

    const dry = await call("offers_import_csv", { shop: TARGET, csv, dryRun: true });
    expect(dry.result.isError).toBeFalsy();
    expect(dry.body.meta.dryRun).toBe(true);
    expect(dry.body.data).toMatchObject({ dryRun: true, valid: 3, failed: 0, created: 0 });
    expect(await db.select().from(offers).where(eq(offers.shopId, ids["target"]!))).toHaveLength(0);

    const applied = await call("offers_import_csv", { shop: TARGET, csv });
    expect(applied.result.isError).toBeFalsy();
    expect(applied.body.data).toMatchObject({ dryRun: false, created: 3, failed: 0 });
    expect(applied.body.data["offers"][0].promoRef).toMatch(/^promo:csv-target:/);

    const targetRows = await db.select().from(offers).where(eq(offers.shopId, ids["target"]!));
    expect(targetRows.map((o) => o.status)).toEqual(["draft", "draft", "draft"]);
    const source = await snapshot(ids["source"]!);
    const target = await snapshot(ids["target"]!);
    expect(target).toEqual(source);
    expect(publish).not.toHaveBeenCalled();

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, ids["target"]!), eq(auditLogs.action, "csv_import")));
    expect(audit).toHaveLength(3);
    expect(audit[0]!.performedBy).toBe(`mcp:${operator.id}`);
  });

  it("a dry run flags names already taken, and an identical idempotencyKey replays instead of re-importing", async () => {
    const { body: exported } = await call("offers_export_csv", { shop: SOURCE, refs: [names["pct"]!] });
    const csv = exported.data["csv"] as string;
    const dry = await call("offers_import_csv", { shop: TARGET, csv, dryRun: true });
    expect(dry.body.data["failed"]).toBe(1);
    expect(dry.body.data["errors"][0]).toEqual({ row: 2, message: expect.stringContaining("already exists") });

    const key = "idem-key-csv-0001";
    const fresh = csv.replace("csv-pct", "csv-pct-2");
    const first = await call("offers_import_csv", { shop: TARGET, csv: fresh, idempotencyKey: key });
    const second = await call("offers_import_csv", { shop: TARGET, csv: fresh, idempotencyKey: key });
    expect(first.body.data["created"]).toBe(1);
    expect(second.body.warnings.map((w) => w.code)).toContain("IDEMPOTENT_REPLAY");
    expect(await db.select().from(offers).where(and(eq(offers.shopId, ids["target"]!), eq(offers.internalName, "csv-pct-2")))).toHaveLength(1);
  });
});

describe("offers_import_csv validation", () => {
  const header = "internal_name,public_title,type,priority,condition_type,condition_value_threshold_cents,reward_type,discount_type,reward_value\n";

  it("reports a malformed row with the page's message and still imports the others", async () => {
    const csv = `${header}ok-one,Ok,discount,100,cart_value,5000,order_discount,percentage,10\nbad-type,Bad,wizard,100,,,,,\nbad-prio,Bad,gift,-5,,,,,\nbad-cond,Bad,gift,100,nope,5,,,\n`;
    const { result, body } = await call("offers_import_csv", { shop: TARGET, csv });
    expect(result.isError).toBeFalsy();
    expect(body.data["created"]).toBe(1);
    expect(body.data["errors"]).toEqual([
      { row: 3, message: 'Invalid type "wizard". Must be one of: gift, bundle, upsell, discount, booster' },
      { row: 4, message: "Priority must be a non-negative integer" },
      { row: 5, message: 'Invalid condition_type "nope"' },
    ]);
    expect(body.warnings.map((w) => w.code)).toContain("ROWS_FAILED");
    const dry = await call("offers_import_csv", { shop: TARGET, csv: csv.replace("ok-one", "ok-two"), dryRun: true });
    expect(dry.body.data["errors"]).toEqual(body.data["errors"]);
    expect(dry.body.data["valid"]).toBe(1);
  });

  it("refuses a row whose exported currency differs from the shop", async () => {
    const csv = "internal_name,type,shop_currency_code\nfx,gift,EUR\n";
    const { body } = await call("offers_import_csv", { shop: TARGET, csv, dryRun: true });
    expect(body.data["errors"][0].message).toMatch(/shop_currency_code EUR differs from this shop's currency USD/);
  });

  it("enforces the row, column, header and byte limits with the page's messages", async () => {
    const tooManyRows = `internal_name,type\n${Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `r${i},gift`).join("\n")}\n`;
    const rows = await call("offers_import_csv", { shop: TARGET, csv: tooManyRows, dryRun: true });
    expect(rows.body.code).toBe("VALIDATION");
    expect(rows.body.message).toContain(`CSV cannot contain more than ${MAX_CSV_ROWS.toLocaleString()} data rows`);

    const wide = Array.from({ length: MAX_CSV_COLUMNS + 1 }, (_, i) => `c${i}`);
    const cols = await call("offers_import_csv", { shop: TARGET, csv: `${wide.join(",")}\n${wide.map(() => "x").join(",")}\n`, dryRun: true });
    expect(cols.body.message).toContain(`CSV cannot contain more than ${MAX_CSV_COLUMNS} columns`);

    const dup = await call("offers_import_csv", { shop: TARGET, csv: "internal_name,internal_name\na,b\n", dryRun: true });
    expect(dup.body.message).toContain("CSV headers must be unique");
    const only = await call("offers_import_csv", { shop: TARGET, csv: "internal_name,type\n", dryRun: true });
    expect(only.body.message).toContain("header row and at least one data row");

    // Under the tool's character cap but over the byte cap (2 bytes per character).
    const heavy = `internal_name,type\n${"é".repeat(MAX_CSV_BYTES / 2 + 10)},gift\n`;
    expect(heavy.length).toBeLessThanOrEqual(MAX_CSV_BYTES);
    const bytes = await call("offers_import_csv", { shop: TARGET, csv: heavy, dryRun: true });
    expect(bytes.body.message).toContain(`CSV must be smaller than ${MAX_CSV_BYTES.toLocaleString()} bytes`);
    const service = await importOffersCsv({ db, shopId: ids["target"]!, shopCurrency: "USD", timezone: "UTC" }, heavy, { dryRun: true });
    expect(service.error).toContain("smaller than");
  });

  it("rejects an unknown shop and writes nothing for a file-level error", async () => {
    const before = (await db.select().from(offers).where(eq(offers.shopId, ids["target"]!))).length;
    const unknown = await call("offers_import_csv", { shop: "nope.myshopify.com", csv: "internal_name,type\na,gift\n" });
    expect(unknown.body.code).toBe("SHOP_NOT_FOUND");
    await call("offers_import_csv", { shop: TARGET, csv: "internal_name,internal_name\na,b\n" });
    expect((await db.select().from(offers).where(eq(offers.shopId, ids["target"]!))).length).toBe(before);
  });
});

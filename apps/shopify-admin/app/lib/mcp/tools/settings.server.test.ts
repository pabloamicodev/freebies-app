import type * as PromoDb from "@promo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { appSettings, auditLogs, mcpCallLog, mcpOperators, offers, shops, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { ShopPublishFn } from "../../offer-publish-flow.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";

let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => currentDb,
}));
vi.mock("../../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const { registerSettingsTools } = await import("./register-settings.server.js");
const { integrationsConnectTool } = await import("./settings.server.js");
const { SETTING_REGISTRY } = await import("../../shop-settings.server.js");
const { isFunctionShardsEnabled } = await import("../../function-shards-flag.server.js");

const SHOP = "settings-test.myshopify.com";
const PRESET_SHOP = "onesolsupps.myshopify.com";
const SECRET_URL = "https://hooks.example-secret-host.com/path/TOPSECRET-token-123";
const ENV = { LIMITS_TOGGLE_SHOPS: SHOP } as unknown as NodeJS.ProcessEnv;

type Body = {
  code?: string;
  message?: string;
  summary: string;
  data: Record<string, any>;
  meta: { dryRun?: boolean };
  warnings: { code: string }[];
  nextActions: { tool: string; args: Record<string, unknown> }[];
};
const body = (r: CallToolResult) => r.structuredContent as unknown as Body;

let db: Db;
let close: () => Promise<void>;
let operator: Operator;
let publish = vi.fn<ShopPublishFn>();
let env = ENV;
const unlimited = async () => ({ ok: true as const });
const ctxFor = (): McpContext => ({ db, env, operator, now: () => new Date(), rateLimit: unlimited, publish });

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "promo-engine", version: "0.0.0" });
  registerSettingsTools(server, ctxFor());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}
let client: Client;
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const get = async (keys: string[]) => {
  const r = await call("settings_get", { shop: SHOP, keys });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
  return Object.fromEntries((body(r).data["settings"] as { key: string; value: unknown }[]).map((s) => [s.key, s.value]));
};

/** Two distinct valid values per key, to prove a change goes through the owning module and reads back. */
const SAMPLES: Record<string, [unknown, unknown]> = {
  "app.enabled": [false, true],
  "gift.logic_mode": ["function", "function"],
  "gift.auto_add": [false, true],
  "gift.discount_by": ["compare_price", "current_price"],
  "gift.price_constraint": [true, false],
  "gift.selection_limit": [true, false],
  "gift.exclude_cart": [true, false],
  "gift.remove_on_deactivate": [false, true],
  "gift.include_compare_price": [true, false],
  "gift.sku_format": ["suffix_gift", "blank"],
  "gift.barcode_format": ["same_as_original", "blank"],
  "gift.title_format": ["name_pct", "same_as_original"],
  "gift.include_product_type": [true, false],
  "gift.include_tags": [true, false],
  "inventory.method": ["manual", "unlimited"],
  "inventory.when_out": ["continue", "stop"],
  "advanced.draft_order_api": [true, false],
  "app.timezone": ["America/New_York", "Europe/Madrid"],
  "app.language": ["es", "fr"],
  "gift.oos_behavior": ["show_disabled", "show_available"],
  "gift.auto_swap_enabled": [true, false],
  "gift.hide_oos_gifts": [false, true],
  "gift.continue_selling_enabled": [true, false],
  "pos.enabled": [true, false],
  "limits.enforced": [true, false],
  "function_shards.enabled": [true, false],
  "function_shards.combination_domains": [true, false],
  "function_shards.instruction_budget": [true, false],
  "function_compact_ids.enabled": [true, false],
  "storefront.remove_unfunded_gifts": [true, false],
  "drift_repair.paused": [true, false],
  "shadow_mode.enabled": [true, false],
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  currentDb = db;
  await seedShop(db, SHOP);
  await seedShop(db, PRESET_SHOP);
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  publish = vi.fn<ShopPublishFn>(async () => null);
  env = ENV;
  resetMemoryRateLimits();
  client = await connect();
});

describe("settings registry", () => {
  it("has a round-trip sample for every writable key", () => {
    const writable = SETTING_REGISTRY.filter((d) => !d.readOnly).map((d) => d.key).sort();
    expect(Object.keys(SAMPLES).sort()).toEqual(writable);
    for (const def of SETTING_REGISTRY) {
      expect(def.schema.safeParse(def.default).success || def.readOnly || def.key === "app.timezone", def.key).toBe(true);
    }
  });

  it("every writable key round-trips through its module", async () => {
    for (const [key, [a, b]] of Object.entries(SAMPLES)) {
      const first = await call("settings_set", { shop: SHOP, values: { [key]: a } });
      expect(first.isError, `${key}: ${JSON.stringify(first.structuredContent)}`).toBeFalsy();
      expect((await get([key]))[key], `${key} after set`).toEqual(a);
      const second = await call("settings_set", { shop: SHOP, values: { [key]: b } });
      expect(second.isError, `${key}: ${JSON.stringify(second.structuredContent)}`).toBeFalsy();
      expect((await get([key]))[key], `${key} after reset`).toEqual(b);
    }
  });

  it("stores the flags in the formats the modules read (sharding, pos, inventory)", async () => {
    await call("settings_set", { shop: SHOP, values: { "function_shards.enabled": false, "pos.enabled": true, "gift.hide_oos_gifts": false } });
    const [shop] = await db.select().from(shops).where(eq(shops.myshopifyDomain, SHOP));
    const raw = async (key: string) => (await db.select().from(appSettings).where(and(eq(appSettings.shopId, shop!.id), eq(appSettings.key, key))))[0]?.value;
    expect(await raw("function_shards.enabled")).toBe("false");
    expect(await raw("pos.enabled")).toBe("true");
    expect(await raw("gift.hide_oos_gifts")).toBe("false");
    expect(await isFunctionShardsEnabled(db, shop!.id)).toBe(false);
  });

  it("settings_get reports value, default, description, republish rule and last change", async () => {
    await call("settings_set", { shop: SHOP, values: { "drift_repair.paused": true } });
    const r = await call("settings_get", { shop: SHOP, keys: ["drift_repair.paused", "function_shards.instruction_budget", "app.embed_verified"] });
    const rows = body(r).data["settings"] as Record<string, any>[];
    expect(rows[0]).toMatchObject({ key: "drift_repair.paused", value: true, default: false, republishAfterChange: false });
    expect(rows[0].description).toContain("drift repair");
    expect(rows[0].lastChangedAt).toEqual(expect.any(String));
    expect(rows[1]).toMatchObject({ key: "function_shards.instruction_budget", republishAfterChange: true });
    expect(rows[2]).toMatchObject({ key: "app.embed_verified", readOnly: true, value: null });
  });
});

describe("republishing", () => {
  it.each(["function_shards.enabled", "function_shards.instruction_budget", "function_compact_ids.enabled", "limits.enforced", "shadow_mode.enabled"])(
    "%s republishes the shop when it changes",
    async (key) => {
      await call("settings_set", { shop: SHOP, values: { [key]: false } });
      publish.mockClear();
      const r = await call("settings_set", { shop: SHOP, values: { [key]: true } });
      expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(body(r).data["republished"]).toBe(true);
    },
  );

  it("function_shards.combination_domains republishes when sharding is on and not when it is off", async () => {
    await call("settings_set", { shop: SHOP, values: { "function_shards.enabled": true, "function_shards.combination_domains": false } });
    publish.mockClear();
    await call("settings_set", { shop: SHOP, values: { "function_shards.combination_domains": true } });
    expect(publish).toHaveBeenCalledTimes(1);
    await call("settings_set", { shop: SHOP, values: { "function_shards.enabled": false, "function_shards.combination_domains": false } });
    publish.mockClear();
    await call("settings_set", { shop: SHOP, values: { "function_shards.combination_domains": true } });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["pos.enabled", "storefront.remove_unfunded_gifts", "drift_repair.paused", "gift.auto_add"])("%s never republishes", async (key) => {
    publish.mockClear();
    await call("settings_set", { shop: SHOP, values: { [key]: SAMPLES[key]![0] } });
    await call("settings_set", { shop: SHOP, values: { [key]: SAMPLES[key]![1] } });
    expect(publish).not.toHaveBeenCalled();
  });

  it("an unchanged value does not republish", async () => {
    await call("settings_set", { shop: SHOP, values: { "function_compact_ids.enabled": true } });
    publish.mockClear();
    const r = await call("settings_set", { shop: SHOP, values: { "function_compact_ids.enabled": true } });
    expect(publish).not.toHaveBeenCalled();
    expect(body(r).summary).toMatch(/Nothing changed/);
  });

  it("one publish covers several changed flags, and a failed publish reverts all of them", async () => {
    await call("settings_set", { shop: SHOP, values: { "function_shards.enabled": true, "function_compact_ids.enabled": false } });
    publish.mockClear();
    publish.mockResolvedValueOnce({ message: "Shopify said no", scope: "shop" });
    const r = await call("settings_set", { shop: SHOP, values: { "function_shards.enabled": false, "function_compact_ids.enabled": true, "pos.enabled": true } });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("PUBLISH_FAILED");
    expect(body(r).message).toContain("Shopify said no");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await get(["function_shards.enabled", "function_compact_ids.enabled"])).toEqual({ "function_shards.enabled": true, "function_compact_ids.enabled": false });
  });

  it("dryRun shows before/after and the republish, and writes nothing", async () => {
    await call("settings_set", { shop: SHOP, values: { "function_shards.enabled": true, "pos.enabled": false } });
    publish.mockClear();
    const r = await call("settings_set", { shop: SHOP, dryRun: true, values: { "function_shards.enabled": false, "pos.enabled": false } });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    expect(body(r).meta.dryRun).toBe(true);
    expect(body(r).data["republish"]).toBe(true);
    expect(body(r).data["changes"]).toEqual([
      { key: "function_shards.enabled", before: true, after: false, changed: true, republish: true },
      { key: "pos.enabled", before: false, after: false, changed: false, republish: false },
    ]);
    expect(publish).not.toHaveBeenCalled();
    expect((await get(["function_shards.enabled"]))["function_shards.enabled"]).toBe(true);
  });

  it("audits executed changes with the operator", async () => {
    await call("settings_set", { shop: SHOP, values: { "pos.enabled": true } });
    await call("settings_set", { shop: SHOP, values: { "pos.enabled": false } });
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "settings_changed"));
    const last = rows[rows.length - 1]!;
    expect(last.before).toEqual({ "pos.enabled": true });
    expect(last.performedBy).toBe(`mcp:${operator.id}`);
  });
});

describe("validation", () => {
  it("rejects a wrong value with the key, the rule and its description", async () => {
    const r = await call("settings_set", { shop: SHOP, values: { "gift.discount_by": "bogus" } });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("VALIDATION");
    expect(body(r).message).toContain("gift.discount_by");
    expect(body(r).message).toContain("current_price or compare_price");
    const wrongType = await call("settings_set", { shop: SHOP, values: { "pos.enabled": "yes" } });
    expect(body(wrongType).code).toBe("VALIDATION");
  });

  it("rejects unknown and read-only keys, and an empty record, writing nothing", async () => {
    const unknown = await call("settings_set", { shop: SHOP, values: { "nope.key": true, "pos.enabled": true } });
    expect(body(unknown).message).toContain('Unknown setting "nope.key"');
    expect((await get(["pos.enabled"]))["pos.enabled"]).toBe(false);
    expect(body(await call("settings_set", { shop: SHOP, values: { "fraud.cart_payment_rule": false } })).message).toContain("read-only");
    expect(body(await call("settings_set", { shop: SHOP, values: { "app.embed_verified": true } })).message).toContain("read-only");
    expect(body(await call("settings_set", { shop: SHOP, values: {} })).message).toContain("values is empty");
  });

  it("limits.enforced keeps the admin gates and messages", async () => {
    await call("settings_set", { shop: SHOP, values: { "limits.enforced": false } });
    publish.mockClear();
    env = { LIMITS_TOGGLE_SHOPS: "someone-else.myshopify.com" } as unknown as NodeJS.ProcessEnv;
    client = await connect();
    const blocked = await call("settings_set", { shop: SHOP, values: { "limits.enforced": true } });
    expect(blocked.isError, JSON.stringify(blocked.structuredContent)).toBe(true);
    expect(body(blocked).code).toBe("VALIDATION");
    expect(body(blocked).message).toContain("This setting is not available for this shop.");
    expect(body(blocked).message).toContain("LIMITS_TOGGLE_SHOPS");
    expect(publish).not.toHaveBeenCalled();
  });

  it("limits.enforced is reverted when the publish fails", async () => {
    await call("settings_set", { shop: SHOP, values: { "limits.enforced": false } });
    publish.mockResolvedValueOnce({ message: "boom", scope: "shop" });
    const r = await call("settings_set", { shop: SHOP, values: { "limits.enforced": true } });
    expect(body(r).code).toBe("PUBLISH_FAILED");
    expect(body(r).message).toContain("the setting was reverted");
    expect((await get(["limits.enforced"]))["limits.enforced"]).toBe(false);
  });

  it("combination_domains refuses while the global switch is off", async () => {
    await call("settings_set", { shop: SHOP, values: { "function_shards.combination_domains": false } });
    env = { ...ENV, FUNCTION_SHARD_DOMAINS: "off" } as unknown as NodeJS.ProcessEnv;
    client = await connect();
    const r = await call("settings_set", { shop: SHOP, values: { "function_shards.combination_domains": true } });
    expect(body(r).code).toBe("VALIDATION");
    expect(body(r).message).toContain("Combination groups are switched off for every store");
  });

  it("an operator cannot reach a shop outside its allow list", async () => {
    const r = await call("settings_get", { shop: "ghost.myshopify.com" });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("SHOP_NOT_FOUND");
  });
});

describe("migration", () => {
  it("shadow mode set republishes and reads back through settings_get", async () => {
    const r = await call("migration_shadow_mode_set", { shop: SHOP, enabled: true });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await get(["shadow_mode.enabled"]))["shadow_mode.enabled"]).toBe(true);
    const off = await call("migration_shadow_mode_set", { shop: SHOP, enabled: false });
    expect(off.isError).toBeFalsy();
    expect((await get(["shadow_mode.enabled"]))["shadow_mode.enabled"]).toBe(false);
  });

  it("shadow mode set keeps the saved flag but reports a failed publish", async () => {
    publish.mockResolvedValueOnce({ message: "nope", scope: "shop" });
    const r = await call("migration_shadow_mode_set", { shop: SHOP, enabled: true });
    expect(body(r).code).toBe("PUBLISH_FAILED");
    expect(body(r).message).toContain("Shadow mode saved, but republishing to Shopify failed");
    await call("migration_shadow_mode_set", { shop: SHOP, enabled: false });
  });

  it("dryRun of shadow mode previews without writing", async () => {
    publish.mockClear();
    const r = await call("migration_shadow_mode_set", { shop: SHOP, enabled: true, dryRun: true });
    expect(body(r).data).toMatchObject({ enabledBefore: false, enabledAfter: true, changed: true });
    expect(publish).not.toHaveBeenCalled();
    expect((await get(["shadow_mode.enabled"]))["shadow_mode.enabled"]).toBe(false);
  });

  it("legacy preset import: refused without a preset, dry run lists, apply creates drafts once", async () => {
    const none = await call("migration_import_legacy_preset", { shop: SHOP });
    expect(body(none).code).toBe("VALIDATION");
    expect(body(none).message).toContain("No legacy store preset is registered for this shop.");

    const dry = await call("migration_import_legacy_preset", { shop: PRESET_SHOP, dryRun: true });
    expect(dry.isError, JSON.stringify(dry.structuredContent)).toBeFalsy();
    const listed = body(dry).data["offers"] as { alreadyImported: boolean }[];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((o) => !o.alreadyImported)).toBe(true);
    expect(await db.select().from(offers).where(eq(offers.internalName, (body(dry).data["offers"] as any[])[0].internalName))).toHaveLength(0);

    const done = await call("migration_import_legacy_preset", { shop: PRESET_SHOP });
    expect(done.isError, JSON.stringify(done.structuredContent)).toBeFalsy();
    expect(body(done).data["created"]).toBe(listed.length);
    const again = await call("migration_import_legacy_preset", { shop: PRESET_SHOP });
    expect(body(again).data).toMatchObject({ created: 0, skipped: listed.length });
  });
});

describe("integrations", () => {
  const ctxCall = { requestId: "r1", client: "vitest" };
  const okDeps = { assertSafeUrl: async () => new URL(SECRET_URL), validateApiKey: async () => ({ ok: true as const }) };

  it("connect stores the credential; list and results never contain the secret", async () => {
    const connected = await integrationsConnectTool(ctxFor(), ctxCall, { shop: SHOP, integration: "omnisend", secret: SECRET_URL }, okDeps);
    expect(connected.isError, JSON.stringify(connected.structuredContent)).toBeFalsy();
    expect(JSON.stringify(connected)).not.toContain("TOPSECRET");

    const list = await call("integrations_list", { shops: [SHOP] });
    const json = JSON.stringify(list);
    expect(json).not.toContain("TOPSECRET");
    expect(json).not.toContain("example-secret-host");
    const rows = body(list).data["shops"][0].integrations as { id: string; connected: boolean; secretKind: string }[];
    expect(rows.find((r) => r.id === "omnisend")).toMatchObject({ connected: true, secretKind: "webhook_url" });
    expect(rows.find((r) => r.id === "klaviyo")).toMatchObject({ connected: false, secretKind: "api_key" });

    const logs = JSON.stringify(await db.select().from(mcpCallLog));
    expect(logs).not.toContain("TOPSECRET");
    expect(logs).not.toContain("example-secret-host");
  });

  it("dryRun neither stores nor echoes the secret", async () => {
    const r = await integrationsConnectTool(ctxFor(), ctxCall, { shop: SHOP, integration: "rebuy", secret: SECRET_URL, dryRun: true }, okDeps);
    expect(body(r).data).toMatchObject({ integration: "rebuy", alreadyConnected: false });
    expect(JSON.stringify(r)).not.toContain("TOPSECRET");
    const rows = body(await call("integrations_list", { shops: [SHOP] })).data["shops"][0].integrations as { id: string; connected: boolean }[];
    expect(rows.find((x) => x.id === "rebuy")!.connected).toBe(false);
  });

  it("rejects unsafe webhook URLs with the page's message and stores nothing", async () => {
    for (const secret of ["http://hooks.example.com/x", "https://user:pw@hooks.example.com/x", "https://127.0.0.1/x"]) {
      const r = await call("integrations_connect", { shop: SHOP, integration: "gorgias", secret });
      expect(r.isError, secret).toBe(true);
      expect(body(r).code).toBe("VALIDATION");
      expect(body(r).message).toMatch(/^Webhook URL /);
      expect(JSON.stringify(r)).not.toContain("pw@");
    }
    const rows = body(await call("integrations_list", { shops: [SHOP] })).data["shops"][0].integrations as { id: string; connected: boolean }[];
    expect(rows.find((x) => x.id === "gorgias")!.connected).toBe(false);
  });

  it("klaviyo validates the key live and surfaces its error", async () => {
    const bad = await integrationsConnectTool(ctxFor(), ctxCall, { shop: SHOP, integration: "klaviyo", secret: "pk_bad" }, { validateApiKey: async () => ({ ok: false as const, error: "Klaviyo rejected the key" }) });
    expect(body(bad).code).toBe("VALIDATION");
    expect(body(bad).message).toBe("Klaviyo rejected the key");
    const good = await integrationsConnectTool(ctxFor(), ctxCall, { shop: SHOP, integration: "klaviyo", secret: "pk_good_TOPSECRET" }, okDeps);
    expect(good.isError).toBeFalsy();
    expect(JSON.stringify(good)).not.toContain("TOPSECRET");
  });

  it("disconnect removes the credential; unknown integrations are rejected", async () => {
    await integrationsConnectTool(ctxFor(), ctxCall, { shop: SHOP, integration: "postscript", secret: SECRET_URL }, okDeps);
    const done = await call("integrations_disconnect", { shop: SHOP, integration: "postscript" });
    expect(done.isError, JSON.stringify(done.structuredContent)).toBeFalsy();
    const rows = body(await call("integrations_list", { shops: [SHOP] })).data["shops"][0].integrations as { id: string; connected: boolean }[];
    expect(rows.find((x) => x.id === "postscript")!.connected).toBe(false);
    const bad = await call("integrations_connect", { shop: SHOP, integration: "mailchimp", secret: "x" });
    expect(bad.isError).toBe(true);
  });
});

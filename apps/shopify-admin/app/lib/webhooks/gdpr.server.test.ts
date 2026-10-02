import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  analyticsEvents,
  auditLogs,
  cartMutationLogs,
  discountCodeRedemptions,
  discountCodes,
  gdprExports,
  offers,
  shops,
  webhookDeliveries,
  type Db,
} from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../test-support/pglite-db.js";

vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const { GDPR_EXPORT_RETENTION_DAYS, handleCustomersDataRequest, handleCustomersRedact, handleShopRedact } = await import(
  "./gdpr.server.js"
);
const Sentry = await import("@sentry/node");

const CUSTOMER_NUMERIC_ID = "123456789";
const CUSTOMER_GID = `gid://shopify/Customer/${CUSTOMER_NUMERIC_ID}`;

let db: Db;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function newShop() {
  counter += 1;
  const domain = `gdpr-${counter}.myshopify.com`;
  return { shopId: await seedShop(db, domain), domain };
}

async function seedCustomerData(shopId: string, offerId: string) {
  await db.insert(analyticsEvents).values([
    { shopId, eventName: "gift_added", customerId: CUSTOMER_GID, cartToken: "cart-1", sessionId: "sess-1", properties: { sku: "A" } },
    // The web pixel once stored the customer id as the session id.
    { shopId, eventName: "page_view", sessionId: CUSTOMER_NUMERIC_ID, cartToken: "cart-2" },
    { shopId, eventName: "someone_else", customerId: "gid://shopify/Customer/999", cartToken: "cart-other" },
  ]);
  await db.insert(cartMutationLogs).values([
    { shopId, cartToken: "cart-1", mutationType: "add_gift", source: "ajax_cart", status: "success" },
    { shopId, cartToken: "cart-other", mutationType: "add_gift", source: "ajax_cart", status: "success" },
  ]);
  const [code] = await db.insert(discountCodes).values({ shopId, offerId, code: `GDPRCODE${counter}` }).returning();
  await db.insert(discountCodeRedemptions).values([
    { shopId, offerId, codeId: code!.id, code: code!.code, orderId: "1001", customerId: CUSTOMER_GID },
    { shopId, offerId, codeId: code!.id, code: code!.code, orderId: "1002", customerId: "gid://shopify/Customer/999" },
  ]);
}

describe("handleCustomersDataRequest", () => {
  it("always reports to Sentry, even without a resolvable shop or customer", async () => {
    await handleCustomersDataRequest(db, null, "shop.myshopify.com", {});
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "GDPR customer data request received",
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("returns early without storing anything when shop or customer is missing", async () => {
    const { shopId, domain } = await newShop();
    await handleCustomersDataRequest(db, null, domain, { customer: { id: 1 } });
    await handleCustomersDataRequest(db, shopId, domain, {});
    expect(await db.select().from(gdprExports).where(eq(gdprExports.shopId, shopId))).toEqual([]);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.shopId, shopId))).toEqual([]);
  });

  it("stores a real JSON export of everything held about the customer, and nothing about others", async () => {
    const { shopId, domain } = await newShop();
    const offerId = await seedOffer(db, shopId);
    await seedCustomerData(shopId, offerId);

    await handleCustomersDataRequest(db, shopId, domain, {
      customer: { id: Number(CUSTOMER_NUMERIC_ID), email: "buyer@example.com" },
      orders_requested: [{ id: 1, name: "#1001" }],
    });

    const [stored] = await db.select().from(gdprExports).where(eq(gdprExports.shopId, shopId));
    expect(stored).toMatchObject({ customerId: CUSTOMER_GID });
    const payload = stored!.payload as {
      exportVersion: number;
      shop: string;
      customer: { id: string; email: string };
      ordersRequested: unknown[];
      data: {
        analyticsEvents: Array<{ eventName: string }>;
        cartMutationLogs: Array<{ cartToken: string }>;
        discountCodeRedemptions: Array<{ orderId: string }>;
      };
    };
    expect(payload).toMatchObject({
      exportVersion: 1,
      shop: domain,
      customer: { id: CUSTOMER_GID, email: "buyer@example.com" },
      ordersRequested: [{ id: 1, name: "#1001" }],
    });
    expect(payload.data.analyticsEvents.map((e) => e.eventName).sort()).toEqual(["gift_added", "page_view"]);
    // Only the logs of this customer's carts.
    expect(payload.data.cartMutationLogs.map((l) => l.cartToken).sort()).toEqual(["cart-1"]);
    expect(payload.data.discountCodeRedemptions.map((r) => r.orderId)).toEqual(["1001"]);
    expect(JSON.stringify(payload)).not.toContain("cart-other");
    expect(JSON.stringify(payload)).not.toContain("someone_else");
  });

  it("stores one export and one audit entry per webhook id, however often it is delivered", async () => {
    const { shopId, domain } = await newShop();
    const request = { customer: { id: 77 } };
    await handleCustomersDataRequest(db, shopId, domain, request, "wh-dup-1");
    await handleCustomersDataRequest(db, shopId, domain, request, "wh-dup-1");
    expect(await db.select().from(gdprExports).where(eq(gdprExports.shopId, shopId))).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.shopId, shopId))).toHaveLength(1);

    // A different request for the same customer is a new export.
    await handleCustomersDataRequest(db, shopId, domain, request, "wh-dup-2");
    expect(await db.select().from(gdprExports).where(eq(gdprExports.shopId, shopId))).toHaveLength(2);
  });

  it("deletes exports past expires_at in the operational cleanup, and keeps live ones", async () => {
    const { cleanupOperationalState } = await import("../operational-retention.server.js");
    const { shopId, domain } = await newShop();
    await handleCustomersDataRequest(db, shopId, domain, { customer: { id: 78 } }, "wh-exp-live");
    await db.insert(gdprExports).values({
      shopId,
      customerId: "gid://shopify/Customer/79",
      payload: {},
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await cleanupOperationalState(db);

    expect(result.expiredGdprExports).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(gdprExports).where(eq(gdprExports.shopId, shopId));
    expect(left.map((row) => row.customerId)).toEqual(["gid://shopify/Customer/78"]);
  });

  it("makes the export expire after the retention period", async () => {
    const { shopId, domain } = await newShop();
    const before = Date.now();
    await handleCustomersDataRequest(db, shopId, domain, { customer: { id: 5 } });
    const [stored] = await db.select().from(gdprExports).where(eq(gdprExports.shopId, shopId));
    const days = (stored!.expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(GDPR_EXPORT_RETENTION_DAYS - 0.01);
    expect(days).toBeLessThan(GDPR_EXPORT_RETENTION_DAYS + 0.01);
  });

  it("records an audit log with counts and the export id, but no customer data", async () => {
    const { shopId, domain } = await newShop();
    const offerId = await seedOffer(db, shopId);
    await seedCustomerData(shopId, offerId);

    await handleCustomersDataRequest(db, shopId, domain, {
      customer: { id: Number(CUSTOMER_NUMERIC_ID), email: "buyer@example.com" },
      orders_requested: [{ id: 1, name: "#1001" }],
    });

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.shopId, shopId));
    const [stored] = await db.select().from(gdprExports).where(eq(gdprExports.shopId, shopId));
    expect(audit).toMatchObject({
      entityType: "gdpr_customer_data_request",
      entityId: CUSTOMER_GID,
      action: "export",
      performedBy: "shopify_webhook",
    });
    expect(audit!.after).toMatchObject({
      exportId: stored!.id,
      orderCount: 1,
      analyticsEventCount: 2,
      cartMutationLogCount: 1,
      discountCodeRedemptionCount: 1,
    });
    expect(JSON.stringify(audit!.after)).not.toContain("buyer@example.com");
  });

  it("is scoped to the requesting shop", async () => {
    const one = await newShop();
    const two = await newShop();
    const offerTwo = await seedOffer(db, two.shopId);
    await seedCustomerData(two.shopId, offerTwo);

    await handleCustomersDataRequest(db, one.shopId, one.domain, { customer: { id: Number(CUSTOMER_NUMERIC_ID) } });

    const [stored] = await db.select().from(gdprExports).where(eq(gdprExports.shopId, one.shopId));
    expect((stored!.payload as { data: { analyticsEvents: unknown[] } }).data.analyticsEvents).toEqual([]);
  });
});

describe("handleCustomersRedact", () => {
  it("warns and returns when shop or customer can't be resolved", async () => {
    const { shopId } = await newShop();
    await expect(handleCustomersRedact(db, null, "shop.myshopify.com", {})).resolves.toBeUndefined();
    await expect(handleCustomersRedact(db, shopId, "shop.myshopify.com", {})).resolves.toBeUndefined();
  });

  it("erases the customer's analytics, audit trail, linked cart logs and stored export, and unlinks redemptions", async () => {
    const { shopId, domain } = await newShop();
    const offerId = await seedOffer(db, shopId);
    await seedCustomerData(shopId, offerId);
    await handleCustomersDataRequest(db, shopId, domain, { customer: { id: Number(CUSTOMER_NUMERIC_ID) } });

    await handleCustomersRedact(db, shopId, domain, { customer: { id: Number(CUSTOMER_NUMERIC_ID) } });

    const events = await db.select().from(analyticsEvents).where(eq(analyticsEvents.shopId, shopId));
    expect(events.map((e) => e.eventName)).toEqual(["someone_else"]);
    const logs = await db.select().from(cartMutationLogs).where(eq(cartMutationLogs.shopId, shopId));
    expect(logs.map((l) => l.cartToken)).toEqual(["cart-other"]);
    expect(await db.select().from(gdprExports).where(eq(gdprExports.shopId, shopId))).toEqual([]);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.entityType, "gdpr_customer_data_request")))).toEqual([]);
    const redemptions = await db.select().from(discountCodeRedemptions).where(eq(discountCodeRedemptions.shopId, shopId));
    // The code's usage accounting stays; only the customer link goes.
    expect(redemptions.map((r) => [r.orderId, r.customerId]).sort()).toEqual([
      ["1001", null],
      ["1002", "gid://shopify/Customer/999"],
    ]);
  });

  it("skips the cart-log delete when the customer has no linked sessions or cart tokens", async () => {
    const { shopId, domain } = await newShop();
    await db.insert(cartMutationLogs).values({ shopId, cartToken: "unrelated", mutationType: "add_gift", source: "ajax_cart", status: "success" });
    await handleCustomersRedact(db, shopId, domain, { customer: { id: Number(CUSTOMER_NUMERIC_ID) } });
    expect(await db.select().from(cartMutationLogs).where(eq(cartMutationLogs.shopId, shopId))).toHaveLength(1);
  });
});

describe("handleShopRedact", () => {
  const sessionStorage = () => ({
    findSessionsByShop: vi.fn().mockResolvedValue([{ id: "sess-1" }]),
    deleteSessions: vi.fn().mockResolvedValue(true),
  });
  const uninstalled = async (shopId: string, at = new Date("2026-01-01T00:00:00Z")) =>
    db.update(shops).set({ isActive: false, uninstalledAt: at, installedAt: new Date("2025-12-01T00:00:00Z") }).where(eq(shops.id, shopId));
  const exists = async (shopId: string) => (await db.select().from(shops).where(eq(shops.id, shopId))).length === 1;

  it("warns and returns without touching sessions when shopId is null", async () => {
    const sessions = sessionStorage();
    await handleShopRedact(db, sessions, null, "shop.myshopify.com");
    expect(sessions.findSessionsByShop).not.toHaveBeenCalled();
  });

  it("purges sessions, webhook deliveries and the shop row (cascading its data) for an uninstalled shop", async () => {
    const { shopId, domain } = await newShop();
    await uninstalled(shopId);
    const offerId = await seedOffer(db, shopId, { status: "archived" });
    await db.insert(webhookDeliveries).values({ webhookId: `wh-${counter}`, topic: "orders/paid", shopDomain: domain });
    const sessions = sessionStorage();

    await handleShopRedact(db, sessions, shopId, domain, "2026-01-03T00:00:00Z");

    expect(sessions.deleteSessions).toHaveBeenCalledWith(["sess-1"]);
    expect(await exists(shopId)).toBe(false);
    expect(await db.select().from(offers).where(eq(offers.id, offerId))).toEqual([]);
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.shopDomain, domain))).toEqual([]);
  });

  it("still deletes the shop even if session cleanup throws", async () => {
    const { shopId, domain } = await newShop();
    await uninstalled(shopId);
    const sessions = { findSessionsByShop: vi.fn().mockRejectedValue(new Error("boom")), deleteSessions: vi.fn() };
    await expect(handleShopRedact(db, sessions, shopId, domain)).resolves.toBeUndefined();
    expect(await exists(shopId)).toBe(false);
  });

  it("does NOT redact a shop that is active again (reinstalled during the 48 h window)", async () => {
    const { shopId, domain } = await newShop();
    const offerId = await seedOffer(db, shopId, { status: "active" });
    const sessions = sessionStorage();

    await handleShopRedact(db, sessions, shopId, domain);

    expect(await exists(shopId)).toBe(true);
    expect(await db.select().from(offers).where(eq(offers.id, offerId))).toHaveLength(1);
    expect(sessions.findSessionsByShop).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "GDPR shop redact skipped: shop is active or was reinstalled",
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("does not redact a shop with no uninstall on record", async () => {
    const { shopId, domain } = await newShop();
    await db.update(shops).set({ isActive: false, uninstalledAt: null }).where(eq(shops.id, shopId));
    await handleShopRedact(db, sessionStorage(), shopId, domain);
    expect(await exists(shopId)).toBe(true);
  });

  it("does not redact a shop reinstalled after the redact request was issued", async () => {
    const { shopId, domain } = await newShop();
    await db
      .update(shops)
      .set({ isActive: false, uninstalledAt: new Date("2026-01-01T00:00:00Z"), installedAt: new Date("2026-01-02T00:00:00Z") })
      .where(eq(shops.id, shopId));
    await handleShopRedact(db, sessionStorage(), shopId, domain, "2026-01-01T12:00:00Z");
    expect(await exists(shopId)).toBe(true);
  });
});

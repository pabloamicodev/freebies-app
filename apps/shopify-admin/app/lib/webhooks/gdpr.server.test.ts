import { describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";
import { analyticsEvents, auditLogs, cartMutationLogs, shops, webhookDeliveries } from "@promo/db";

vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const { handleCustomersDataRequest, handleCustomersRedact, handleShopRedact } = await import("./gdpr.server.js");
const Sentry = await import("@sentry/node");

const CUSTOMER_NUMERIC_ID = "123456789";
const CUSTOMER_GID = `gid://shopify/Customer/${CUSTOMER_NUMERIC_ID}`;

describe("handleCustomersDataRequest", () => {
  it("always reports to Sentry, even without a resolvable shop or customer", async () => {
    const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as unknown as Db;
    await handleCustomersDataRequest(db, null, "shop.myshopify.com", {});
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "GDPR customer data request received",
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("does not throw and records an audit log summary when shop and customer resolve", async () => {
    const events = [{ id: "evt-1", cartToken: "cart-1" }, { id: "evt-2", cartToken: null }];
    const mutationLogs = [{ id: "log-1" }];
    const auditInserts: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => Promise.resolve(table === analyticsEvents ? events : mutationLogs),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          auditInserts.push(values);
          return Promise.resolve(undefined);
        },
      }),
    } as unknown as Db;

    await expect(
      handleCustomersDataRequest(db, "shop-1", "shop.myshopify.com", {
        customer: { id: Number(CUSTOMER_NUMERIC_ID), email: "buyer@example.com" },
        orders_requested: [{ id: 1, name: "#1001" }],
      }),
    ).resolves.toBeUndefined();

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      shopId: "shop-1",
      entityType: "gdpr_customer_data_request",
      entityId: CUSTOMER_GID,
      action: "export",
    });
    expect(auditInserts[0]!["after"]).toMatchObject({
      orderCount: 1,
      analyticsEventCount: 2,
      cartMutationLogCount: 1,
    });
  });

  it("returns early without querying anything further when shopId is null", async () => {
    let selectCalled = false;
    const db = {
      select: () => {
        selectCalled = true;
        return { from: () => ({ where: () => Promise.resolve([]) }) };
      },
    } as unknown as Db;

    await handleCustomersDataRequest(db, null, "shop.myshopify.com", { customer: { id: 1 } });
    expect(selectCalled).toBe(false);
  });
});

describe("handleCustomersRedact", () => {
  it("warns and returns without touching the db when shop or customer can't be resolved", async () => {
    let dbTouched = false;
    const db = { select: () => { dbTouched = true; return {}; } } as unknown as Db;
    await handleCustomersRedact(db, null, "shop.myshopify.com", {});
    expect(dbTouched).toBe(false);
  });

  it("deletes the customer's analytics events, gdpr audit log, and linked cart mutation logs in one transaction", async () => {
    const customerEvents = [{ sessionId: "sess-1", cartToken: "cart-1" }];
    const deletedTables: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(customerEvents),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        // auditLogs/cartMutationLogs deletes don't call `.returning()` in the
        // source — give `.where()` a plain thenable too.
        const txFull = {
          delete: (table: unknown) => {
            const chain = {
              where: () => {
                deletedTables.push(table);
                return table === analyticsEvents
                  ? { returning: () => Promise.resolve([{ id: "evt-1" }]) }
                  : Promise.resolve(undefined);
              },
            };
            return chain;
          },
        };
        return fn(txFull);
      },
    } as unknown as Db;

    await handleCustomersRedact(db, "shop-1", "shop.myshopify.com", {
      customer: { id: Number(CUSTOMER_NUMERIC_ID) },
    });

    expect(deletedTables).toEqual([analyticsEvents, auditLogs, cartMutationLogs]);
  });

  it("skips the cartMutationLogs delete when the customer has no linked sessions or cart tokens", async () => {
    const deletedTables: unknown[] = [];
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          delete: (table: unknown) => ({
            where: () => {
              deletedTables.push(table);
              return table === analyticsEvents
                ? { returning: () => Promise.resolve([]) }
                : Promise.resolve(undefined);
            },
          }),
        };
        return fn(tx);
      },
    } as unknown as Db;

    await handleCustomersRedact(db, "shop-1", "shop.myshopify.com", {
      customer: { id: Number(CUSTOMER_NUMERIC_ID) },
    });

    expect(deletedTables).toEqual([analyticsEvents, auditLogs]);
  });
});

describe("handleShopRedact", () => {
  it("warns and returns without touching the db or sessions when shopId is null", async () => {
    let dbTouched = false;
    const db = { delete: () => { dbTouched = true; return { where: () => Promise.resolve(undefined) }; } } as unknown as Db;
    const sessionStorage = { findSessionsByShop: vi.fn(), deleteSessions: vi.fn() };

    await handleShopRedact(db, sessionStorage, null, "shop.myshopify.com");

    expect(dbTouched).toBe(false);
    expect(sessionStorage.findSessionsByShop).not.toHaveBeenCalled();
  });

  it("purges sessions, webhookDeliveries, and the shop row itself", async () => {
    const deletedTables: unknown[] = [];
    const db = {
      delete: (table: unknown) => ({
        where: () => {
          deletedTables.push(table);
          return Promise.resolve(undefined);
        },
      }),
    } as unknown as Db;
    const sessionStorage = {
      findSessionsByShop: vi.fn().mockResolvedValue([{ id: "sess-1" }]),
      deleteSessions: vi.fn().mockResolvedValue(true),
    };

    await handleShopRedact(db, sessionStorage, "shop-1", "shop.myshopify.com");

    expect(sessionStorage.deleteSessions).toHaveBeenCalledWith(["sess-1"]);
    expect(deletedTables).toEqual([webhookDeliveries, shops]);
  });

  it("still purges webhookDeliveries and the shop row even if session cleanup throws", async () => {
    const deletedTables: unknown[] = [];
    const db = {
      delete: (table: unknown) => ({
        where: () => {
          deletedTables.push(table);
          return Promise.resolve(undefined);
        },
      }),
    } as unknown as Db;
    const sessionStorage = {
      findSessionsByShop: vi.fn().mockRejectedValue(new Error("boom")),
      deleteSessions: vi.fn(),
    };

    await expect(handleShopRedact(db, sessionStorage, "shop-1", "shop.myshopify.com")).resolves.toBeUndefined();

    expect(deletedTables).toEqual([webhookDeliveries, shops]);
  });
});

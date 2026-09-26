import { describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";

vi.mock("../shopify-fetch.server.js", () => ({ shopifyGraphQL: vi.fn() }));

const { loadInventoryVariants, syncInventoryFromWebhook } = await import("./inventory-sync.server.js");
const { shopifyGraphQL } = await import("../shopify-fetch.server.js");

describe("loadInventoryVariants", () => {
  it("loads every variant page for an inventory item", async () => {
    const graphQL = vi.fn()
      .mockResolvedValueOnce({
        inventoryItem: {
          variants: {
            nodes: [{ id: "variant-1", inventoryQuantity: 3, inventoryPolicy: "DENY", availableForSale: true }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      })
      .mockResolvedValueOnce({
        inventoryItem: {
          variants: {
            nodes: [{ id: "variant-2", inventoryQuantity: 3, inventoryPolicy: "CONTINUE", availableForSale: true }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

    await expect(loadInventoryVariants(
      "store.myshopify.com",
      "token",
      "gid://shopify/InventoryItem/1",
      graphQL,
    )).resolves.toEqual([
      expect.objectContaining({ id: "variant-1" }),
      expect.objectContaining({ id: "variant-2" }),
    ]);
    expect(graphQL.mock.calls[1]?.[0].variables.after).toBe("cursor-1");
  });

  it("fails closed when Shopify claims another page without a cursor", async () => {
    const graphQL = vi.fn().mockResolvedValue({
      inventoryItem: {
        variants: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    });

    await expect(loadInventoryVariants(
      "store.myshopify.com",
      "token",
      "gid://shopify/InventoryItem/1",
      graphQL,
    )).rejects.toThrow("omitted endCursor");
  });
});

describe("syncInventoryFromWebhook", () => {
  it("writes the variant's total inventoryQuantity, not the webhook's per-location value", async () => {
    vi.mocked(shopifyGraphQL).mockResolvedValue({
      inventoryItem: {
        variants: {
          nodes: [{
            id: "gid://shopify/ProductVariant/1",
            inventoryQuantity: 42,
            inventoryPolicy: "DENY",
            availableForSale: true,
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    } as never);

    const captured: Array<{ values: Record<string, unknown> }> = [];
    const fakeTx = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            captured.push({ values });
            return Promise.resolve();
          },
        }),
      }),
    };
    const db = {
      transaction: async (fn: (tx: typeof fakeTx) => Promise<void>) => fn(fakeTx),
    } as unknown as Db;

    // The webhook's own `available` (a single location's count, e.g. 5) must
    // NOT end up in the cache — only the variant's already-fetched total.
    await syncInventoryFromWebhook("shop-1", "store.myshopify.com", "token", 999, db);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.values["inventoryQuantity"]).toBe(42);
  });
});

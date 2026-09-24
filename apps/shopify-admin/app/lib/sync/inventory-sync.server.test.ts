import { describe, expect, it, vi } from "vitest";
import { loadInventoryVariants } from "./inventory-sync.server.js";

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

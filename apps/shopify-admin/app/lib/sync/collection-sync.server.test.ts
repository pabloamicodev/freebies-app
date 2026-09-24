import { describe, expect, it, vi } from "vitest";
import { removeCollectionFromCache } from "./collection-sync.server.js";

describe("removeCollectionFromCache", () => {
  it("removes the deleted collection from every cached product in that shop", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    await removeCollectionFromCache(
      "shop-1",
      "gid://shopify/Collection/42",
      { update } as never,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });
});

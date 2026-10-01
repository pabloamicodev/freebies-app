import { beforeEach, describe, expect, it, vi } from "vitest";

const queue: unknown[] = [];
const updates: Array<Record<string, unknown>> = [];
const chain: Record<string, unknown> = {};
for (const method of ["select", "from", "where", "innerJoin", "orderBy", "limit"]) chain[method] = () => chain;
chain["then"] = (resolve: (value: unknown) => void) => resolve(queue.shift());
chain["update"] = () => ({
  set: (values: Record<string, unknown>) => ({
    where: () => {
      updates.push(values);
      return Promise.resolve();
    },
  }),
});
const fakeDb = chain;

vi.mock("@promo/db", () => ({
  getDb: () => fakeDb,
  offerRewards: {},
  offers: {},
  shops: {},
  variantCache: {},
}));
vi.mock("../token-crypto.server.js", () => ({
  decryptToken: vi.fn(async (value: string) => {
    if (value === "bad") throw new Error("decrypt failed");
    return `plain-${value}`;
  }),
}));
vi.mock("../shopify-fetch.server.js", () => ({ shopifyGraphQL: vi.fn() }));
vi.mock("./product-sync.server.js", () => ({ PRODUCT_VARIANTS_QUERY: "q" }));

const { reconcileRows, reconcileShopVariants, reconcileAllShopsGiftVariants, giftVariantIdsForShop, RECONCILE_BATCH_SIZE } =
  await import("./gift-stock-reconcile.server.js");

const shop = { id: "s1", domain: "x.myshopify.com", accessToken: "t" };
const row = (id: string, over: Record<string, unknown> = {}) => ({
  variantGid: id,
  title: id,
  inventoryQuantity: 0,
  inventoryPolicy: "DENY",
  availableForSale: true,
  inventoryTracked: null,
  ...over,
});
const live = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  inventoryQuantity: 0,
  inventoryPolicy: "DENY",
  availableForSale: false,
  inventoryItem: { tracked: true },
  ...over,
});
const fresh = () => ({ checked: 0, missing: 0, changed: 0, stockChanged: 0, sample: [] as never[] });

beforeEach(() => {
  queue.length = 0;
  updates.length = 0;
});

describe("reconcileRows", () => {
  it("dry-run reports the stale rows and writes nothing", async () => {
    const graphQL = vi.fn().mockResolvedValue({ nodes: [live("a"), live("b", { availableForSale: true, inventoryQuantity: 4 })] });
    const totals = fresh();
    await reconcileRows(fakeDb as never, shop, [row("a"), row("b", { inventoryQuantity: 4, inventoryTracked: true })], { dryRun: true, graphQL: graphQL as never }, totals);
    expect(totals).toMatchObject({ checked: 2, changed: 1, stockChanged: 1, missing: 0 });
    expect(totals.sample[0]).toMatchObject({
      variantGid: "a",
      before: { availableForSale: true, inventoryTracked: null },
      after: { availableForSale: false, inventoryTracked: true },
    });
    expect(updates).toEqual([]);
  });

  it("applies changes and is idempotent: a second pass over the corrected rows changes nothing", async () => {
    const graphQL = vi.fn().mockResolvedValue({ nodes: [live("a")] });
    const first = fresh();
    await reconcileRows(fakeDb as never, shop, [row("a")], { graphQL: graphQL as never }, first);
    expect(first.changed).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ availableForSale: false, inventoryTracked: true, inventoryQuantity: 0 });

    const second = fresh();
    await reconcileRows(fakeDb as never, shop, [row("a", { availableForSale: false, inventoryTracked: true })], { graphQL: graphQL as never }, second);
    expect(second.changed).toBe(0);
    expect(updates).toHaveLength(1);
  });

  it("detects a policy-only change", async () => {
    const graphQL = vi.fn().mockResolvedValue({ nodes: [live("a", { availableForSale: true, inventoryPolicy: "CONTINUE", inventoryItem: { tracked: false } })] });
    const totals = fresh();
    await reconcileRows(fakeDb as never, shop, [row("a", { inventoryTracked: false })], { dryRun: true, graphQL: graphQL as never }, totals);
    expect(totals.changed).toBe(1);
    expect(totals.stockChanged).toBe(1);
  });

  it("tracked-flag-only differences count as changed but not as stock changes", async () => {
    const graphQL = vi.fn().mockResolvedValue({ nodes: [live("a", { availableForSale: true })] });
    const totals = fresh();
    await reconcileRows(fakeDb as never, shop, [row("a")], { dryRun: true, graphQL: graphQL as never }, totals);
    expect(totals).toMatchObject({ changed: 1, stockChanged: 0 });
  });

  it("batches Shopify lookups and counts variants Shopify no longer returns", async () => {
    const ids = Array.from({ length: RECONCILE_BATCH_SIZE * 2 + 5 }, (_, i) => `v${i}`);
    const graphQL = vi.fn(async ({ variables }: { variables: { ids: string[] } }) => ({
      nodes: variables.ids.map((id) => (id === "v3" ? null : live(id))),
    }));
    const totals = fresh();
    await reconcileRows(fakeDb as never, shop, ids.map((id) => row(id)), { dryRun: true, graphQL: graphQL as never, sampleLimit: 2 }, totals);
    expect(graphQL).toHaveBeenCalledTimes(3);
    expect(graphQL.mock.calls.every(([call]) => call.variables.ids.length <= RECONCILE_BATCH_SIZE)).toBe(true);
    expect(totals).toMatchObject({ checked: ids.length - 1, missing: 1, changed: ids.length - 1 });
    expect(totals.sample).toHaveLength(2);
  });

  it("propagates Shopify errors (throttling retries live in shopifyGraphQL) without writing", async () => {
    const graphQL = vi.fn().mockRejectedValue(new Error("Shopify GraphQL throttled"));
    await expect(reconcileRows(fakeDb as never, shop, [row("a")], { graphQL: graphQL as never }, fresh())).rejects.toThrow("throttled");
    expect(updates).toEqual([]);
  });
});

describe("giftVariantIdsForShop", () => {
  it("collects variants and fallbacks of active gift rewards, deduplicated", async () => {
    queue.push([
      { target: { variantIds: ["a", "b"], fallbackVariantIds: ["f"] } },
      { target: { variantId: "a", fallbackVariantIds: ["f", "g"] } },
    ]);
    expect((await giftVariantIdsForShop("s1", fakeDb as never)).sort()).toEqual(["a", "b", "f", "g"]);
  });
});

describe("reconcileShopVariants", () => {
  it("scope all pages through every cached variant with a keyset cursor", async () => {
    const page1 = Array.from({ length: RECONCILE_BATCH_SIZE * 5 }, (_, i) => row(`v${String(i).padStart(4, "0")}`));
    const page2 = [row("v9999")];
    queue.push([{ domain: "x.myshopify.com", token: "enc" }], page1, page2, []);
    const graphQL = vi.fn(async ({ variables }: { variables: { ids: string[] } }) => ({
      nodes: variables.ids.map((id) => live(id)),
    }));
    const result = await reconcileShopVariants("s1", { scope: "all", dryRun: true, graphQL: graphQL as never, sampleLimit: 3 });
    expect(result.checked).toBe(page1.length + 1);
    expect(result.changed).toBe(page1.length + 1);
    expect(result.sample).toHaveLength(3);
    expect(updates).toEqual([]);
    expect(graphQL.mock.calls[0]![0]).toMatchObject({ accessToken: "plain-enc" });
  });

  it("returns an empty result for an uninstalled or unknown shop", async () => {
    queue.push([]);
    expect(await reconcileShopVariants("gone", { dryRun: true })).toEqual({ checked: 0, missing: 0, changed: 0, stockChanged: 0, sample: [] });
  });
});

describe("reconcileAllShopsGiftVariants", () => {
  it("keeps going when one shop fails and reports the failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    queue.push(
      [{ id: "a" }, { id: "b" }],
      [{ domain: "a.myshopify.com", token: "bad" }],
      [{ domain: "b.myshopify.com", token: "ok" }],
      [{ target: { variantIds: ["v1"] } }],
      [row("v1")],
    );
    const graphQL = vi.fn().mockResolvedValue({ nodes: [live("v1")] });
    const result = await reconcileAllShopsGiftVariants({ dryRun: true, graphQL: graphQL as never });
    expect(result).toEqual({ shops: 2, changed: 1, failed: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

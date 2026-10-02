import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifyOutcomeUnknownError, shopifyGraphQL } from "./shopify-fetch.server.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ok = (data: unknown, extensions?: unknown) =>
  new Response(JSON.stringify({ data, ...(extensions ? { extensions } : {}) }), { status: 200 });
const call = (query: string, extra: Record<string, unknown> = {}) =>
  shopifyGraphQL<{ x: number }>({ shopDomain: "s.myshopify.com", accessToken: "t", query, ...extra });

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const wrapped = promise.then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason: unknown) => ({ status: "rejected", reason }) as const,
  );
  await vi.runAllTimersAsync();
  return wrapped;
}

describe("shopifyGraphQL: queries", () => {
  it("retries a timed-out or failed query", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(ok({ x: 1 }));
    const result = await settle(call("query Q { x }"));
    expect(result).toMatchObject({ status: "fulfilled", value: { x: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx query", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 502 })).mockResolvedValueOnce(ok({ x: 2 }));
    expect(await settle(call("query Q { x }"))).toMatchObject({ status: "fulfilled", value: { x: 2 } });
  });

  it("ends in ShopifyOutcomeUnknownError when every retry fails", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const result = await settle(call("{ x }", { maxRetries: 1 }));
    expect(result).toMatchObject({ status: "rejected" });
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ShopifyOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("shopifyGraphQL: mutations are never blindly re-sent", () => {
  const mutation = "mutation M { thing { id } }";

  it("surfaces a timeout as ShopifyOutcomeUnknownError after exactly one attempt", async () => {
    fetchMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    const result = await settle(call(mutation));
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ShopifyOutcomeUnknownError);
    expect(((result as PromiseRejectedResult).reason as Error).message).toContain("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does the same for a 5xx", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    const result = await settle(call(mutation));
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ShopifyOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does the same when the response body is cut off", async () => {
    fetchMock.mockResolvedValue(new Response("{\"data\":", { status: 200 }));
    const result = await settle(call(mutation));
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ShopifyOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a 429, because Shopify rejected that request unexecuted", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(ok({ x: 3 }));
    expect(await settle(call(mutation))).toMatchObject({ status: "fulfilled", value: { x: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still retries GraphQL throttling errors", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Throttled" }] }), { status: 200 }))
      .mockResolvedValueOnce(ok({ x: 4 }));
    expect(await settle(call(mutation))).toMatchObject({ status: "fulfilled", value: { x: 4 } });
  });

  it("an idempotent mutation can opt in to retries", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValueOnce(ok({ x: 5 }));
    expect(await settle(call(mutation, { retryable: true }))).toMatchObject({ status: "fulfilled", value: { x: 5 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recognises a mutation however the document is written", async () => {
    fetchMock.mockRejectedValue(new Error("x"));
    const result = await settle(call("\n  mutation   Named($a: Int) { thing }"));
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ShopifyOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not turn a 4xx or a GraphQL error into an unknown outcome", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 403 }));
    const forbidden = await settle(call(mutation));
    expect((forbidden as PromiseRejectedResult).reason).not.toBeInstanceOf(ShopifyOutcomeUnknownError);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Field x doesn't exist" }] }), { status: 200 }));
    const invalid = await settle(call(mutation));
    expect((invalid as PromiseRejectedResult).reason).not.toBeInstanceOf(ShopifyOutcomeUnknownError);
  });
});

describe("shopifyGraphQL: query cost reporting", () => {
  it("hands extensions.cost to onCost", async () => {
    fetchMock.mockResolvedValue(
      ok(
        { x: 1 },
        {
          cost: {
            requestedQueryCost: 812,
            actualQueryCost: 143,
            throttleStatus: { currentlyAvailable: 1900, maximumAvailable: 2000, restoreRate: 100 },
          },
        },
      ),
    );
    const onCost = vi.fn();
    await settle(call("{ x }", { onCost }));
    expect(onCost).toHaveBeenCalledWith({
      requestedQueryCost: 812,
      actualQueryCost: 143,
      throttleStatus: { currentlyAvailable: 1900, maximumAvailable: 2000, restoreRate: 100 },
    });
  });

  it("does nothing when the response carries no cost", async () => {
    fetchMock.mockResolvedValue(ok({ x: 1 }));
    const onCost = vi.fn();
    await settle(call("{ x }", { onCost }));
    expect(onCost).not.toHaveBeenCalled();
  });
});

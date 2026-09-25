import { describe, expect, it } from "vitest";
import type { HeadersArgs } from "react-router";
import { shopifyHeaders } from "./shopify-headers.js";

function callHeaders(overrides: Partial<HeadersArgs> = {}) {
  const result = shopifyHeaders({
    parentHeaders: new Headers(),
    loaderHeaders: new Headers(),
    actionHeaders: new Headers(),
    errorHeaders: new Headers(),
    ...overrides,
  } as HeadersArgs);

  return new Headers(result);
}

describe("shopifyHeaders", () => {
  it("preserves parent, loader, and action headers for successful requests", () => {
    const headers = callHeaders({
      parentHeaders: new Headers({ "x-parent": "parent" }),
      loaderHeaders: new Headers({ "x-loader": "loader" }),
      actionHeaders: new Headers({ "x-action": "action" }),
    });

    expect(headers.get("x-parent")).toBe("parent");
    expect(headers.get("x-loader")).toBe("loader");
    expect(headers.get("x-action")).toBe("action");
  });

  it("returns Shopify error headers without replacing them with loader headers", () => {
    const headers = callHeaders({
      parentHeaders: new Headers({ "x-parent": "parent" }),
      loaderHeaders: new Headers({ "x-loader": "loader" }),
      errorHeaders: new Headers({
        "x-shopify-retry-invalid-session-request": "1",
        "x-shopify-api-request-failure-reauthorize-url": "https://example.test/reauthorize",
      }),
    });

    expect(headers.get("x-shopify-retry-invalid-session-request")).toBe("1");
    expect(headers.get("x-shopify-api-request-failure-reauthorize-url")).toBe(
      "https://example.test/reauthorize",
    );
    expect(headers.has("x-loader")).toBe(false);
    expect(headers.has("x-parent")).toBe(false);
  });
});

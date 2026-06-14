/**
 * Resilient Shopify Admin GraphQL caller for server-side / background contexts
 * that hold an offline access token directly (not a request-scoped `admin`
 * client). Handles Shopify's two throttling signals:
 *
 *  - HTTP 429 (REST-style) with a `Retry-After` header
 *  - HTTP 200 + GraphQL `extensions.cost.throttleStatus` running low
 *
 * plus transient 5xx, with exponential backoff. Mirrors what the SDK's
 * `admin.graphql()` does NOT do automatically.
 */

import { SHOPIFY_API_VERSION } from "./shopify-api-version.js";

interface ShopifyGraphQLOptions {
  shopDomain: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
  maxRetries?: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: {
      throttleStatus?: { currentlyAvailable: number; maximumAvailable: number; restoreRate: number };
    };
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function shopifyGraphQL<T>({
  shopDomain,
  accessToken,
  query,
  variables,
  maxRetries = 4,
}: ShopifyGraphQLOptions): Promise<T> {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 0.5s, 1s, 2s, 4s — capped
      await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (networkErr) {
      lastError = networkErr instanceof Error ? networkErr : new Error(String(networkErr));
      continue; // retry transient network failures
    }

    // Rate limited — honor Retry-After then retry
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000);
      lastError = new Error("Shopify rate limited (429)");
      continue;
    }

    // Transient server errors — retry
    if (response.status >= 500) {
      lastError = new Error(`Shopify ${response.status} ${response.statusText}`);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as GraphQLResponse<T>;

    if (body.errors && body.errors.length > 0) {
      // GraphQL-level throttle is reported as an error with a low throttle status
      const throttled = body.errors.some((e) => /throttl/i.test(e.message));
      if (throttled && attempt < maxRetries) {
        lastError = new Error(`Shopify GraphQL throttled: ${body.errors.map((e) => e.message).join(", ")}`);
        continue;
      }
      throw new Error(`Shopify GraphQL errors: ${body.errors.map((e) => e.message).join(", ")}`);
    }

    // Proactively back off if the cost bucket is nearly empty (next call would throttle)
    const throttle = body.extensions?.cost?.throttleStatus;
    if (throttle && throttle.currentlyAvailable < 100) {
      await sleep(1000);
    }

    if (!body.data) throw new Error("Shopify GraphQL returned no data");
    return body.data;
  }

  throw lastError ?? new Error("Shopify GraphQL failed after retries");
}

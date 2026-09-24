/**
 * Collection search endpoint — for offer builder product selectors.
 * GET /api/collections/search?q=keyword
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { ApiError, apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length > 100) {
      return apiError(request, { status: 400, code: "QUERY_TOO_LONG", message: "Search query is too long." });
    }
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Math.max(1, Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 50));

  const query = `
    query GetCollections($query: String!, $first: Int!) {
      collections(query: $query, first: $first) {
        nodes {
          id
          title
          handle
          productsCount { count }
          image { url }
        }
      }
    }
  `;

    const response = await admin.graphql(query, {
      variables: { query: q ? `title:*${q.replace(/[\\:*()]/g, " ")}*` : "", first: limit },
    });

  interface CollectionsQueryResult {
    errors?: Array<{ message?: string }>;
    data?: {
      collections?: {
        nodes?: Array<{ id: string; title: string; handle: string; productsCount: { count: number }; image: { url: string } | null }>;
      };
    };
  }
    const data = (await response.json()) as CollectionsQueryResult;
    if (!response.ok || (data.errors?.length ?? 0) > 0 || !data.data?.collections) {
      throw new ApiError({
        status: 502,
        code: "SHOPIFY_COLLECTIONS_UNAVAILABLE",
        message: "Shopify collections are temporarily unavailable. Retry shortly.",
        retryable: true,
      });
    }
    const collections = data.data?.collections?.nodes ?? [];

    return apiJson(request, { collections }, { status: 200 });
  } catch (error) {
    return handleApiError(request, error, "api.products.search.collections");
  }
};

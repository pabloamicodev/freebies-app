/**
 * Collection search endpoint — for offer builder product selectors.
 * GET /api/collections/search?q=keyword
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 50);

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
    variables: { query: q ? `title:*${q}*` : "", first: limit },
  });

  interface CollectionsQueryResult {
    data?: {
      collections?: {
        nodes?: Array<{ id: string; title: string; handle: string; productsCount: { count: number }; image: { url: string } | null }>;
      };
    };
  }
  const data = (await response.json()) as CollectionsQueryResult;
  const collections = data.data?.collections?.nodes ?? [];

  return Response.json({ collections }, { status: 200 });
};

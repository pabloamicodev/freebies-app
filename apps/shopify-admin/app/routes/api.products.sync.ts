/**
 * POST /api/products/sync
 *
 * Queues a resumable catalog sync and exposes its progress.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import * as Sentry from "@sentry/node";
import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { drainProductSyncQueue, getProductSyncJob, queueProductSync } from "../lib/sync/product-sync.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

async function findShopId(domain: string) {
  const [shop] = await getDb().select({ id: shops.id }).from(shops)
    .where(eq(shops.myshopifyDomain, domain)).limit(1);
  return shop?.id ?? null;
}

function publicJob(job: Awaited<ReturnType<typeof getProductSyncJob>>) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    syncedProducts: job.syncedProducts,
    startedAt: job.syncStartedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    error: job.status === "failed" ? "Catalog sync failed after multiple retries." : null,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { session } = await authenticate.admin(request);
    const shopId = await findShopId(session.shop);
    if (!shopId) return apiError(request, { status: 404, code: "SHOP_NOT_FOUND", message: "Shop not found. Reinstall the app and retry." });
    return apiJson(request, { ok: true, job: publicJob(await getProductSyncJob(shopId)) });
  } catch (error) {
    return handleApiError(request, error, "api.products.sync.status");
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return apiError(request, {
      status: 405,
      code: "METHOD_NOT_ALLOWED",
      message: "Method not allowed.",
      headers: { Allow: "POST" },
    });
  }

  try {
    const { session } = await authenticate.admin(request);
    const shopId = await findShopId(session.shop);
    if (!shopId) {
      return apiError(request, {
        status: 404,
        code: "SHOP_NOT_FOUND",
        message: "Shop not found. Reinstall the app and retry.",
      });
    }

    const job = await queueProductSync(shopId);
    waitUntil(drainProductSyncQueue({ shopId, maxSteps: 3, maxRuntimeMs: 25_000 }).catch((error) => {
      Sentry.captureException(error, { tags: { sync: "products", shop: session.shop } });
      console.error("product sync worker failed", error instanceof Error ? error.message : error);
    }));
    return apiJson(request, { ok: true, queued: true, job: publicJob(job) }, { status: 202 });
  } catch (err) {
    return handleApiError(request, err, "api.products.sync");
  }
}

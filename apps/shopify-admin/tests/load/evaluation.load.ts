/**
 * Load tests for the evaluation endpoint.
 * Run with: npx k6 run apps/shopify-admin/tests/load/evaluation.load.ts
 * Or adapt for Artillery / autocannon for pure Node.js.
 *
 * Targets from spec:
 * - 1,000 concurrent evaluation requests per shop during sale
 * - P95 < 120 ms (origin), P50 < 50 ms (cache hit)
 * - Max 2 extra cart API requests per cart update
 */

/**
 * Autocannon-based load test (Node.js, no external tooling required).
 * Run: npx tsx apps/shopify-admin/tests/load/evaluation.load.ts
 */

import type { EvaluationInput } from "@promo/shared-types";

const BASE_URL = process.env["LOAD_TEST_URL"] ?? "http://localhost:3000";
const SHOP_DOMAIN = process.env["LOAD_TEST_SHOP"] ?? "test-store.myshopify.com";
const CONCURRENT = parseInt(process.env["CONCURRENT"] ?? "10", 10);
const DURATION_SECONDS = parseInt(process.env["DURATION"] ?? "10", 10);

/** Build a realistic evaluation payload. */
function buildPayload(): EvaluationInput {
  return {
    shopDomain: SHOP_DOMAIN,
    cart: {
      token: `load-cart-${Math.random().toString(36).slice(2)}`,
      id: null,
      lines: Array.from({ length: 5 }, (_, i) => ({
        key: `line-${i}`,
        variantId: `gid://shopify/ProductVariant/${1000 + i}`,
        productId: `gid://shopify/Product/${100 + i}`,
        quantity: Math.floor(Math.random() * 3) + 1,
        priceCents: 2000 + i * 500,
        compareAtPriceCents: null,
        properties: {},
        requiresSellingPlan: false,
        sellingPlanId: null,
        productHandle: `product-${i}`,
        productTitle: `Product ${i}`,
        variantTitle: null,
        vendor: "Test Vendor",
        productType: "apparel",
        tags: [],
        collections: [],
        availableForSale: true,
        inventoryPolicy: "DENY" as const,
        inventoryQuantity: 10,
      })),
      subtotalCents: 15000,
      discountCodes: [],
      currencyCode: "USD",
      totalQuantity: 5,
    },
    customer: null,
    market: null,
    locale: "en",
    salesChannel: "online_store" as const,
    requestedUrl: null,
    sessionId: `load-session-${Math.random().toString(36).slice(2)}`,
  };
}

async function runLoadTest() {
  console.log(`Load test: ${CONCURRENT} concurrent, ${DURATION_SECONDS}s, target: ${BASE_URL}`);

  const results = { success: 0, error: 0, latencies: [] as number[] };
  const endTime = Date.now() + DURATION_SECONDS * 1000;

  async function worker() {
    while (Date.now() < endTime) {
      const start = Date.now();
      try {
        const res = await fetch(`${BASE_URL}/apps/promo-engine/evaluate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Promo-Shop": SHOP_DOMAIN,
            "X-Promo-Key": "test-key",
            "X-Promo-Session": "load-test",
          },
          body: JSON.stringify(buildPayload()),
        });
        if (res.ok) {
          results.success++;
          results.latencies.push(Date.now() - start);
        } else {
          results.error++;
        }
      } catch {
        results.error++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENT }, worker));

  const sorted = results.latencies.sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  const rps = results.success / DURATION_SECONDS;

  console.log("\n=== Load Test Results ===");
  console.log(`Total requests: ${results.success + results.error}`);
  console.log(`Success: ${results.success} (${((results.success / (results.success + results.error)) * 100).toFixed(1)}%)`);
  console.log(`Errors: ${results.error}`);
  console.log(`RPS: ${rps.toFixed(1)}`);
  console.log(`Latency P50: ${p50}ms (target: <50ms cache, <120ms origin)`);
  console.log(`Latency P95: ${p95}ms (target: <120ms)`);
  console.log(`Latency P99: ${p99}ms`);

  if (p95 > 120) {
    console.error("❌ P95 exceeds 120ms target");
    process.exit(1);
  } else {
    console.log("✅ P95 within target");
  }
}

runLoadTest().catch(console.error);

/**
 * k6 load test for the storefront hot path (D10), run against the hpn-test-store deployment only.
 *
 *   k6 run -e STORE_URL=https://hpn-test-store.myshopify.com \
 *          -e VARIANT_IDS=gid://shopify/ProductVariant/1,gid://shopify/ProductVariant/2 \
 *          [-e PROFILE=smoke|peak|soak] [-e STORE_COOKIE='storefront_digest=...'] [-e OFFER_ID=<uuid>] scripts/load/evaluate.k6.js
 *
 * Requests go through the Shopify app proxy (/apps/promo-engine/*) so Shopify signs them; the app origin is
 * never called directly. Passing a password-protected storefront: log in once in a browser and pass the
 * `storefront_digest` cookie via STORE_COOKIE. NEVER point this at a live merchant store.
 *
 * Profiles (requests/second to /evaluate; the shop cap is EVALUATE_SHOP_LIMIT_PER_MINUTE = 12000/min = 200 rps):
 *   smoke  5 rps for 1 min
 *   peak   ramp to 150 rps (the Prime Day estimate), hold 5 min, ramp to 220 rps for 1 min to confirm the cap returns 429
 *          rather than errors
 *   soak   60 rps for 30 min
 * Acceptance: p95 < 400 ms end to end through Shopify, error rate < 1% (429s above the cap are expected and excluded),
 * and Server-Timing totals in the logs staying < 120 ms at the origin.
 * Watch while it runs: Neon connections/CPU, Upstash command rate, Vercel function concurrency, Sentry.
 */
import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

const STORE_URL = (__ENV.STORE_URL || "").replace(/\/$/, "");
const PROFILE = __ENV.PROFILE || "smoke";
const VARIANTS = (__ENV.VARIANT_IDS || "gid://shopify/ProductVariant/1").split(",");
const OFFER_ID = __ENV.OFFER_ID || "";
// EvaluationInputSchema requires the shop domain and an absolute requestedUrl.
const SHOP_DOMAIN = __ENV.SHOP_DOMAIN || STORE_URL.replace(/^https?:\/\//, "");
const headers = { "Content-Type": "application/json", ...(__ENV.STORE_COOKIE ? { Cookie: __ENV.STORE_COOKIE } : {}) };

const profiles = {
  smoke: [{ duration: "1m", target: 5 }],
  peak: [
    { duration: "2m", target: 150 },
    { duration: "5m", target: 150 },
    { duration: "30s", target: 220 },
    { duration: "1m", target: 220 },
    { duration: "30s", target: 0 },
  ],
  soak: [
    { duration: "2m", target: 60 },
    { duration: "30m", target: 60 },
  ],
};

export const options = {
  scenarios: {
    evaluate: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: profiles[PROFILE] || profiles.smoke,
      exec: "evaluate",
    },
    storefront_gets: {
      executor: "constant-arrival-rate",
      rate: PROFILE === "smoke" ? 1 : 20,
      timeUnit: "1s",
      duration: PROFILE === "soak" ? "32m" : "9m",
      preAllocatedVUs: 20,
      maxVUs: 100,
      exec: "bundleGet",
    },
  },
  thresholds: {
    "http_req_duration{kind:evaluate}": ["p(95)<400"],
    "http_req_duration{kind:bundle}": ["p(95)<400"],
    evaluate_server_errors: ["rate<0.01"],
  },
};

const serverErrors = new Rate("evaluate_server_errors");
const rateLimited = new Rate("evaluate_rate_limited");
const originMs = new Trend("evaluate_origin_total_ms");

function cartPayload() {
  const token = `k6-${__VU}-${__ITER % 50}-${Math.random().toString(36).slice(2, 8)}`;
  const lines = VARIANTS.slice(0, 5).map((variantId, i) => ({
    key: `${variantId}:${i}`,
    variantId,
    productId: "gid://shopify/Product/1",
    quantity: 1 + (i % 3),
    priceCents: 2500 + i * 500,
    compareAtPriceCents: null,
    properties: {},
    requiresSellingPlan: false,
    sellingPlanId: null,
    productHandle: `product-${i}`,
    productTitle: `Product ${i}`,
    variantTitle: null,
    vendor: "k6",
    productType: "load",
    tags: [],
    collections: [],
    availableForSale: true,
    inventoryPolicy: "DENY",
    inventoryQuantity: 100,
  }));
  return {
    shopDomain: SHOP_DOMAIN,
    cart: {
      token,
      id: null,
      lines,
      subtotalCents: lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0),
      discountCodes: [],
      currencyCode: "USD",
      totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    },
    customer: null,
    market: null,
    locale: "en",
    salesChannel: "online_store",
    requestedUrl: `${STORE_URL}/cart`,
    sessionId: `k6-session-${__VU}`,
  };
}

export function evaluate() {
  const response = http.post(`${STORE_URL}/apps/promo-engine/evaluate`, JSON.stringify(cartPayload()), {
    headers,
    tags: { kind: "evaluate" },
  });
  const limited = response.status === 429;
  rateLimited.add(limited);
  serverErrors.add(!limited && response.status >= 500);
  const phases = (response.headers["Server-Timing"] || "").match(/dur=[\d.]+/g);
  if (phases) originMs.add(phases.reduce((sum, phase) => sum + Number(phase.slice(4)), 0));
  check(response, { "evaluate 200 or 429": (r) => r.status === 200 || r.status === 429 });
}

export function bundleGet() {
  const query = OFFER_ID ? `?offer_id=${OFFER_ID}` : "";
  const response = http.get(`${STORE_URL}/apps/promo-engine/bundle${query}`, { headers, tags: { kind: "bundle" } });
  check(response, { "bundle 200": (r) => r.status === 200 });
}

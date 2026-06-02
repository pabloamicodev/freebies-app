/**
 * Promo Engine Web Pixel
 * Runs in a Web Worker sandbox — no DOM access, no cookies.
 * Collects browser-side events and relays to analytics backend.
 */

const ANALYTICS_ENDPOINT = "/apps/promo-engine/analytics";
const BATCH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 20;

let eventQueue = [];
let flushTimer = null;
let shopDomain = null;
let sessionId = null;

// ─── Standard Shopify events ─────────────────────────────────────────────────

analytics.subscribe("page_viewed", (event) => {
  enqueue({ event_name: "page_viewed", properties: { url: event.data?.["url"] ?? "" } });
});

analytics.subscribe("product_viewed", (event) => {
  const product = event.data?.["product"];
  enqueue({
    event_name: "product_viewed",
    properties: { product_id: product?.id ?? "", product_title: product?.title ?? "" },
  });
});

analytics.subscribe("cart_viewed", (_event) => {
  enqueue({ event_name: "cart_viewed", properties: {} });
});

analytics.subscribe("checkout_started", (event) => {
  enqueue({
    event_name: "checkout_started",
    properties: { total_value: event.data?.["checkout"]?.["totalPrice"]?.["amount"] ?? "" },
  });
});

analytics.subscribe("order_placed", (event) => {
  const order = event.data?.["checkout"];
  enqueue({
    event_name: "order_placed",
    properties: {
      order_id: order?.["order"]?.["id"] ?? "",
      total_value: order?.["totalPrice"]?.["amount"] ?? "",
    },
  });
});

// ─── Custom promo engine events ───────────────────────────────────────────────

analytics.subscribe("custom", (event) => {
  const name = event.name;
  if (!name || !name.startsWith("promo_engine:")) return;

  enqueue({
    event_name: name,
    offer_id: event.data?.["offer_id"] ?? null,
    offer_version: event.data?.["offer_version"] ?? null,
    widget_id: event.data?.["widget_id"] ?? null,
    properties: event.data ?? {},
  });
});

// ─── Queue + batched flush ────────────────────────────────────────────────────

function enqueue(event) {
  const enriched = {
    ...event,
    session_id: sessionId,
    cart_token: init?.data?.["cart"]?.["token"] ?? null,
    occurred_at: new Date().toISOString(),
  };

  eventQueue.push(enriched);

  if (eventQueue.length >= MAX_BATCH_SIZE) {
    flush();
    return;
  }

  if (!flushTimer) {
    flushTimer = setTimeout(flush, BATCH_INTERVAL_MS);
  }
}

function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (eventQueue.length === 0) return;

  const batch = eventQueue.splice(0, MAX_BATCH_SIZE);
  shopDomain = init?.data?.["shop"]?.["myshopifyDomain"] ?? null;

  if (!shopDomain) return;

  browser.sendBeacon(ANALYTICS_ENDPOINT, JSON.stringify({
    events: batch,
  }));
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// Extract session ID from init context (set by app embed before pixel loads)
try {
  sessionId = init?.data?.["customer"]?.["id"] ?? crypto.randomUUID();
} catch {
  sessionId = "anon";
}

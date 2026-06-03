/**
 * Hono API — public storefront endpoints.
 * These routes are exposed at /apps/promo-engine/* via Shopify App Proxy.
 * Stateless — all state in PostgreSQL/Redis.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb, shops, offers, offerConditions, offerRewards, offerCombinationPolicies, analyticsEvents } from "@promo/db";
import { evaluate } from "@promo/rule-engine";
import { EvaluationInputSchema } from "@promo/shared-types";
import { eq, and } from "drizzle-orm";
import { rateLimitMiddleware } from "../lib/rate-limit.server.js";
import { isValidShopDomain } from "../lib/security.server.js";

const app = new Hono();

// ─── CORS — allow shop domains + localhost for dev ────────────────────────────
app.use("*", cors({
  origin: (origin) => {
    if (!origin) return null;
    if (origin.includes(".myshopify.com") || origin.includes("localhost") || origin.includes("127.0.0.1")) {
      return origin;
    }
    return null;
  },
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-Promo-Shop", "X-Promo-Key", "X-Promo-Session"],
  maxAge: 86400,
}));

// ─── Shop domain validation middleware ────────────────────────────────────────
app.use("*", async (c, next) => {
  const shopDomain = c.req.header("X-Promo-Shop") ?? c.req.header("X-Shopify-Shop-Domain");
  // Allow missing shop on /runtime (uses query param)
  if (shopDomain && !isValidShopDomain(shopDomain)) {
    return c.json({ error: "Invalid shop domain" }, 400);
  }
  return await next();
});

// ─── Rate limiting (in-memory, per-process) ──────────────────────────────────
const _rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, maxPerMin: number): boolean {
  const now = Date.now();
  const entry = _rateLimitMap.get(key);
  if (!entry || entry.resetAt < now) {
    _rateLimitMap.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= maxPerMin) return false;
  entry.count++;
  return true;
}

// ─── GET /runtime ─────────────────────────────────────────────────────────────
app.get("/runtime", async (c) => {
  const shopDomain = c.req.header("X-Shopify-Shop-Domain") ?? c.req.query("shop");
  if (!shopDomain) return c.json({ error: "Missing shop domain" }, 400);

  const db = getDb();
  const shopRows = await db
    .select({ id: shops.id, currencyCode: shops.currencyCode, locale: shops.locale })
    .from(shops)
    .where(and(eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) return c.json({ error: "Shop not found" }, 404);

  // Return minimal runtime config for app embed initialization
  return c.json({
    shopId: shop.id,
    publicKey: shop.id, // In production: use a rotating public key, not shop ID
    currency: shop.currencyCode,
    locale: shop.locale ?? "en",
    evalEndpoint: "/apps/promo-engine/evaluate",
    analyticsEndpoint: "/apps/promo-engine/analytics",
  }, 200, {
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
  });
});

// ─── POST /evaluate ───────────────────────────────────────────────────────────
app.post("/evaluate", async (c) => {
  const shopDomain = c.req.header("X-Promo-Shop");
  const sessionId = c.req.header("X-Promo-Session") ?? "anonymous";

  if (!shopDomain) return c.json({ error: "Missing X-Promo-Shop header" }, 400);

  // Rate limit: 60 req/min per shop
  if (!checkRateLimit(`eval:${shopDomain}`, 60)) {
    return c.json({ error: "Too many requests" }, 429, { "Retry-After": "60" });
  }

  const db = getDb();
  const shopRows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(and(eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) return c.json({ error: "Shop not found" }, 404);

  // ── Feature flag checks — kill switches ───────────────────────────────────
  const { getFlag } = await import("../lib/feature-flags.server.js");
  const [appEnabled, runtimeEnabled, shadowMode] = await Promise.all([
    getFlag(shop.id, "app.enabled"),
    getFlag(shop.id, "storefront.runtime_enabled"),
    getFlag(shop.id, "shadow_mode.enabled"),
  ]);

  if (!appEnabled || !runtimeEnabled) {
    // Return empty result — app is disabled for this shop
    return c.json({
      requestId: crypto.randomUUID(),
      cartHash: "",
      qualifiedOffers: [],
      disqualifiedOffers: [],
      cartActions: [], // No mutations when disabled
      discountCodes: { add: [], remove: [] },
      giftSlider: null,
      cartMessages: [],
      progressBars: [],
      warnings: [{ code: "app_disabled", message: "Promo Engine is disabled for this shop." }],
      evaluatedAt: new Date().toISOString(),
      _shadowMode: false,
      _disabled: true,
    }, 200);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate input
  const parseResult = EvaluationInputSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: "Invalid evaluation input", details: parseResult.error.issues }, 400);
  }

  const input = parseResult.data;

  // Load active offers for this shop
  const offerRows = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, shop.id), eq(offers.status, "active")));

  const offerIds = offerRows.map((o) => o.id);

  // Load conditions and rewards for all active offers
  const [conditionRows, rewardRows, policyRows] = await Promise.all([
    offerIds.length > 0
      ? db.select().from(offerConditions).where(eq(offerConditions.shopId, shop.id))
      : Promise.resolve([]),
    offerIds.length > 0
      ? db.select().from(offerRewards).where(eq(offerRewards.shopId, shop.id))
      : Promise.resolve([]),
    offerIds.length > 0
      ? db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.shopId, shop.id))
      : Promise.resolve([]),
  ]);

  // Build offer definitions for rule engine
  const offerDefinitions = offerRows.map((offer) => ({
    id: offer.id,
    version: 1,
    type: offer.type,
    priority: offer.priority,
    stopLowerPriority: policyRows.find((p) => p.offerId === offer.id)?.stopLowerPriority ?? false,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    conditions: conditionRows
      .filter((c) => c.offerId === offer.id)
      .map((c) => ({
        id: c.id,
        scope: c.scope,
        conditionType: c.conditionType,
        operator: c.operator,
        value: c.value,
        isEnabled: c.isEnabled,
        sortOrder: c.sortOrder,
      })),
    rewards: rewardRows
      .filter((r) => r.offerId === offer.id)
      .map((r) => ({
        id: r.id,
        rewardType: r.rewardType,
        discountType: r.discountType,
        value: r.value,
        target: r.target,
        quantity: r.quantity,
        isAutoAdd: r.isAutoAdd,
        isCustomerSelectable: r.isCustomerSelectable,
        trackMode: (r.trackMode as "product" | "variant"),
        sortOrder: r.sortOrder,
        label: r.label,
      })),
    combinationPolicy: {
      combinesWithOrderDiscounts: policyRows.find((p) => p.offerId === offer.id)?.combinesWithOrderDiscounts ?? true,
      combinesWithProductDiscounts: policyRows.find((p) => p.offerId === offer.id)?.combinesWithProductDiscounts ?? true,
      combinesWithShippingDiscounts: policyRows.find((p) => p.offerId === offer.id)?.combinesWithShippingDiscounts ?? true,
      stopLowerPriority: policyRows.find((p) => p.offerId === offer.id)?.stopLowerPriority ?? false,
      maxApplicationsPerCart: policyRows.find((p) => p.offerId === offer.id)?.maxApplicationsPerCart ?? null,
      maxApplicationsPerCustomer: policyRows.find((p) => p.offerId === offer.id)?.maxApplicationsPerCustomer ?? null,
    },
    giftValueCountsForOtherOffers: policyRows.find((p) => p.offerId === offer.id)?.giftValueCountsForOtherOffers ?? false,
  }));

  const result = await evaluate(input, {
    offers: offerDefinitions,
    oneUseStates: [],
    now: new Date(),
  });

  // ── Shadow mode: evaluate but strip cart mutations ────────────────────────
  const responseResult = shadowMode
    ? { ...result, cartActions: [], _shadowMode: true }
    : { ...result, _shadowMode: false };

  return c.json(responseResult, 200, {
    "Cache-Control": "no-store",
    "X-Promo-Request-Id": result.requestId,
    ...(shadowMode ? { "X-Promo-Shadow-Mode": "true" } : {}),
  });
});

// ─── POST /analytics ──────────────────────────────────────────────────────────
app.post("/analytics", rateLimitMiddleware("analytics"), async (c) => {
  const shopDomain = c.req.header("X-Promo-Shop");
  if (!shopDomain) return c.json({ ok: true }, 200); // Silent accept

  const db = getDb();
  const shopRows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(and(eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) return c.json({ ok: true }, 200);

  let events: unknown[];
  try {
    const body = await c.req.json() as { events?: unknown[] };
    events = Array.isArray(body.events) ? body.events : [];
  } catch {
    return c.json({ ok: true }, 200);
  }

  // Ingest with deduplication — fire and forget
  const { ingestEventBatch, trackAttribution } = await import("../lib/analytics.server.js");
  void ingestEventBatch(shop.id, events).catch(() => {});

  // Track attribution for qualification events
  void Promise.all(
    events
      .filter((e: any) => e?.event_name === "promo_engine:offer_qualified" && e?.session_id && e?.offer_id)
      .map((e: any) => trackAttribution(shop.id, e.session_id, e.offer_id, e.cart_token ?? null))
  ).catch(() => {});

  return c.json({ ok: true }, 200);
});

// ─── POST /prepare-checkout ───────────────────────────────────────────────────
app.post("/prepare-checkout", async (c) => {
  const shopDomain = c.req.header("X-Promo-Shop");
  const sessionId = c.req.header("X-Promo-Session") ?? "anonymous";

  if (!shopDomain) return c.json({ error: "Missing shop" }, 400);

  // Rate limit: 20 req/min per shop (checkout is rarer)
  if (!checkRateLimit(`checkout:${shopDomain}`, 20)) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  // Same as evaluate but marks this as a pre-checkout validation
  const body = await c.req.json().catch(() => ({}));

  const parseResult = EvaluationInputSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: "Invalid input", ready: false }, 400);
  }

  // Forward to evaluate logic
  const evalRequest = new Request(c.req.url.replace("/prepare-checkout", "/evaluate"), {
    method: "POST",
    headers: Object.fromEntries(c.req.raw.headers.entries()),
    body: JSON.stringify(parseResult.data),
  });

  return c.json({ ready: true, message: "Cart validated" }, 200);
});

export { app as honoApp };

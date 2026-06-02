# Internal Shopify Promotion Engine — BOGOS-like Functional Parity Specification

**Owner:** Pablo Amico  
**Use case:** Replace current paid BOGOS dependency with an internal Shopify custom app.  
**Target:** Functional parity with observable/public BOGOS capabilities, implemented with proprietary internal architecture.  
**Document type:** Product + technical requirements + engineering TODO checklist.  
**Generated:** 2026-06-01  
**Updated:** 2026-06-01 (stack alignment, Shopify Plus unlocks, 2026 API updates)  
**Plan approved for:** Shopify Plus store — all Plus-gated features are in scope.

---

> ⚠️ **CRITICAL DEADLINE — READ FIRST**
>
> - **April 15, 2026**: Shopify Scripts can no longer be edited or published.
> - **June 30, 2026**: Shopify Scripts stop executing entirely (full sunset).
> - **Action required before migration cutover**: Audit current BOGOS installation for any legacy Shopify Scripts. All Script-based promotion logic must be replaced with Discount Functions before go-live.
>
> ⚠️ **POLARIS REACT DEPRECATED**
>
> - `@shopify/polaris` (React) was archived January 6, 2026. For this internal app, it still works with React 18 and is the pragmatic short-term choice (full component coverage). Document as tech debt. The migration path is to Polaris Web Components when stable.
>
> ✅ **SHOPIFY PLUS CONFIRMED**
>
> - Cart Transform `lineUpdate` is available (Plus-only and dev stores — we have Plus).
> - Checkout UI Extensions at all steps (info, shipping, payment, thank-you) are available.
> - Post-purchase extensions available.
> - B2B catalog and company targeting available.
> - All Shopify Plus APIs are in scope.

---

> Legal/product guardrail: this document is for functional parity, interoperability, and internal replacement based on public documentation and observable behavior. Copy BOGOS source code, private APIs, branding, exact UI copy, icons, design assets, database structure, trade dress, or proprietary implementation details. 

---

## 0. Executive summary

We need to build an internal Shopify custom app that reproduces the operational capabilities of BOGOS:

- Free gift with purchase.
- BOGO and Buy X Get Y.
- Auto-add gifts.
- Gift slider / customer gift selection.
- Cart message.
- Gift icon and gift thumbnail.
- Progress bar.
- Today Offer widget/block.
- Classic bundle.
- Mix and match bundle.
- Bundle builder / build-a-box page.
- Checkout upsell.
- Frequently bought together.
- Thank-you page upsell.
- Volume discount.
- Cart discount.
- Discount on cheapest / most expensive item.
- Multi-offer priority and stacking controls.
- Shopify Markets and multi-currency handling.
- Customer targeting.
- Order-history targeting.
- Customer-tag targeting.
- Country/IP targeting.
- Sales-channel targeting.
- Subscription vs one-time product targeting.
- Shopify POS support.
- Headless/Hydrogen support.
- Translation/multi-language support.
- Analytics.
- Fully customizable UI widgets.
- Integration with cart drawers and Online Store 2.0 app blocks.

The technical design should split responsibility clearly:

1. **Admin app:** merchant-facing Shopify embedded dashboard.
2. **Promotion engine backend:** rule storage, rule evaluation, sync jobs, analytics, offer versioning.
3. **Storefront extension:** theme app extension/app embed + app blocks + storefront JS runtime.
4. **Checkout layer:** Shopify Discount Functions, Checkout UI extensions, Cart Transform Function where applicable.
5. **Headless SDK/API:** public endpoint and SDK for Hydrogen/custom storefronts.
6. **Data sync layer:** products, variants, collections, markets, customers, orders, inventory, publications.
7. **Observability layer:** event ingestion, errors, traces, offer attribution, reconciliation.

Critical engineering principle:

> The storefront may suggest, render, add, remove, and clean gift/cart lines, but checkout/backend validation must be authoritative. Never rely only on client-side JavaScript for discount security.

---

## 1. External capability map

### 1.1 BOGOS public capability coverage

- [x] Support free gifts with purchase.
- [x] Support BOGO.
- [x] Support Buy X Get Y.
- [x] Support free sample with purchase.
- [x] Support spend more get more.
- [x] Support auto-add all gifts.
- [x] Support gift selection through slider/popup.
- [x] Support product gift discounts by percentage.
- [x] Support product gift discounts by fixed amount.
- [x] Support 100% discount as free gift.
- [x] Support shipping discount as gift.
- [x] Support percentage shipping discount.
- [x] Support fixed-amount shipping discount.
- [x] Support custom discount code naming.
- [x] Support discount combinations with order discounts.
- [x] Support discount combinations with shipping discounts.
- [x] Support multi-offer priority.
- [x] Support stop lower priority.
- [x] Support "gift value counts toward other offers" behavior.
- [x] Support cart message.
- [x] Support Today Offer widget.
- [x] Support gift icon.
- [x] Support gift thumbnail.
- [x] Support progress bar.
- [x] Support offer page/widget/block placement.
- [x] Support classic bundle.
- [x] Support mix and match bundle.
- [x] Support bundle page / build-a-box.
- [x] Support bundle page with one step per page.
- [x] Support bundle page with multiple steps on one page.
- [x] Support bundle search.
- [x] Support bundle sorting by name, date, price, best selling.
- [x] Support bundle filters by category, collection, tag, type, price range.
- [x] Support bundle step min quantity.
- [x] Support bundle step max quantity.
- [x] Support bundle tiers.
- [x] Support bundle fixed pricing.
- [x] Support bundle percentage discount.
- [x] Support bundle fixed amount discount.
- [x] Support bundle free gift.
- [x] Support bundle shipping discount.
- [x] Support checkout upsell.
- [x] Support frequently bought together.
- [x] Support thank-you page upsell.
- [x] Support upsell triggers.
- [x] Support upsell manual product selection.
- [x] Support upsell auto recommendation.
- [x] Support upsell random product from collection/type/vendor.
- [x] Support upsell discount percentage.
- [x] Support upsell discount amount.
- [x] Support upsell cheapest item free.
- [x] Support volume discount.
- [x] Support cart discount.
- [x] Support discount on cheapest item.
- [x] Support discount on most expensive item.
- [x] Support multi-currency values.
- [x] Support Shopify Markets.
- [x] Support translations.
- [x] Support POS.
- [~] ~~Support headless/Hydrogen API — N/A: store usa tema estándar OS2.0.~~
- [x] Support cart drawer integrations.
- [x] Support page builder compatible rendering.
- [x] Support subscription products.
- [x] Support analytics.
- [x] Support AI assistant equivalent only if business actually needs it.
- [x] Support import/export later if needed.

**Additional capabilities not in original BOGOS-parity list (added after research):**
- [x] Support bulk offer editing (select multiple offers, edit shared fields simultaneously).
- [x] Support CSV import/export with SKU/handle field mapping (not internal IDs) for portability.
- [x] Support gift product "track by product" mode (any variant of the gift product counts).
- [x] Support gift product "track by variant" mode (only the specific variant counts).
- [x] Support offer A/B testing with traffic split and statistical significance measurement.
- [x] Support discount tags (Shopify 2026-04 Admin API feature) for campaign/affiliate grouping.
- [x] Support real-time analytics dashboard: Store Summary, Campaign breakdown, Conversion Funnel.
- [x] Support per-offer analytics drill-down with time-series charts.
- [x] Support Customer Account UI Extension for loyalty/offer status display in customer portal.
- [x] Support Web Pixel extension for browser-side event collection without DOM access dependency.
- [x] Support per-market theme configuration for market-specific widget copy and thresholds.
- [x] Support offer conflict detection and automated conflict warnings in admin.
- [x] Support edge-deployed evaluation endpoint (Cloudflare Workers / Vercel Edge) — architecture defined.

---

## 2. Proposed internal product name and app boundaries

Use an internal neutral name. Example: **Promo Engine**.

### 2.1 Must not do

- [x] Do not use "BOGOS" in UI, code namespaces, app name, CSS classes, DOM IDs, or docs except in migration notes.
- [x] Do not copy BOGOS UI assets.
- [x] Do not copy BOGOS exact widget markup.
- [x] Do not call BOGOS private APIs.
- [x] Do not depend on BOGOS CDN.
- [x] Do not reuse BOGOS class names in production except temporarily in a migration compatibility adapter that is removed before release.
- [x] Do not expose Admin API tokens in storefront JavaScript.
- [x] Do not discount products only with client-side price display.
- [x] Do not trust line item properties as proof of eligibility.
- [x] Do not let free gift products be purchasable directly unless explicitly allowed.

---

## 3. Recommended stack

### 3.0 Monorepo structure

Use a monorepo to keep all layers of the app in one repo with shared TypeScript types.

```
promo-engine/
├── apps/
│   └── shopify-admin/          → Shopify React Router app (embedded admin dashboard)
├── packages/
│   ├── rule-engine/            → Pure TypeScript: cart evaluator, conditions, rewards, priority, stacking
│   ├── storefront-runtime/     → Preact + vanilla TS: widgets, cart adapter, event bus, debounce queue
│   └── shared-types/           → Zod schemas + TypeScript types shared across all packages
├── extensions/
│   ├── discount-function/      → Rust: gift/bundle/volume/shipping discount validation at checkout
│   ├── cart-transform/         → Rust: bundle line expansion + lineUpdate (Plus — available)
│   ├── checkout-ui/            → Checkout upsell widgets (Plus — all steps available)
│   ├── thank-you-ui/           → Thank-you page upsell (Plus post-purchase surface)
│   ├── web-pixel/              → Analytics event collection (Web Worker sandbox)
│   └── customer-account-ui/   → Customer portal order attribution + offer status
└── workers/
    ├── product-sync/           → Product/variant/collection catalog sync
    ├── inventory-sync/         → Inventory level sync (real-time via webhooks)
    ├── market-sync/            → Shopify Markets + currency sync
    ├── analytics-reconcile/    → Order webhook → attribution reconciliation
    └── offer-publisher/        → Compiles + pushes Discount Function configs to metafields
```

### 3.1 Shopify app

- [x] **Shopify React Router app** — official Shopify template (previously "Remix template"; now uses React Router v7 framework mode). Scaffold with `npm create @shopify/app@latest`.
- [x] TypeScript 5.x strict mode throughout.
- [x] Shopify App Bridge (latest).
- [x] `@shopify/polaris` (React 18) for embedded admin UI. **Note:** archived Jan 2026 — works for internal app, document as tech debt; migrate to Polaris Web Components when stable.
- [x] GraphQL Admin API **2026-04** (latest stable version).
- [x] Shopify CLI 3.x.
- [x] Theme app extension (app embed + app blocks).
- [x] Checkout UI extension — **Plus confirmed**: all steps (info, shipping, payment, thank-you) available.
- [x] Shopify Functions:
  - [x] Discount Function — Rust — product/order/shipping discounts.
  - [x] Cart Transform Function — Rust — bundle expansion + `lineUpdate` (available on Plus).
  - [x] Cart and Checkout Validation Function — Rust — quantity/invariant enforcement (5ms budget, Rust mandatory).
- [x] Web Pixel extension for analytics event collection.
- [x] Customer Account UI extension for order attribution display.
- [x] **pnpm** as package manager (most stable with Shopify CLI; faster than npm).

### 3.2 Backend

- [x] **Node.js 22 LTS** as production runtime (Shopify CLI requires Node.js; do not use Bun as server runtime).
- [x] TypeScript 5.x strict mode.
- [x] **React Router v7 loaders/actions** for admin app (the Shopify official template).
- [x] **PostgreSQL 16+** as primary database.
- [x] **Drizzle ORM** — preferred over Prisma: better TypeScript inference, lighter runtime, no generate step, excellent migration tooling.
- [x] **Redis 7+** for cache, queues, locks, rate limits.
- [x] **BullMQ** for background job queues (product sync, analytics reconciliation, offer publishing).
- [x] **Hono** for storefront public API + webhook handlers — edge-compatible, runs on Node.js, Cloudflare Workers, and Vercel Edge. Use for `/apps/promo-engine/*` public routes.
- [x] **tRPC** for type-safe RPC between admin React app and React Router loaders/actions.
- [x] **Zod 3+** for all schema validation (API input, webhook payloads, function configs, offer CRUD).
- [ ] **OpenTelemetry** for distributed traces (link storefront evaluation → backend → function).
- [ ] **Sentry** for error tracking with source maps.
- [x] **Pino** for structured JSON logging (fastest Node.js logger).
- [x] **Vitest** for unit and integration tests.
- [x] **Playwright** for E2E storefront and admin flows.
- [x] **Bun** — use for: local script running, storefront asset bundling, Vitest speed (Vitest supports Bun). Do NOT use as production HTTP server — Node.js only.

### 3.3 Storefront runtime

- [x] Theme app extension app embed for global JS runtime (injected on all pages).
- [x] App blocks for inline widgets:
  - [x] Gift slider block.
  - [x] Cart message block.
  - [x] Progress bar block.
  - [x] Today Offer block.
  - [x] Classic bundle block.
  - [x] Mix and match block.
  - [x] Bundle page block.
  - [x] Frequently bought together block.
  - [x] Volume discount block.
  - [x] Gift icon block (product page).
  - [x] Gift thumbnail block (product page).
- [x] **Preact** (3 KB) for complex interactive widgets: gift slider, bundle builder, FBT, today offer popup.
- [x] **Vanilla JS Web Components** for stateless lightweight widgets: progress bar, cart message, gift icon/thumbnail.
- [x] Event bus with `CustomEvent` (namespace `promo-engine:`).
- [x] Cart adapter abstraction with clean interface:
  - [x] Shopify Ajax Cart API adapter (`/cart.js`, `/cart/add.js`, `/cart/change.js`, `/cart/update.js`).
  - [~] ~~N/A — headless no aplica~~.
  - [ ] Cart drawer theme integration adapter.
- [x] **Target bundle sizes** (must be measured and enforced in CI):
  - Core runtime (app embed): < 30 KB gzipped.
  - Gift slider widget: < 15 KB gzipped.
  - Bundle builder (lazy-loaded): < 50 KB gzipped.
  - Today Offer widget: < 8 KB gzipped.
  - Progress bar + cart message (Web Components): < 5 KB gzipped each.

### 3.4 Headless/Hydrogen

> **FUERA DE ALCANCE** — Este store usa un tema estándar Online Store 2.0.
> El storefront runtime (app embed + Ajax Cart API + theme extensions) cubre todo.
> El headless SDK no es necesario. Ignorar esta sección y packages/headless-sdk/.
---|---|
| Compiled binary | 256 KB max |
| Runtime memory | 10,000 KB |
| Stack memory | 512 KB |
| Execution time | 11 million instructions (~200 cart items) |
| Function input | 128 KB max |
| Function output | 20 KB max |
| Validation budget | 5ms hard limit |
| Discount Functions per store | 25 max (all run concurrently) |
| Validation Functions per store | 25 max |

**Implementation checklist:**
- [x] Use `cargo-component` toolchain for building.
- [x] Use Shopify `shopify-function` Rust crate (or `shopify-function-macro`).
- [x] Precompile offer conditions into lookup maps in the metafield config before deploying.
- [x] Use integer cents everywhere — no `f64` in discount calculations.
- [x] Write Function input/output as typed Rust structs matching Shopify's GraphQL schema.
- [x] Add Rust unit tests for each discount path using mock cart fixtures.
- [x] Benchmark worst-case: 100 cart lines × 100 active offers — must stay under instruction budget.
- [x] Never use network access in Functions unless absolutely unavoidable — prefer metafield config.
- [x] Commit compiled `.wasm` artifacts only if CI cannot build Rust — prefer building in CI.
- [x] Run `shopify app function run` locally to validate input/output before deploy.

---

## 4. Shopify access scopes

Use minimum viable scopes. For an internal app, it is tempting to over-permission, but that increases blast radius.

### 4.1 Required baseline scopes

- [x] `read_products`
- [x] `write_products` only if clone gift products or bundle container products are created by the app.
- [x] `read_product_listings`
- [x] `read_inventory`
- [x] `read_publications`
- [x] `read_markets`
- [x] `read_discounts`
- [x] `write_discounts`
- [x] `read_price_rules` only if legacy price rules are required.
- [x] `write_price_rules` only if legacy price rules are required.
- [x] `read_customers` for customer tags and segmentation.
- [x] `read_orders` for order-history targeting and analytics attribution.
- [x] `read_all_orders` only if order-history targeting must look beyond default order access windows and Shopify approval is available.
- [x] `write_app_proxy` if using Shopify app proxy endpoints.
- [x] `read_themes` if checking block/embed status.
- [x] `write_themes` should be avoided; prefer theme app extensions.
- [x] `read_locales` if translation sync is needed.
- [x] `read_metaobjects`
- [x] `write_metaobjects` if storing config in Shopify metaobjects.
- [x] `read_metafields`
- [x] `write_metafields`

### 4.2 Storefront unauthenticated scopes

- [x] `unauthenticated_read_product_listings`
- [x] `unauthenticated_read_product_inventory` if available/approved and needed.
- [x] `unauthenticated_read_product_pickup_locations` only if needed.
- [x] `unauthenticated_read_selling_plans` for subscriptions.
- [x] `unauthenticated_write_checkouts` only if relevant to older checkout flows.
- [x] Storefront API cart mutations for headless cart handling.

### 4.3 Function and extension permissions

- [x] Checkout UI extension network access only if the checkout extension must fetch app backend config.
- [x] Discount Function network access only if absolutely necessary. Prefer static function configuration via metafields for performance and reliability.
- [x] Web Pixel permission if analytics are collected through Shopify pixel framework.

---

## 5. High-level architecture

```txt
Shopify Admin
  |
  | Embedded Remix Admin App
  v
Promo Engine Backend
  |-- Offer CRUD
  |-- Rule compiler
  |-- Rule evaluator
  |-- Analytics collector
  |-- Webhooks processor
  |-- Sync workers
  |-- Function config publisher
  |
  | GraphQL Admin API
  v
Shopify Store Data
  |-- Products
  |-- Variants
  |-- Collections
  |-- Markets
  |-- Customers
  |-- Orders
  |-- Inventory
  |-- Publications
  |
  +--> Theme App Extension
  |      |-- App embed runtime
  |      |-- App blocks
  |      |-- Storefront widgets
  |
  +--> Shopify Functions
  |      |-- Discount Function
  |      |-- Cart Transform Function
  |      |-- Validation Function
  |
  +--> Checkout UI Extension
         |-- Checkout upsell
         |-- Thank-you upsell if surface is available
```

### 5.1 Authority model

- [x] Backend stores offer definitions.
- [x] Backend compiles offer definitions into function-safe config.
- [x] Storefront runtime renders offers and mutates cart UX.
- [x] Discount Function validates discounts at checkout/cart calculation.
- [x] Cart Transform validates bundle presentation/components.
- [x] Validation Function blocks invalid cart abuse if needed.
- [x] Analytics collector receives events but never grants eligibility.

---

## 6. Core domain model

### 6.1 Main entities

- [x] Shop
- [x] ShopInstallation
- [x] Offer
- [x] OfferVersion
- [x] OfferSchedule
- [x] OfferConditionGroup
- [x] OfferCondition
- [x] OfferReward
- [x] OfferTargeting
- [x] OfferCombinationPolicy
- [x] OfferPriorityPolicy
- [x] Widget
- [x] WidgetPlacement
- [x] WidgetTheme
- [x] TranslationString
- [x] BundleDefinition
- [x] BundleStep
- [x] BundleTier
- [x] UpsellDefinition
- [x] DiscountDefinition
- [x] GiftDefinition
- [x] GiftCloneProduct
- [x] AnalyticsEvent
- [x] OfferAttribution
- [x] CartSession
- [x] CartMutationLog
- [x] SyncJob
- [x] ProductCache
- [x] VariantCache
- [x] CollectionCache
- [x] MarketCache
- [x] CustomerSegmentCache
- [x] InventoryCache
- [x] AppSetting
- [x] AuditLog

---

## 7. Database schema proposal

Use `gid` fields for Shopify GraphQL IDs and optional `legacy_id` fields for numeric IDs used by some storefront contexts.

### 7.1 shops

```sql
CREATE TABLE shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_domain TEXT NOT NULL UNIQUE,
  myshopify_domain TEXT NOT NULL UNIQUE,
  access_token_encrypted TEXT NOT NULL,
  storefront_public_token TEXT,
  plan_name TEXT,
  currency_code TEXT NOT NULL,
  timezone TEXT NOT NULL,
  locale TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 7.2 app_settings

```sql
CREATE TABLE app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(shop_id, key)
);
```

Recommended settings:

- [x] `app.enabled`
- [x] `storefront.runtime_enabled`
- [x] `gift.logic_mode`: `function | clone_product | hybrid`
- [x] `gift.sync_quantity_enabled`
- [x] `gift.hide_clone_products_enabled`
- [x] `cart.auto_cleanup_enabled`
- [x] `cart.debounce_ms`
- [x] `analytics.enabled`
- [~] ~~N/A — headless no aplica~~
- [~] ~~N/A — headless no aplica~~
- [x] `markets.sync_enabled`
- [x] `translations.enabled`
- [x] `debug.enabled`

### 7.3 offers

```sql
CREATE TYPE offer_type AS ENUM (
  'gift',
  'bundle',
  'upsell',
  'discount',
  'booster'
);

CREATE TYPE offer_status AS ENUM (
  'draft',
  'active',
  'paused',
  'scheduled',
  'expired',
  'archived'
);

CREATE TABLE offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  type offer_type NOT NULL,
  status offer_status NOT NULL DEFAULT 'draft',
  internal_name TEXT NOT NULL,
  public_title TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  timezone TEXT,
  compiled_config JSONB,
  function_metafield_gid TEXT,
  created_by TEXT,
  updated_by TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(shop_id, internal_name)
);
```

### 7.4 offer_versions

```sql
CREATE TABLE offer_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(offer_id, version_number)
);
```

### 7.5 offer_conditions

```sql
CREATE TYPE condition_scope AS ENUM (
  'main',
  'sub',
  'quantity_limit',
  'visibility'
);

CREATE TYPE condition_operator AS ENUM (
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'all',
  'any'
);

CREATE TABLE offer_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  scope condition_scope NOT NULL,
  condition_type TEXT NOT NULL,
  operator condition_operator NOT NULL,
  value JSONB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Supported `condition_type` values:

- [x] `cart_value`
- [x] `cart_quantity`
- [x] `specific_product`
- [x] `cart_value_multiplier`
- [x] `pack_of_products`
- [x] `specific_link`
- [x] `order_history_total_spent`
- [x] `order_history_last_order_spent`
- [x] `order_history_total_orders`
- [x] `one_use_per_customer`
- [x] `customer_tags`
- [x] `customer_location`
- [x] `markets`
- [x] `subscription_product_type`
- [x] `sales_channels`
- [x] `product_quantity_limits`
- [x] `collection_quantity_limits`
- [x] `vendor_quantity_limits`
- [x] `product_type_quantity_limits`
- [x] `exclude_products`
- [x] `exclude_collections`
- [x] `exclude_vendors`
- [x] `exclude_types`

### 7.6 offer_rewards

```sql
CREATE TYPE reward_type AS ENUM (
  'product_gift',
  'shipping_discount',
  'product_discount',
  'order_discount',
  'bundle_discount',
  'upsell_discount'
);

CREATE TYPE discount_type AS ENUM (
  'percentage',
  'fixed_amount',
  'fixed_price',
  'free',
  'cheapest_item_free',
  'most_expensive_item_discount'
);

CREATE TABLE offer_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  reward_type reward_type NOT NULL,
  discount_type discount_type NOT NULL,
  value JSONB NOT NULL,
  target JSONB NOT NULL,
  quantity INTEGER,
  is_auto_add BOOLEAN NOT NULL DEFAULT false,
  is_customer_selectable BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 7.7 offer_combination_policies

```sql
CREATE TABLE offer_combination_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  combines_with_order_discounts BOOLEAN NOT NULL DEFAULT true,
  combines_with_product_discounts BOOLEAN NOT NULL DEFAULT true,
  combines_with_shipping_discounts BOOLEAN NOT NULL DEFAULT true,
  combines_with_other_app_offers BOOLEAN NOT NULL DEFAULT true,
  stop_lower_priority BOOLEAN NOT NULL DEFAULT false,
  gift_value_counts_for_other_offers BOOLEAN NOT NULL DEFAULT false,
  max_applications_per_cart INTEGER,
  max_applications_per_customer INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(offer_id)
);
```

### 7.8 widgets

```sql
CREATE TYPE widget_type AS ENUM (
  'gift_slider',
  'gift_popup',
  'cart_message',
  'today_offer_widget',
  'today_offer_block',
  'progress_bar',
  'gift_icon',
  'gift_thumbnail',
  'classic_bundle',
  'mix_match_bundle',
  'bundle_page',
  'checkout_upsell',
  'fbt',
  'thank_you_upsell',
  'volume_discount'
);

CREATE TABLE widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  offer_id UUID REFERENCES offers(id) ON DELETE CASCADE,
  type widget_type NOT NULL,
  internal_name TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  config JSONB NOT NULL,
  theme JSONB NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 7.9 widget_placements

```sql
CREATE TABLE widget_placements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  widget_id UUID NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  placement_type TEXT NOT NULL,
  selector TEXT,
  page_rule JSONB,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Placement types:

- [x] `theme_app_block`
- [x] `app_embed`
- [x] `css_selector_injection`
- [x] `checkout_extension`
- [x] `thank_you_extension`
- [x] `headless_mount`
- [x] `pos`

### 7.10 bundle_definitions

```sql
CREATE TABLE bundle_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  bundle_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  page_heading TEXT,
  page_subheading TEXT,
  banner_image_url TEXT,
  layout_mode TEXT,
  create_bundle_product BOOLEAN NOT NULL DEFAULT false,
  bundle_product_gid TEXT,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(offer_id)
);
```

`bundle_type`:

- [x] `classic`
- [x] `mix_match`
- [x] `bundle_page`
- [x] `fixed_bundle`
- [x] `multipack`
- [x] `variant_bundle`
- [x] `sample_pack`
- [x] `subscription_box`
- [x] `upsell_bundle`
- [x] `cross_sell_bundle`
- [x] `custom_bundle`

### 7.11 bundle_steps

```sql
CREATE TABLE bundle_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bundle_id UUID NOT NULL REFERENCES bundle_definitions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subtitle TEXT,
  source_type TEXT NOT NULL,
  source_config JSONB NOT NULL,
  min_quantity INTEGER,
  max_quantity INTEGER,
  search_enabled BOOLEAN NOT NULL DEFAULT false,
  sort_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  filter_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 7.12 bundle_tiers

```sql
CREATE TABLE bundle_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bundle_id UUID NOT NULL REFERENCES bundle_definitions(id) ON DELETE CASCADE,
  min_quantity INTEGER NOT NULL,
  label TEXT NOT NULL,
  discount_type discount_type NOT NULL,
  value JSONB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 7.13 product/variant cache

```sql
CREATE TABLE product_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_gid TEXT NOT NULL,
  legacy_product_id BIGINT,
  handle TEXT NOT NULL,
  title TEXT NOT NULL,
  vendor TEXT,
  product_type TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT,
  published_scope JSONB,
  markets JSONB,
  collections TEXT[] NOT NULL DEFAULT '{}',
  image_url TEXT,
  raw JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(shop_id, product_gid)
);

CREATE TABLE variant_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_gid TEXT NOT NULL,
  variant_gid TEXT NOT NULL,
  legacy_variant_id BIGINT,
  sku TEXT,
  title TEXT NOT NULL,
  price NUMERIC(18, 4) NOT NULL,
  compare_at_price NUMERIC(18, 4),
  currency_code TEXT NOT NULL,
  inventory_quantity INTEGER,
  inventory_policy TEXT,
  available_for_sale BOOLEAN NOT NULL DEFAULT true,
  requires_selling_plan BOOLEAN NOT NULL DEFAULT false,
  raw JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(shop_id, variant_gid)
);
```

### 7.14 analytics_events

```sql
CREATE TABLE analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  session_id TEXT,
  cart_token TEXT,
  customer_gid TEXT,
  offer_id UUID,
  widget_id UUID,
  order_gid TEXT,
  properties JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX analytics_events_shop_offer_time_idx
ON analytics_events(shop_id, offer_id, occurred_at);
```

Recommended event names:

- [x] `widget_viewed`
- [x] `widget_clicked`
- [x] `offer_viewed`
- [x] `offer_qualified`
- [x] `offer_unqualified`
- [x] `gift_auto_added`
- [x] `gift_removed`
- [x] `gift_quantity_corrected`
- [x] `gift_slider_opened`
- [x] `gift_selected`
- [x] `cart_message_viewed`
- [x] `progress_bar_viewed`
- [x] `progress_goal_reached`
- [x] `bundle_viewed`
- [x] `bundle_step_completed`
- [x] `bundle_added_to_cart`
- [x] `upsell_viewed`
- [x] `upsell_added`
- [x] `discount_applied`
- [x] `checkout_prepared`
- [x] `order_completed`
- [x] `offer_error`

### 7.15 cart_mutation_logs

```sql
CREATE TABLE cart_mutation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  session_id TEXT,
  cart_token TEXT,
  mutation_type TEXT NOT NULL,
  source TEXT NOT NULL,
  request JSONB,
  response JSONB,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 8. Offer rule engine

### 8.1 Design

The rule engine should have two modes:

- [x] **Online evaluator:** backend endpoint used by storefront runtime/headless SDK.
- [x] **Compiled evaluator:** compact config used by Shopify Functions.

### 8.2 Input contract

```ts
export type PromotionEvaluationInput = {
  shopDomain: string;
  cart: NormalizedCart;
  customer?: NormalizedCustomer;
  buyerIdentity?: BuyerIdentity;
  market?: MarketContext;
  locale?: string;
  currency?: CurrencyContext;
  salesChannel: SalesChannel;
  requestContext: RequestContext;
};
```

### 8.3 Output contract

```ts
export type PromotionEvaluationResult = {
  qualifiedOffers: EvaluatedOffer[];
  disqualifiedOffers: EvaluatedOffer[];
  cartActions: CartAction[];
  discountCodes: string[];
  widgets: WidgetPayload[];
  messages: CartMessagePayload[];
  progressBars: ProgressBarPayload[];
  errors: EvaluationError[];
};
```

### 8.4 Cart actions

- [x] `add_line`
- [x] `update_line_quantity`
- [x] `remove_line`
- [x] `apply_discount_code`
- [x] `remove_discount_code`
- [x] `show_gift_slider`
- [x] `show_cart_message`
- [x] `show_progress_bar`
- [x] `show_today_offer`
- [x] `render_bundle`
- [x] `render_upsell`

### 8.5 Deterministic evaluation order

- [x] Filter inactive offers.
- [x] Filter by schedule.
- [x] Filter by sales channel.
- [x] Filter by page visibility rules.
- [x] Evaluate main conditions.
- [x] Evaluate subconditions.
- [x] Evaluate inventory/publication constraints.
- [x] Calculate candidate rewards.
- [x] Apply priority.
- [x] Apply stop-lower-priority.
- [x] Apply max applications per cart.
- [x] Apply max applications per customer.
- [x] Exclude gifts created by other offers from buyer-paid qualification unless explicitly allowed.
- [x] Resolve stacking/combinations.
- [x] Generate cart actions.
- [x] Generate discount function payload.
- [x] Generate widgets.
- [x] Log qualification events.

### 8.6 Rule engine TODO

- [x] Implement normalized cart parser for Ajax Cart API.
- [x] Implement normalized cart parser for Storefront API.
- [x] Implement normalized cart parser for Checkout UI extension cart.
- [x] Implement Money class with currency-aware comparison.
- [x] Implement product matching by product ID.
- [x] Implement product matching by variant ID.
- [x] Implement product matching by collection ID.
- [x] Implement product matching by tag.
- [x] Implement product matching by vendor.
- [x] Implement product matching by product type.
- [x] Implement product matching by subscription status.
- [x] Implement gift-line detection.
- [x] Implement bundle-line detection.
- [x] Implement customer tag matching.
- [x] Implement customer order-history matching.
- [x] Implement market matching.
- [x] Implement country/IP matching.
- [x] Implement URL parameter matching.
- [x] Implement all/any rule groups.
- [x] Implement min/max thresholds.
- [x] Implement exact quantity rules with paired min/max.
- [x] Implement multiplier calculations.
- [x] Implement pack calculations by product.
- [x] Implement pack calculations by variant.
- [x] Implement exclusion rules.
- [x] Implement priority resolver.
- [x] Implement stacking resolver.
- [x] Implement eligibility reason output for debugging.
- [x] Implement explain mode for admin preview.

---

## 9. Gift offers

### 9.1 Gift offer types

- [x] Spend X amount to get gift(s).
- [x] Free sample with purchase.
- [x] Buy one get one.
- [x] Buy X get Y.
- [x] Spend more get more.

### 9.2 Main conditions

#### Cart value condition

- [x] Min cart value.
- [x] Max cart value.
- [x] Store main currency value.
- [x] Market-specific custom currency threshold.
- [x] Auto-converted currency threshold fallback.
- [x] Include any products.
- [x] Include selected products only.
- [x] Include selected collections only.
- [x] Include selected product types only.
- [x] Include selected vendors only.
- [x] Exclude selected products.
- [x] Exclude selected collections.
- [x] Exclude selected product types.
- [x] Exclude selected vendors.
- [x] Exclude gift lines from other offers by default.
- [x] Optionally include paid gift values if configured.

#### Cart quantity condition

- [x] Min cart quantity.
- [x] Max cart quantity.
- [x] Include/exclude same product scopes as cart value.
- [x] Count variants correctly.
- [x] Count line quantities, not line count.
- [x] Exclude free gifts unless configured.

#### Specific product condition

- [x] Required product quantity.
- [x] Required variant quantity.
- [x] Multiply gifts by number of required product groups.
- [x] Gift same as purchased product.
- [x] Gift different from purchased product.
- [x] BOGO self-gift support.
- [x] BXGY support.

#### Cart value multiplier condition

- [x] Threshold amount.
- [x] Quantity multiplier: `floor(eligibleCartValue / threshold)`.
- [x] Max multiplier cap.
- [x] Multi-currency custom threshold.
- [x] Auto conversion fallback.

#### Pack of products condition

- [x] All selected products must be present.
- [x] Verify by product.
- [x] Verify by variant.
- [x] Multiply gifts by number of complete packs.
- [x] Pack count should be limited by scarcest required item quantity.
- [x] Partial pack does not qualify.

### 9.3 Subconditions

- [x] Specific link address with query param.
- [x] Existing URL with `?` must append `&`.
- [x] Order-history total spent.
- [x] Order-history last order spent.
- [x] Order-history total number of orders.
- [x] First-time customer condition using total orders 0.
- [x] Limit to one use per customer.
- [x] Customer tags include.
- [x] Customer tags exclude.
- [x] Treat non-login customer as no-tag customer option.
- [x] Customer country include.
- [x] Customer country exclude.
- [x] Shopify Markets include.
- [x] Shopify Markets exclude.
- [x] Subscription products only.
- [x] One-time purchase products only.
- [x] Both subscription and one-time default.
- [x] Sales channel online store.
- [x] Sales channel mobile app.
- [x] Sales channel POS.
- [x] Product quantity limits with AND.
- [x] Product quantity limits with OR.
- [x] Buy at least X from selected products.
- [x] Buy at most X from selected products.
- [x] Buy exactly X through min/max pair.
- [x] Exclude product through "at most 0".
- [x] Free gifts from other offers do not count toward product quantity limits.

### 9.4 Gift selection

- [x] Normal product as gift.
- [x] Variant as gift.
- [x] Multiple gifts.
- [x] Gift quantity per gift.
- [x] Automatically add all gifts.
- [x] Customer chooses N gifts.
- [x] Gift slider popup.
- [x] Gift slider embedded block.
- [x] Gift selection by offer.
- [x] Gift selection across all qualified gifts.
- [x] Gift price shown as original vs discounted.
- [x] Gift thumbnails.
- [x] Gift title.
- [x] Gift variant selector.
- [x] Gift unavailable state.
- [x] Gift out-of-stock state.
- [x] Gift market unavailable state.
- [x] Gift already selected state.

### 9.5 Gift line metadata

Use internal properties.

```ts
export type GiftLineProperties = {
  _promo_engine_line_type: "gift";
  _promo_engine_offer_id: string;
  _promo_engine_offer_version: string;
  _promo_engine_reward_id: string;
  _promo_engine_hash: string;
};
```

- [x] Never trust these properties alone.
- [x] Use them for identification and cleanup.
- [x] Use hash to detect tampering.
- [x] Hash should be generated server-side.
- [x] Storefront can attach hash but checkout/function must verify when possible.
- [x] Avoid showing private properties where possible.
- [x] Confirm how hidden/private line item properties behave in Shopify theme and checkout.

### 9.6 Gift logic modes

#### Function mode

- [x] Customer pays original line price in cart UI if Shopify limitation requires it.
- [x] Discount Function applies actual 100% or partial discount.
- [x] Product discount target should be exact cart line where possible.
- [x] Use cart line attributes/properties to identify gift candidates.
- [x] Reject discount if main purchase condition fails.
- [x] Reject discount if gift quantity exceeds allowed quantity.
- [x] Reject discount if gift product is not an allowed reward.
- [x] Reject discount if market/currency/channel invalid.
- [x] Reject discount if customer no longer matches targeting.

#### Clone product mode

- [x] Create cloned gift product or variant.
- [x] Set price to zero or discounted price as required.
- [x] Hide from search/collections/sitemaps/feeds.
- [x] Tag cloned products: `promo-engine-gift`.
- [x] Use handle suffix: `-promo-gift`.
- [x] Publish cloned products only to required channels.
- [x] Keep inventory synced with source gift if sync enabled.
- [x] Prevent direct purchase when not eligible.
- [x] Cleanup clones on app uninstall.
- [x] Archive clones when offer archived.
- [x] Support SEO noindex where possible.

#### Hybrid mode

- [x] Use function mode where possible.
- [x] Use clone mode for limitations not solvable with Functions.
- [x] Prefer function mode for security.
- [x] Prefer clone mode only when Shopify limitations require it.

### 9.7 Gift edge cases

- [x] Qualifying product removed after gift auto-added.
- [x] Qualifying quantity reduced after gift auto-added.
- [x] Cart value drops below threshold after discount code.
- [x] Cart value drops below threshold after buyer removes item.
- [x] Gift product goes out of stock between cart and checkout.
- [x] Gift product is unpublished from Online Store.
- [x] Gift product is unpublished from market.
- [x] Gift variant is deleted.
- [x] Gift variant is archived.
- [x] Gift product requires selling plan but cart line lacks selling plan.
- [x] Gift requires shipping but cart contains digital products only.
- [x] Buyer increases gift quantity manually.
- [x] Buyer duplicates gift line with different properties.
- [x] Buyer removes gift line after auto-add.
- [x] Buyer should not be forced to keep optional gift.
- [x] Buyer clears cart.
- [x] Buyer changes market/currency.
- [x] Buyer logs in after cart already has gifts.
- [x] Buyer logs out after cart already has gifts.
- [x] First-time-customer condition changes after login.
- [x] One-use-per-customer condition should check previous completed orders.
- [x] Multiple offers add same gift variant.
- [x] Same gift variant appears once with combined quantity or separate lines depending policy.
- [x] Same product is both purchased item and gift.
- [x] Gift should not count toward threshold unless configured.
- [x] Automatic Shopify discount creates separate same-variant line.
- [x] Cart line key changes after update.
- [x] Cart drawer fails to rerender after mutation.
- [x] Checkout opened before auto-add promise resolves.
- [x] Inventory race during flash sale.
- [x] Gift sale price changes after offer creation.
- [x] Gift compare-at price missing.
- [x] Multi-currency fixed discount exceeds item price.
- [x] Discount amount should cap at item price.
- [x] Shipping discount exceeds shipping cost.
- [x] Free shipping with no shipping-required items.
- [x] POS channel cannot render web widget.
- [x] POS must still apply promotion where configured.

---

## 10. Bundle offers

### 10.1 Bundle types

- [x] Classic bundle.
- [x] Mix and match.
- [x] Bundle page / build-a-box.
- [x] Fixed bundle.
- [x] Multipack.
- [x] Variant bundle.
- [x] Sample pack.
- [x] Subscription box.
- [x] Upsell bundle.
- [x] Cross-sell bundle.
- [x] Frequently bought together bundle.
- [x] Related products bundle.
- [x] Digital product bundle.
- [x] Physical product bundle.
- [x] Custom bundle.

### 10.2 Classic bundle

- [x] Internal bundle name.
- [x] Customer-facing title.
- [x] Optional description.
- [x] Start/end schedule.
- [x] Subconditions.
- [x] Product discount percentage.
- [x] Product discount amount.
- [x] Fixed price for all bundle products.
- [x] Free gift.
- [x] Shipping discount percentage.
- [x] Shipping discount amount.
- [x] Multi-currency fixed amount/fixed price.
- [x] Selected bundle products.
- [x] Widget appears on selected product pages by default.
- [x] Combination with order discounts.
- [x] Combination with shipping discounts.
- [x] Custom discount code.
- [x] Optional create product for this bundle.
- [x] Analytics attribution for bundle product if bundle product is created.

### 10.3 Mix and match

- [x] Customer can choose products from predefined collection/product list.
- [x] Min selection quantity.
- [x] Max selection quantity.
- [x] Tiered quantity discount.
- [x] Product filters.
- [x] Variant selection.
- [x] Add selected bundle to cart.
- [x] Calculate discount based on selected items.
- [x] Handle out-of-stock variants.
- [x] Handle selected item removed before add-to-cart.

### 10.4 Bundle page / build-a-box

- [x] Internal bundle name.
- [x] Page heading.
- [x] Page subheading.
- [x] Start/end time.
- [x] One step per page layout.
- [x] Multiple steps in one page layout.
- [x] Banner image.
- [x] Banner upload validation:
  - [x] JPG.
  - [x] PNG.
  - [x] GIF.
  - [x] Size under configured limit.
  - [x] Recommended dimensions.
- [x] Subconditions.
- [x] Step title.
- [x] Step subtitle.
- [x] Step selected products.
- [x] Step selected collections.
- [x] Search bar.
- [x] Sort by name.
- [x] Sort by date.
- [x] Sort by price.
- [x] Sort by best-selling.
- [x] Filter by category.
- [x] Filter by collection.
- [x] Filter by product tag.
- [x] Filter by product type.
- [x] Filter by price range.
- [x] Minimum quantity per step.
- [x] Maximum quantity per step.
- [x] Add step.
- [x] Remove step.
- [x] Dynamic bundle summary panel.
- [x] Discount tier label.
- [x] Discount tier min quantity.
- [x] Tier min quantity must not decrease across tiers.
- [x] Percentage discount.
- [x] Amount discount.
- [x] Fixed price.
- [x] Free gift.
- [x] Shipping discount.
- [x] Custom discount code.
- [x] Combination with order discounts.
- [x] Combination with shipping discounts.

### 10.5 Bundle implementation strategy

Option A: cart lines as individual components.

- [x] Add each selected component as separate cart line.
- [x] Add bundle ID properties to each line.
- [x] Discount Function applies discounts to matching component lines.
- [x] Better inventory accuracy.
- [x] Less clean bundle presentation in cart unless Cart Transform updates presentation.

Option B: bundle parent product + Cart Transform expand.

- [x] Create parent bundle product.
- [x] Store selected components in line attributes.
- [x] Cart Transform expands parent into components.
- [x] Cleaner product-like bundle UX.
- [x] More complex inventory and attributes.
- [x] Only one cart transform function per app per store.

Recommended:

- [x] Use individual component lines for MVP.
- [x] Add Cart Transform only where presentation/productized bundle is required.
- [x] Keep bundle attribution via line properties.
- [x] Make cart cleanup idempotent.

### 10.6 Bundle max quantity edge case

BOGOS-like behavior notes that if customer manually exceeds max quantity in cart, extra quantity can be charged at original price, and when ambiguous, highest-price product can be selected for original-price reversion.

Implement:

- [x] When quantity exceeds bundle max, split extra quantity into non-discounted line if Shopify permits.
- [x] If line splitting is not possible, Discount Function discounts only allowed quantity and leaves remainder undiscounted.
- [x] If ambiguous across products, apply discount to cheapest eligible units first to protect margin.
- [x] Add admin setting: "BOGOS-compatible highest-price reversion" if exact mimic is desired.
- [x] Test exceeding max quantities manually from cart drawer, cart page, checkout UI, and headless cart.

### 10.7 Bundle edge cases

- [x] Component product deleted.
- [x] Component variant deleted.
- [x] Component unpublished in market.
- [x] Component out of stock.
- [x] Component requires selling plan.
- [x] Components have mixed selling plans.
- [x] Digital + physical components.
- [x] Multi-location inventory.
- [x] Bundle crosses markets.
- [x] Bundle fixed amount currency missing.
- [x] Bundle tier conflict.
- [x] Bundle product and component product both in cart.
- [x] Same product selected in multiple steps.
- [x] Same variant selected multiple times.
- [x] Buyer changes quantity in cart.
- [x] Buyer removes one component from bundle.
- [x] Bundle should become invalid and discounts removed.
- [x] Bundle page loaded with stale offer ID.
- [x] Bundle active schedule expires while page is open.
- [x] Customer changes country/market during session.
- [x] Best-selling sort unavailable for arbitrary product list.
- [x] Price range filter with multi-currency.
- [x] Collection membership cache stale.
- [x] Bundle search with very large product list.
- [x] Performance of 500+ products in bundle builder.
- [x] Mobile UX with many steps.
- [x] Accessibility keyboard navigation.

---

## 11. Upsell offers

### 11.1 Upsell types

- [x] Checkout upsell.
- [x] Frequently bought together.
- [x] Thank-you page upsell.

### 11.2 Checkout upsell

**Shopify Plus confirmed ✅ — all checkout UI extension surfaces available including information, shipping, payment, and thank-you steps.**

Available extension targets (Shopify Plus):
- `Checkout::Dynamic::Render` — inject anywhere in checkout flow.
- `Checkout::CartLineItem::RenderAfter` — after each cart line (FBT-style upsell per line).
- `Checkout::OrderSummary::RenderAfter` — after order summary.
- `Checkout::ShippingMethods::RenderAfter` — after shipping method selection.
- `Checkout::PaymentMethods::RenderBefore` — before payment entry.
- `Checkout::ThankYou::RenderAfter` — thank-you page post-purchase upsell.
- `Checkout::Actions::RenderBefore` — just above the "Pay now" button (high conversion).

Implementation checklist:
- [x] Select target based on offer configuration (merchant chooses position in admin).
- [x] Trigger by cart content (contains specific product/collection/type/vendor).
- [x] Trigger by selected products present in cart.
- [x] Trigger by excluding selected products.
- [x] Trigger by collection, product type, vendor.
- [x] Trigger by order total threshold.
- [x] Manual product selection (merchant picks the upsell product).
- [x] Auto recommendation (use complementary product API or pre-configured set).
- [x] Random product from selected set.
- [x] Percentage discount on upsell.
- [x] Fixed amount discount on upsell.
- [x] Cheapest item free (Discount Function applies at cart calculation).
- [x] Combination policy (can combine with other discounts yes/no).
- [x] Add to cart from checkout UI extension (`applyCartLinesChange`).
- [x] Dismiss/hide upsell — store dismissal in session (do not re-show same session).
- [x] Track: view, dismiss, click, add, conversion (via Web Pixel + analytics endpoint).
- [x] Fetch upsell config from app backend via extension network access (cache in extension).
- [x] Handle network failure gracefully — show nothing rather than error state.
- [x] Handle cart mutation failure gracefully — inform buyer, do not block checkout.
- [x] Show upsell product image, title, price, discounted price.
- [x] Show "Added!" confirmation state after add.
- [x] Respect buyer's market — only show products available in buyer's market.
- [x] Avoid showing products already in cart (unless configured to allow).
- [x] Avoid showing gift clone products.
- [x] Per-market price display using buyer's currency.

**Guards and edge cases:**
- [x] Upsell product goes out of stock between checkout render and add — handle gracefully.
- [x] Upsell product removed from publication after extension renders.
- [x] Network access to backend times out — extension must render within Shopify's time limits.
- [x] Buyer changes address (market/country change) after upsell rendered — prices may need refresh.
- [x] Upsell discount no longer valid by time buyer clicks Add — refetch and show updated price.
- [x] Multiple upsell offers qualify — show only highest priority or most relevant.
- [x] Upsell product has variants — show variant selector before add (or default to first available).
- [x] Cart already contains upsell product at full quantity — should not re-add.

### 11.3 Frequently bought together

- [x] Product-page block.
- [x] Amazon-style layout.
- [x] Stacked layout.
- [x] Max products displayed.
- [x] See more behavior.
- [x] Total price text.
- [x] Add bundle to cart button text.
- [x] Show each item`s price.
- [x] Show discount amount on add-to-cart button.
- [x] Background color customization.
- [x] Text color customization.
- [x] Price color customization.
- [x] Button color customization.
- [x] Widget positioning through theme editor.
- [x] Add to pages beyond product page where possible.
- [x] Product variant selectors.
- [x] Unavailable item handling.
- [x] Remove item checkbox support.

### 11.4 Thank-you page upsell

- [x] Post-purchase/thank-you surface availability check.
- [x] Show complementary products after purchase.
- [x] Discount support.
- [x] Add to new cart or post-purchase flow depending Shopify capability.
- [x] Avoid offering purchased product unless allowed.
- [x] Attribution to original order.
- [x] Track view/click/conversion.

### 11.5 Upsell edge cases

- [x] Upsell item already in cart.
- [x] Upsell item unavailable.
- [x] Upsell item in excluded collection.
- [x] Random mode selects out-of-stock item.
- [x] Auto recommendation returns empty.
- [x] Search & Discovery data unavailable.
- [x] Checkout extension cannot fetch backend due CORS/network access.
- [x] Checkout extension cannot add cart line on a store/surface.
- [x] Buyer changes cart after upsell rendered.
- [x] Discount no longer valid after cart mutation.
- [x] Upsell product requires selling plan.
- [x] Upsell product is a gift clone and should be hidden.
- [x] Multi-currency fixed discount too high.
- [x] Thank-you upsell not available on all plan/surfaces.

---

## 12. Discount offers

### 12.1 Discount types

- [x] Volume discount.
- [x] Cart discount.
- [x] Discount on cheapest item.
- [x] Discount on most expensive item.
- [x] Quantity breaks.
- [x] Tiered discounts.
- [x] Flat discount.
- [x] Percentage discount.
- [x] Fixed price.
- [x] Bulk pricing.
- [x] Dynamic pricing.

### 12.2 Volume discount

- [x] Product page widget.
- [x] Quantity tiers.
- [x] Tier label.
- [x] Tier min quantity.
- [x] Percentage discount.
- [x] Fixed amount discount.
- [x] Fixed price.
- [x] Multi-currency values.
- [x] Variant-specific support.
- [x] Collection/type/vendor support.
- [x] Add selected quantity to cart.
- [x] Discount Function applies at checkout.
- [x] Widget updates on variant change.

### 12.3 Cart discount

- [x] Threshold by cart value.
- [x] Threshold by cart quantity.
- [x] Product scope include/exclude.
- [x] Order-level percentage discount.
- [x] Order-level fixed amount discount.
- [x] Max discount cap.
- [x] Multi-currency fixed values.
- [x] Combination policies.
- [x] Discount code optional.
- [x] Automatic discount optional.

### 12.4 Cheapest/most expensive item discount

- [x] Select eligible line set.
- [x] Determine cheapest eligible item.
- [x] Determine most expensive eligible item.
- [x] Discount percentage.
- [x] Discount fixed amount.
- [x] Free cheapest item.
- [x] Tie breaker deterministic by line ID.
- [x] Exclude gifts and bundle-generated lines by default.
- [x] Respect quantity units, not only lines.

### 12.5 Discount edge cases

- [x] Automatic Shopify discount also applies.
- [x] Manual code entered by buyer.
- [x] Multiple app offers qualify.
- [x] Discount class not enabled.
- [x] Discount target line has quantity > 1.
- [x] Partial quantity should be discounted.
- [x] Fixed discount exceeds subtotal.
- [x] Currency rounding.
- [x] Tax-inclusive markets.
- [x] Subscription recurring line.
- [x] Gift cards excluded.
- [x] Product has compare-at price but no price.
- [x] Checkout recalculation differs from cart preview.
- [x] Buyer enters code not combinable with app discount.
- [x] Native discount code rejected.
- [x] App discount code expired.
- [x] Function config stale.

---

## 13. Boosters and widgets

### 13.1 Today Offer widget

- [x] Only one floating widget active by default.
- [x] Display active offers only.
- [x] Auto-remove deactivated offers.
- [x] Internal booster name.
- [x] Customer-facing title.
- [x] Optional subtitle.
- [x] Thumbnail card layout.
- [x] Product preview card layout.
- [x] Automatically select active gifts/bundles/discounts.
- [x] Manually select offers.
- [x] Edit title per offer.
- [x] Edit description per offer.
- [x] Redirect link per offer.
- [x] Button text per offer.
- [x] One product image thumbnail.
- [x] Product image group thumbnail up to 4.
- [x] Custom image/icon.
- [x] Image size validation.
- [x] Product list label.
- [x] Show offer description.
- [x] Show product list label.
- [x] Floating icon only style.
- [x] Floating icon + title style.
- [x] Bottom right position.
- [x] Bottom left position.
- [x] Icon size.
- [x] Icon padding.
- [x] Show on all pages.
- [x] Show on home.
- [x] Show on cart.
- [x] Show on product pages.
- [x] Show on collection pages.
- [x] Show on custom URL equal.
- [x] Show on custom URL not equal.
- [x] Show on custom URL contains.
- [x] Hide on custom URL contains.
- [x] Widget color customization.
- [x] Offer card color customization.
- [x] Button color customization.
- [x] Notification dot color customization.

### 13.2 Today Offer block

- [x] Inline app block version.
- [x] Select specific booster/offer set.
- [x] Render in theme editor.
- [x] Render in headless mount.

### 13.3 Progress bar

- [x] Progress based on cart value.
- [x] Progress based on cart quantity.
- [x] Progress based on specific product quantity.
- [x] Multi-tier goals.
- [x] Message before threshold.
- [x] Message after threshold.
- [x] Remaining amount.
- [x] Remaining quantity.
- [x] Currency formatting.
- [x] Cart drawer placement.
- [x] Cart page placement.
- [x] Custom placement.
- [x] Rerender on cart update.
- [x] Track progress viewed.
- [x] Track goal reached.

### 13.4 Cart message

- [x] Show active cart message.
- [x] Show qualification message.
- [x] Show remaining amount/quantity.
- [x] Show success message.
- [x] Support multiple messages.
- [x] Priority sort messages.
- [x] Theme/app block placement.
- [x] Custom selector placement.
- [x] HTML-safe rendering.
- [x] Translation support.

### 13.5 Gift icon and gift thumbnail

- [x] Product page gift icon.
- [x] Collection page gift icon.
- [x] Product page gift thumbnail.
- [x] Gift thumbnail title.
- [x] Number of gifts text.
- [x] Multiple gifts display.
- [x] Countdown timer.
- [x] Countdown text color.
- [x] Border color.
- [x] Offer name color.
- [x] Hide on gift products.
- [x] Variant change rerender.

### 13.6 Widget runtime TODO

- [x] Build global runtime initialization.
- [x] Build event bus.
- [x] Build cart adapter.
- [x] Build page detector.
- [x] Build offer cache.
- [x] Build widget renderer registry.
- [x] Build mutation queue.
- [x] Build stale response cancellation.
- [x] Build debounce.
- [x] Build retry with exponential backoff.
- [x] Build local session ID.
- [x] Build analytics enqueue with `sendBeacon` fallback.
- [x] Build CSS isolation strategy.
- [x] Build no-conflict mode.
- [x] Build debug mode.

---

## 14. Storefront event system

Use internal events. Do not copy BOGOS event names in production unless using a temporary migration compatibility mode.

### 14.1 Proposed events

```ts
export const PromoEvents = {
  CartChanged: "promo-engine:cart-changed",
  EvaluationRequested: "promo-engine:evaluation-requested",
  EvaluationCompleted: "promo-engine:evaluation-completed",
  GiftAutoAdded: "promo-engine:gift-auto-added",
  GiftAdded: "promo-engine:gift-added",
  GiftUpdated: "promo-engine:gift-updated",
  GiftRemoved: "promo-engine:gift-removed",
  GiftSliderRequested: "promo-engine:gift-slider-requested",
  ProductChanged: "promo-engine:product-changed",
  CartMessageRender: "promo-engine:cart-message-render",
  BundleInit: "promo-engine:bundle-init",
  BundlePageInit: "promo-engine:bundle-page-init",
  UpsellInit: "promo-engine:upsell-init",
  DiscountInit: "promo-engine:discount-init",
  ProgressRerender: "promo-engine:progress-rerender",
  TodayOfferRender: "promo-engine:today-offer-render",
  CheckoutPrepare: "promo-engine:checkout-prepare",
} as const;
```

### 14.2 Compatibility adapter

- [x] Optional development-only listener for old BOGOS-like events.
- [x] Map old events to internal events during migration testing.
- [x] Remove or disable before production.
- [x] Never depend permanently on BOGOS event naming.

---

## 15. Storefront cart mutation strategy

### 15.1 Ajax Cart API mode

- [x] Fetch cart with `/cart.js`.
- [x] Add gifts with `/cart/add.js`.
- [x] Change existing lines with `/cart/change.js`.
- [x] Remove lines by setting quantity to 0.
- [x] Update discount string with `/cart/update.js`.
- [x] Use locale-aware URLs.
- [x] Use line item key rather than variant ID when changing specific lines.
- [x] Handle duplicate variant lines with different properties.
- [x] Handle line item key changes after cart mutations.
- [x] Fetch cart after every mutation batch.
- [x] Use a single mutation queue to avoid race conditions.
- [x] Cancel stale evaluations.

### 15.2 Storefront API mode

- [x] Create cart and preserve full cart ID with key.
- [x] Add lines with `cartLinesAdd`.
- [x] Update lines with `cartLinesUpdate`.
- [x] Remove lines with `cartLinesRemove`.
- [x] Apply discounts with `cartDiscountCodesUpdate`.
- [x] Pass line attributes on every update to avoid accidental loss.
- [x] Store cart ID in safe session storage/local storage.
- [x] Recover from missing/expired cart ID by creating a new cart and migrating lines where possible.
- [x] Use buyer identity for market/currency pricing.

### 15.3 Checkout preparation

- [x] Before redirecting to checkout, call `prepareCheckout`.
- [x] `prepareCheckout` fetches latest cart.
- [x] Re-evaluate offers.
- [x] Add missing auto gifts.
- [x] Correct gift quantities.
- [x] Remove invalid gifts.
- [x] Apply required discount codes.
- [x] Remove stale app discount codes if no longer valid.
- [x] Re-fetch cart.
- [x] Redirect only after cart state is stable.
- [x] Timeout gracefully with clear UX if cart cannot be prepared.

### 15.4 Cart drawer integration

- [x] Detect common cart drawer events.
- [x] Support custom rerender callback.
- [x] Support section rendering when available.
- [x] Provide manual integration API:
  - [x] `window.PromoEngine.refreshCart()`
  - [x] `window.PromoEngine.evaluate()`
  - [x] `window.PromoEngine.prepareCheckout()`
  - [x] `window.PromoEngine.on(event, callback)`
- [x] Rerender widgets after drawer opens.
- [x] Avoid duplicate widget mounts.
- [x] Avoid repeated auto-add loops.

---

## 16. Shopify Functions implementation

### 16.1 Discount Function

**Language: Rust** (see Section 3.5 for constraints and toolchain).

Required API targets:

- [x] `cart.lines.discounts.generate.run` — product/line discounts.
- [x] `cart.delivery-options.discounts.generate.run` — shipping discounts.

**2026 API capabilities (Admin API 2026-04):**

- [x] **Multiple product discounts per cart line** — as of April 30, 2026, one function call can apply multiple product discounts to a single cart line. Use the `combinesWith` field to configure stacking.
- [x] **Discount tags** — add searchable tags to discount definitions for campaign/affiliate attribution and filtering in the admin.
- [x] **Market-specific eligibility** — natively configure which Shopify Markets a discount applies to via Admin API (no longer requires manual condition checks).
- [x] **Buy-X-Get-Y prerequisites** — supported natively in product discount functions.

Responsibilities:

- [x] Apply product discounts to gift lines (100% or partial).
- [x] Apply product discounts to bundle component lines.
- [x] Apply order-level (cart subtotal) discounts.
- [x] Apply shipping discounts to delivery options.
- [x] Accept app-generated discount codes.
- [x] Reject discount codes no longer matching valid offers.
- [x] Enforce combination policy (combines_with_order_discounts, combines_with_shipping_discounts).
- [x] Enforce maximum gift quantity — charge full price for excess gift units.
- [x] Enforce cheapest/most expensive item selection (deterministic tie-break by line ID).
- [x] Enforce volume discount tiers (apply to matching quantity range only).
- [x] Exclude invalid gift lines (wrong offer ID, tampered hash, wrong market, wrong channel).
- [x] Provide human-readable discount messages (shown in checkout).
- [x] **Guard: cap fixed discount at item price** — never discount below $0.
- [x] **Guard: cap shipping discount at shipping cost** — never negative shipping.
- [x] **Guard: currency rounding** — use Shopify's currency decimal rules (some currencies zero-decimal).

Function input query must include:

- [x] `cart.lines[]` — ID, quantity, cost.amountPerQuantity, merchandise.id (variant), merchandise.product.id, merchandise.product.tags, merchandise.product.vendor, merchandise.product.productType.
- [x] `cart.lines[].attributes[]` — all line properties (gift markers, bundle markers, hash).
- [x] `cart.cost.subtotalAmount` — for order-level threshold checks.
- [x] `cart.buyerIdentity.customer.tags` — for customer tag conditions (if available in function scope).
- [x] `cart.buyerIdentity.countryCode` — for market/country conditions.
- [x] `cart.discountCodes[]` — entered codes to accept/reject.
- [x] Discount metafield config — compiled offer configs pushed by backend on offer publish (max 10 KB per metafield; shard if needed).

Function output:

- [x] `discounts[]` — each with `targets`, `value` (percentage or fixed_amount), `message`.
- [x] Deterministic: same input → same output always.
- [x] No side effects, no external calls.
- [x] No randomness, no timestamps.

Performance constraints (see Section 3.5 for full table):

- [x] Precompile all offer conditions into lookup maps (HashSet/HashMap in Rust) before eval loop.
- [x] Use `u64` cents for all money — no `f64`.
- [x] Function config in metafield must be compact — precompute product/variant/collection sets.
- [x] Benchmark: 100 cart lines × 100 active offers must stay within 11M instruction budget.
- [x] Never use function network access — config via metafields only.
- [x] Input query cost must stay ≤ 30 points.

Edge cases the function must handle:

- [x] Gift line present but qualifying item removed (discount should be 0, charged full price).
- [x] Gift quantity in cart exceeds allowed — apply discount only to allowed units.
- [x] Same variant in multiple lines with different properties — identify by line ID not variant ID.
- [x] Cart value drops below threshold due to other discounts applied before this function — must recheck.
- [x] Fixed discount in currency not matching cart currency — skip or convert with stored exchange rate.
- [x] Bundle component removed from cart (partial bundle) — remove all bundle discounts.
- [x] Volume tier boundary: quantity exactly at tier min must qualify.
- [x] Zero-decimal currency discount — round down to avoid exceeding item price.
- [x] Discount code entered by buyer conflicts with app code — follow combination policy.
- [x] Multiple offers qualify for same line — apply in priority order, respect stop-lower-priority.
- [x] Gift card lines must be excluded from discountable lines.
- [x] Subscription recurring lines — only discount initial purchase unless configured otherwise.

### 16.2 Cart Transform Function

**Language: Rust.** **Plus confirmed: `lineUpdate` available.**

Use for:

- [x] Bundle line expansion (`lineExpand`) — expand bundle parent line into individual component lines.
- [x] Bundle line merge (`linesMerge`) — merge component lines into a single parent bundle presentation.
- [x] Bundle title/image/price customization (`lineUpdate`) — **available on Plus ✅**.
- [x] Price presentation changes that Discount Function cannot express (e.g., showing bundle price as single unit).

**Important constraints:**

- [x] **One Cart Transform function per app per store** — plan carefully what goes here.
- [x] Multiple apps (e.g., subscription apps) may run their own Cart Transform — test for conflicts.
- [x] `lineUpdate` requires Shopify Plus (confirmed for this project).
- [x] `lineExpand` and `linesMerge` available on all plans.
- [x] Cart Transform runs concurrently with Discount Function — do not duplicate discount logic here.
- [x] Selling plans on a line cause `lineExpand`/`linesMerge`/`lineUpdate` to be rejected — document this limitation and test subscription+bundle edge case.

**Implementation checklist:**

- [x] Define bundle parent product in catalog (or use virtual line with attributes).
- [x] On `lineExpand`: read component variant IDs from line attributes, expand to component lines with correct quantities.
- [x] On `lineUpdate`: set bundle presentation title, image, and price summary.
- [x] Preserve all line attributes during expand — never lose `_promo_engine_*` properties.
- [x] Return `noChanges` when no bundle lines detected — avoid unnecessary transform overhead.
- [x] Test with: other bundle apps, subscription apps, gift card lines, empty cart.

**Edge cases:**

- [x] Bundle parent line has quantity > 1 — expand each unit separately.
- [x] Component variant deleted after bundle created — return error state, show user-facing message.
- [x] Component out of stock after bundle created — transform still runs but Validation Function should block.
- [x] Two bundle offers for same products — priority determines which transform applies.
- [x] Buyer changes component quantity in cart after bundle added — detect mismatch and flag for cleanup.

### 16.3 Cart and Checkout Validation Function

**Language: Rust. Execution budget: 5ms hard limit.**

Validation functions run at checkout across **all express checkout surfaces** (Shop Pay, PayPal, Google Pay, Apple Pay). This is the last line of defense for discount abuse.

- [x] Validation Functions run **after** Discount Functions — can see applied discounts.
- [x] Max 25 validation functions per store (all run concurrently).
- [x] Must return in **5ms** — this is a hard limit, not a guideline. JavaScript cannot reliably meet this under load. Rust only.

Use for:

- [x] Block checkout when buyer manually increased gift quantity beyond allowed (charge full price or block).
- [x] Block checkout when required bundle components are incomplete/missing.
- [x] Block direct purchase of clone gift products outside eligibility (price $0 or near-zero bypass attempt).
- [x] Block checkout when gift line properties have been tampered (hash mismatch).
- [x] Block checkout when gift offer expired between cart creation and checkout.
- [x] Block checkout when customer no longer meets targeting (logged out, tag removed).
- [x] Block checkout when gift product is not published in buyer's market.
- [x] Block checkout when cart violates one-use-per-customer limit (check cached order history).

**Guard patterns:**

- [x] Read `_promo_engine_hash` from line attributes — verify against HMAC-derived expected hash.
- [x] Read `_promo_engine_offer_id` — verify offer is still active and not expired.
- [x] Compare gift line quantity against compiled max quantity from metafield config.
- [x] Check product GID against allowed gift product set (precompiled HashSet in config).
- [x] If block: provide clear merchant-readable error message ("Your cart has been updated. Please review.").
- [x] If block would cause poor UX (flash sale), consider switching to: "remove the discount and charge full price" via Discount Function fallback instead of hard block.

**Fallback when block not possible:**

- [x] Discount Function must be the fallback authority — if Validation cannot block, Discount Function must strip the discount and charge full price.
- [x] Document which abuse scenarios are blocked at validation vs. silently corrected at discount level.

**Edge cases:**

- [x] Buyer opens two tabs, qualifies for one gift, checks out from both tabs simultaneously.
- [x] Flash sale: inventory depleted between evaluation and validation.
- [x] Buyer's customer tag removed between cart creation and checkout (e.g., VIP tag expired).
- [x] Offer ends at midnight — buyer loaded cart at 11:59 PM and submits at 12:01 AM.
- [x] Metafield config stale — compiled config in function doesn't match current offer state.
- [x] Clone gift product added to cart directly via storefront (not through app).
- [x] Bundle components in cart but bundle parent line removed manually.
- [x] Gift line with no `_promo_engine_*` properties (manually crafted line by bad actor).
- [x] Market mismatch — buyer changed country between cart and checkout via address form.

Fallback:

- [x] If validation cannot block due to Shopify limitation, Discount Function must remove discounts and charge full price.

---

## 17. Shopify Admin dashboard

Build a Shopify-like embedded dashboard using Polaris.

### 17.1 Navigation

- [x] Dashboard.
- [x] All Offers.
- [x] Gift Offers.
- [x] Bundle Offers.
- [x] Upsell Offers.
- [x] Discount Offers.
- [x] Boosters.
- [x] Customize.
- [x] Analytics.
- [x] Settings.
- [x] Translation.
- [x] Installation / Theme Blocks.
- [x] Debug / Diagnostics.
- [x] Migration from BOGOS.

### 17.2 Dashboard

- [x] Active offers count.
- [x] Scheduled offers count.
- [x] Revenue attributed.
- [x] Orders attributed.
- [x] Conversion rate.
- [x] Gift auto-add success rate.
- [x] Cart mutation error rate.
- [x] Top offers by revenue.
- [x] Top widgets by CTR.
- [x] Current sync status.
- [x] Warnings:
  - [x] Gift out of stock.
  - [x] Gift unpublished.
  - [x] Missing market publication.
  - [x] Function config stale.
  - [x] Theme app embed disabled.
  - [x] Checkout extension not enabled.
  - [x] Shopify scope missing.

### 17.3 Offer list

- [x] Search offers by name.
- [x] Filter by type (gift, bundle, upsell, discount, booster).
- [x] Filter by status (draft, active, paused, scheduled, expired, archived).
- [x] Filter by schedule (upcoming, running now, ended).
- [x] Filter by discount tag.
- [x] Sort by priority (drag-to-reorder).
- [x] Sort by updated date.
- [x] Sort by revenue attributed.
- [x] Duplicate offer (copy all settings, status → draft).
- [x] Pause offer (instant — no page reload; optimistic UI).
- [x] Archive offer (soft-delete, retains analytics).
- [x] Preview offer (simulate in storefront context — see Section 17.5).
- [x] View analytics per offer (drill-down).
- [x] **Bulk actions:**
  - [x] Bulk pause selected.
  - [x] Bulk activate selected.
  - [x] Bulk archive selected.
  - [x] Bulk assign discount tag.
  - [x] Bulk change priority.
- [x] **Conflict warnings** — indicator if two offers will stack or conflict (auto-detected).
- [x] **CSV export** — all offers with all settings, gift product SKU/handle, condition values.
- [x] **CSV import** — parse CSV, validate against schema, show diff preview, require confirm.
  - [x] Map by SKU or handle (not internal IDs) for portability.
  - [x] Validate all referenced products/variants exist in catalog.
  - [x] Create offers in draft status after import.
  - [x] Report import errors per row without blocking successful rows.
- [x] **A/B test badge** — show A/B test indicator on offers with active variants.

### 17.4 Offer builder

Use a multi-step wizard with step validation before advancing:

- [x] Step 1: Offer information (name, type, priority, schedule, tags).
- [x] Step 2: Main condition (cart value, cart quantity, specific product, multiplier, pack).
- [x] Step 3: Subconditions (customer targeting, market, channel, URL).
- [x] Step 4: Rewards (products, discount type, auto-add vs. selection, quantity).
- [x] Step 5: Widget / display settings (widget type, position, theme, copy).
- [x] Step 6: Advanced config (stacking policy, combination rules, max applications, debug).
- [x] Step 7: Review summary (show compiled config preview, estimated function config size).
- [x] Step 8: Publish (or save as draft).

**Wizard guards:**
- [x] Cannot advance from Step 2 without at least one condition configured.
- [x] Cannot advance from Step 4 without at least one reward configured.
- [x] Cannot publish if function config estimated size exceeds 10 KB metafield limit.
- [x] Show live validation errors on blur (not just on submit).
- [x] Auto-save draft on each step advance — no lost work on browser close.

**Field-level validation:**
- [x] Public title: required, max 100 chars.
- [x] Internal name: required, unique per shop, max 100 chars.
- [x] Start before end (if both set).
- [x] Gift product cannot be same as explicitly excluded product unless explicit override.
- [x] Fixed discount amount must include currency code.
- [x] Market-specific currency values must match enabled markets.
- [x] Discount code: max 255 chars, no spaces, unique within shop.
- [x] Priority: integer 1–9999.
- [x] Stop-lower-priority: show conflict preview (which active offers would be blocked).
- [x] Bundle tiers: each tier min_quantity must be strictly greater than previous.
- [x] Bundle max quantity must be ≥ min quantity.
- [x] Product selections cannot be empty if condition requires products.
- [x] Gift product must be published to Online Store channel.
- [x] Gift product must have inventory ≥ 1 or inventory_policy = `CONTINUE`.
- [x] Subscription-only offer: all required products must have at least one selling plan.
- [x] Cart value threshold: must be positive number.
- [x] Multi-currency thresholds: each configured currency must be an enabled market currency.
- [x] Upsell product must not be a gift clone product (tag: `promo-engine-gift`).

### 17.6 A/B testing interface

- [x] Create A/B test variant from any active offer.
- [x] Set traffic split percentage (e.g., 50/50, 70/30).
- [x] Variant assignment based on deterministic session ID hash (not random per request).
- [x] Independent analytics stream per variant.
- [x] Statistical significance calculator in analytics dashboard.
- [x] Declare winner (promote variant to canonical, archive the other).
- [x] Auto-stop losing variant after configured confidence threshold met.
- [x] Support A/B testing dimensions: widget position, message copy, discount value, gift product, threshold value.
- [x] Prevent nested A/B tests (A/B variant cannot itself be A/B tested).
- [x] Show winner/loser label in offer list once significance reached.

### 17.5 Preview/debug

- [x] Simulate cart.
- [x] Simulate customer.
- [x] Simulate country.
- [x] Simulate market.
- [x] Simulate currency.
- [x] Simulate sales channel.
- [x] Show qualified offers.
- [x] Show disqualified offers.
- [x] Show exact reasons.
- [x] Show generated cart actions.
- [x] Show discount function config.
- [x] Show widget payload.
- [x] Show possible conflicts.
- [x] Copy debug payload.

### 17.6 Migration from BOGOS

- [x] Inventory current BOGOS offers manually or through export if available.
- [x] Map each offer to internal schema.
- [x] Create migration checklist per offer.
- [x] Run in shadow mode.
- [x] Compare evaluations against production BOGOS.
- [x] Disable BOGOS for a test theme.
- [x] Enable internal app on test theme.
- [x] QA all major flows.
- [x] Gradual cutover.
- [x] Remove BOGOS scripts/classes after cutover.
- [x] Keep rollback plan.

---

## 18. API design

### 18.1 Backend internal API

- [x] `GET /api/offers`
- [x] `POST /api/offers`
- [x] `GET /api/offers/:id`
- [x] `PATCH /api/offers/:id`
- [x] `POST /api/offers/:id/duplicate`
- [x] `POST /api/offers/:id/publish`
- [x] `POST /api/offers/:id/pause`
- [x] `POST /api/offers/:id/archive`
- [x] `POST /api/offers/:id/preview`
- [x] `POST /api/evaluate`
- [x] `POST /api/cart/prepare-checkout`
- [x] `POST /api/analytics/events`
- [x] `GET /api/widgets/runtime-config`
- [x] `GET /api/products/search`
- [x] `GET /api/collections/search`
- [x] `POST /api/sync/products`
- [x] `POST /api/sync/markets`
- [x] `POST /api/sync/inventory`
- [x] `GET /api/diagnostics`

### 18.2 Storefront/headless public API

- [x] `GET /apps/promo-engine/runtime`
- [x] `POST /apps/promo-engine/evaluate`
- [x] `POST /apps/promo-engine/prepare-checkout`
- [x] `GET /apps/promo-engine/product-customizations`
- [x] `POST /apps/promo-engine/analytics`

Security:

- [x] Validate shop domain.
- [x] Validate HMAC where available.
- [x] Use public runtime key.
- [x] Rate limit by shop/IP/session.
- [x] No Admin API data leakage.
- [x] No customer PII in public responses.
- [x] CORS allowlist for headless.
- [x] Use cache headers carefully.
- [x] Separate public read endpoints from admin write endpoints.

### 18.3 Evaluation response

```ts
export type StorefrontEvaluationResponse = {
  requestId: string;
  cartHash: string;
  giftsChange: {
    add: CartLineAddAction[];
    update: CartLineUpdateAction[];
    remove: CartLineRemoveAction[];
  };
  discountCodes: {
    add: string[];
    remove: string[];
  };
  giftSlider?: GiftSliderPayload;
  cartMessages: CartMessagePayload[];
  todayOffers: TodayOfferPayload[];
  progressBars: ProgressBarPayload[];
  bundles: BundleWidgetPayload[];
  upsells: UpsellPayload[];
  warnings: PublicWarning[];
};
```

### 18.4 API framework and routing

**Admin app (React Router loaders/actions + tRPC):**
- [x] Use tRPC for all type-safe communication between admin React UI and React Router backend.
- [x] Define tRPC router in `apps/shopify-admin/server/trpc/router.ts`.
- [x] All admin mutations require Shopify session token validation (via `@shopify/shopify-app-remix` auth helper).
- [x] Admin routes: offer CRUD, product search, analytics queries, settings, sync triggers.

**Storefront public API (Hono):**
- [x] Deploy Hono router to handle all `/apps/promo-engine/*` routes.
- [x] Hono is stateless — all state in PostgreSQL/Redis/edge KV.
- [x] Can be deployed to Cloudflare Workers (edge) or as part of Node.js server.
- [x] Route structure:
  - `GET  /apps/promo-engine/runtime`            → compiled widget config (cached at edge)
  - `POST /apps/promo-engine/evaluate`           → cart evaluation (debounced by shop+cartHash)
  - `POST /apps/promo-engine/prepare-checkout`   → pre-checkout cart stabilization
  - `GET  /apps/promo-engine/product-customizations` → product page gift icons/thumbnails config
  - `POST /apps/promo-engine/analytics`          → ingest analytics events (batched, non-blocking)

**Webhook handlers (Hono):**
- [x] `POST /webhooks/products/update` → trigger partial product sync.
- [x] `POST /webhooks/products/delete` → remove from cache, warn if used in active offers.
- [x] `POST /webhooks/inventory_levels/update` → update inventory cache.
- [x] `POST /webhooks/orders/paid` → attribution reconciliation.
- [x] `POST /webhooks/orders/cancelled` → reverse attribution.
- [x] `POST /webhooks/customers/update` → invalidate customer segment cache.
- [x] `POST /webhooks/app/uninstalled` → cleanup (revoke tokens, archive offers, queue clone cleanup).
- [x] All webhook handlers validate HMAC before any processing.

**Rate limiting (Redis sliding window):**
- [x] `/evaluate` endpoint: 60 req/min per shop + 10 req/min per session.
- [x] `/prepare-checkout`: 20 req/min per shop.
- [x] `/analytics`: 500 req/min per shop (high throughput, low latency).
- [x] Webhook handlers: no rate limit (Shopify controls delivery rate) but enforce HMAC.
- [x] Admin API (tRPC): 100 req/min per authenticated session.
- [x] Return `429 Too Many Requests` with `Retry-After` header on rate limit hit.

**Security middleware (Hono):**
- [x] HMAC validation for webhook routes.
- [x] Session token validation for admin routes (Shopify JWT).
- [x] Public key validation for storefront routes (shop domain + public runtime key).
- [x] CORS allowlist for headless origins.
- [x] Request size limit (1 MB for evaluate, 50 KB for analytics batch).
- [x] No Admin API scopes or access tokens in any public endpoint response.

---

## 19. Inventory and publication handling

### 19.1 Inventory sync

- [x] Subscribe to product webhooks.
- [x] Subscribe to variant webhooks.
- [x] Subscribe to inventory level webhooks if available.
- [x] Periodic full sync.
- [x] Cache product availability.
- [x] Cache market publications.
- [x] Cache channel publications.
- [x] Cache variant inventory.
- [x] Expose sync status in admin.

### 19.2 Gift inventory policy

Admin settings:

- [x] Do not show gifts when out of stock.
- [x] Show disabled gifts when out of stock.
- [x] Auto-swap fallback gifts by priority.
- [x] Continue selling gifts if Shopify product allows oversell.
- [x] Reserve inventory is not natively reliable in Shopify cart; document this.
- [x] Remove gift if inventory becomes unavailable at prepare checkout.
- [x] Do not count unpublished gifts as selectable.
- [x] Do not auto-add unpublished gifts.

### 19.3 Publication/market policy

- [x] Gift product must be available in buyer market.
- [x] Gift product must be published to Online Store for theme runtime.
- [x] Gift product must be published to headless channel for Storefront API.
- [x] Gift product must be available to POS if POS offer.
- [x] Clone product must be hidden from product listings.
- [x] Clone product must be excluded from headless product queries.
- [x] Clone product must be noindexed if product page accessible.
- [x] Product feeds should exclude clone gift products.
- [x] Search should exclude clone gift products.

### 19.4 Common inventory failure modes

- [x] Inventory cache stale during high traffic.
- [x] Shopify reports available but add-to-cart fails.
- [x] Product unpublished from market after offer publish.
- [x] Variant archived but cached as active.
- [x] Selling plan mismatch.
- [x] Multi-location unavailable for buyer shipping country.
- [x] Inventory sync webhook delayed.
- [x] Gift selected by customer becomes unavailable before checkout.
- [x] Buyer opens two tabs and consumes gift inventory twice.
- [x] Flash-sale checkout race.

Mitigations:

- [x] Revalidate before checkout.
- [x] Revalidate in Discount Function.
- [x] Provide fallback gift option.
- [x] Show human-readable error.
- [x] Log inventory failure events.
- [x] Add admin alert.
- [x] Disable gift automatically after repeated add failures.

---

## 20. Multi-currency and Markets

### 20.1 Currency rules

- [x] Store main currency baseline.
- [x] Auto-convert threshold by Shopify exchange rate fallback.
- [x] Allow custom threshold per currency.
- [x] Allow custom fixed discount per currency.
- [x] Allow custom fixed price per currency.
- [x] Allow custom shipping discount per currency.
- [x] Round according to currency decimals.
- [x] Never let fixed discount exceed line price.
- [x] Never let shipping discount exceed shipping price.
- [x] Display money with Shopify formatting when possible.
- [x] Test zero-decimal currencies.
- [x] Test decimal currencies.

### 20.2 Markets

- [x] Sync Shopify Markets.
- [x] Allow include markets.
- [x] Allow exclude markets.
- [x] Warn if markets permission missing.
- [x] Warn if selected gift unavailable in market.
- [x] Pass market context to evaluation.
- [x] Pass buyer identity in Storefront API.
- [x] Test market change mid-session.
- [x] Test country mismatch with selected market.

---

## 21. Subscriptions

- [x] Detect selling plan on cart line.
- [x] Detect product requires selling plan.
- [x] Offer works with both by default.
- [x] Offer only one-time purchases.
- [x] Offer only subscription purchases.
- [x] Gift can be one-time even if trigger is subscription.
- [x] Gift can be subscription only if configured.
- [x] Bundle can include subscription products.
- [x] Volume discounts should respect recurring pricing limitations.
- [x] Test Appstle/Recurpay/Shopify Subscriptions if used.
- [x] Ensure checkout discounts apply to correct selling plan lines.
- [x] Avoid discounting future recurring orders unless intended.

---

## 22. POS and mobile app support

### 22.1 POS

- [x] Sales channel condition: POS.
- [x] POS offer eligibility.
- [x] Discounts should apply in POS-compatible way.
- [x] UI widgets may not render; admin should clearly mark POS behavior.
- [x] Gift auto-add might not be possible in same way; document and test.
- [x] POS should not show online-only widgets.
- [x] POS analytics attribution.

### 22.2 Mobile app builder/headless

- [x] Same evaluation endpoint.
- [x] Same normalized cart contract.
- [~] ~~N/A — headless/mobile no aplica~~
- [~] ~~N/A — headless/mobile no aplica~~
- [~] ~~N/A — headless/mobile no aplica~~
- [~] ~~N/A — headless/mobile no aplica~~

---

## 23. Translation and localization

- [x] Store widget strings by locale.
- [x] Support English, Spanish, French, German, Japanese, Dutch, Italian at minimum if business needs parity.
- [x] Auto-fallback to shop default locale.
- [x] Admin translation table.
- [x] Import/export JSON.
- [x] Theme app extension locale files where applicable.
- [x] Integrate with Shopify Translate & Adapt where possible.
- [x] Support Transcy/Weglot-style storefront language context.
- [x] RTL support if future locales require it.
- [x] Dynamic money formatting per locale.
- [x] Date/time formatting per locale/timezone.

---

## 24. Analytics

### 24.1 Metrics

- [x] Offer impressions (widget entered viewport).
- [x] Widget impressions (per widget type).
- [x] Click-through rate (widget click / impression).
- [x] Gift slider open rate (slider opened / offer qualified).
- [x] Gift selection rate (gift chosen / slider opened).
- [x] Auto-add success rate (successful auto-adds / auto-add attempts).
- [x] Offer qualification rate (qualified / evaluated).
- [x] Add-to-cart rate (gift/bundle/upsell added / shown).
- [x] Checkout start attribution (checkout started with offer in cart).
- [x] Conversion rate (order placed with offer in cart / checkout started).
- [x] Revenue attributed (order revenue linked to offer via attribution).
- [x] AOV impact (AOV with offer vs. without offer).
- [x] Funnel performance per offer type.
- [x] Bundle step completion rate (steps completed / step started).
- [x] Upsell acceptance rate (upsell added / upsell shown).
- [x] Discount usage (times discount code applied).
- [x] Error rate by offer (evaluation errors, cart mutation errors).
- [x] Inventory failure rate (gift unavailable at add or checkout).
- [x] Cart mutation failure rate (failed add/remove/update ops).
- [x] A/B variant performance comparison.

### 24.2 Event collection — Web Pixel extension

**Use Shopify's Web Pixel API for browser-side event collection (runs in Web Worker sandbox).**

- [x] Create `extensions/web-pixel/` extension using Shopify Web Pixel API.
- [x] Subscribe to standard Shopify events: `page_viewed`, `product_viewed`, `cart_updated`, `checkout_started`, `checkout_completed`, `order_placed`.
- [x] Subscribe to custom events published from theme extension:
  - [x] `promo_engine:widget_viewed` — widget entered viewport.
  - [x] `promo_engine:offer_qualified` — buyer qualified for offer.
  - [x] `promo_engine:offer_unqualified` — buyer was qualified, now disqualified.
  - [x] `promo_engine:gift_auto_added` — gift auto-added to cart.
  - [x] `promo_engine:gift_selected` — buyer chose a gift in slider.
  - [x] `promo_engine:gift_removed` — gift removed from cart.
  - [x] `promo_engine:gift_slider_opened` — gift slider popup opened.
  - [x] `promo_engine:bundle_step_completed` — bundle builder step finished.
  - [x] `promo_engine:bundle_added_to_cart` — complete bundle added.
  - [x] `promo_engine:upsell_viewed` — upsell widget shown.
  - [x] `promo_engine:upsell_added` — upsell product added.
  - [x] `promo_engine:progress_goal_reached` — progress bar reached threshold.
  - [x] `promo_engine:cart_mutation_error` — cart mutation failed.
  - [x] `promo_engine:inventory_failure` — gift unavailable at add.
- [x] Pixel relays events to analytics backend endpoint via `browser.sendBeacon()`.
- [x] Pixel adds `session_id` (generated client-side, stored in `sessionStorage`) to every event.
- [x] Pixel adds `offer_id`, `widget_id`, `offer_version` from event payload.
- [x] Pixel does NOT access DOM (runs in Web Worker — no `document`).
- [x] Pixel does NOT store PII.
- [x] Pixel handles payload size limits (send minimal payload, no raw cart data).
- [x] Test pixel in Shopify pixel sandbox (`shopify app pixel dev`) before deploying.

**Publishing custom events from theme extension:**

```js
// In app embed / Preact widget code
analytics.publish("promo_engine:gift_auto_added", {
  offer_id: "...",
  offer_version: "...",
  gift_variant_id: "...",
  cart_token: "...",
});
```

### 24.3 Attribution

- [x] Use `session_id` (client-generated UUID, stored in `sessionStorage`).
- [x] Use `cart_token` (Ajax Cart) or `cart_id` (Storefront API) as cart identity.
- [x] Use `offer_id` + `offer_version` for version-aware attribution.
- [x] Use `widget_id` for per-widget CTR.
- [x] Persist attribution in cart attributes (`_promo_engine_session_id`, `_promo_engine_offer_ids`) for order reconciliation.
- [x] Reconcile completed orders via `orders/paid` webhook — match cart attributes to session.
- [x] Avoid double counting: deduplicate `widget_viewed` events by (session_id, widget_id) within 1-minute window.
- [x] Deduplicate `gift_auto_added` events (idempotent by offer_id + variant_id + session_id).
- [x] Track offer version in every event (offer may change while cart persists).
- [x] Track first-touch offer (first offer qualified in session) and last-touch offer (last before checkout).
- [x] Track accepted gift/upsell line IDs in order attributes for post-purchase reconciliation.

### 24.4 Real-time dashboard (BOGOS-parity)

- [x] **Store Summary card:** total revenue attributed (MTD), orders, AOV impact, conversion rate.
- [x] **Campaign Type breakdown:** pie/bar chart — revenue/orders split by offer type (gift, bundle, upsell, discount).
- [x] **Conversion Funnel:** impression → qualified → add-to-cart → checkout → order (with % at each step).
- [x] **Time-series chart:** revenue and orders per offer, selectable date range (7d, 30d, 90d, custom).
- [x] **Per-offer drill-down:** click any offer → see full funnel, top gift products, error rate, A/B comparison.
- [x] **Real-time event feed** (debug mode only, development): live stream of incoming events.
- [x] **Cart mutation health monitor:** rolling 1h auto-add success rate, mutation error rate.
- [x] **Inventory failure monitor:** alerts when gift inventory failure rate exceeds threshold.
- [x] **Top gift products** table: most added gifts, most removed, availability status.
- [x] **Top bundle combinations** table: most completed bundle paths.
- [x] **Upsell performance** table: views, adds, revenue per upsell product.
- [x] **Error trend chart:** evaluation errors and cart mutation failures over time.
- [x] **Export CSV** for all analytics data (with date range filter).

### 24.5 Dashboard charts implementation

- [x] Revenue by offer (bar chart, sortable).
- [x] Orders by offer (bar chart).
- [x] CTR by widget (horizontal bar, sorted by CTR).
- [x] Conversion funnel (step chart per offer).
- [x] Gift add/remove health (area chart over time).
- [x] A/B test comparison panel (side-by-side metrics for variants).
- [x] Error trend (area chart with anomaly highlight).
- [x] Export CSV button on each chart/table.

---

## 25. AI assistant equivalent

This is optional. Do not build until core engine is stable.

- [x] Generate offer setup from natural language.
- [x] Explain why an offer is not working.
- [x] Suggest offers based on catalog.
- [x] Suggest bundle combinations.
- [x] Suggest upsell products.
- [x] Generate widget copy.
- [x] Validate offer configuration.
- [x] Create draft only; never auto-publish without review.
- [x] Keep all AI outputs auditable.

---

## 26. Security

### 26.1 App security

- [x] OAuth validation.
- [x] Session token validation.
- [x] HMAC validation for Shopify requests.
- [x] Encrypted access tokens.
- [x] Least-privilege scopes.
- [x] CSRF protection for admin routes.
- [x] Admin role check if multi-user.
- [x] Audit logs for offer changes.
- [x] Rate limits.
- [x] Webhook HMAC validation.
- [x] Secret rotation plan.
- [x] No Admin API token in browser.
- [x] No sensitive customer data in analytics payloads.
- [x] PII minimization.

### 26.2 Storefront security

- [x] Public runtime key is not a secret.
- [x] Backend must validate shop and origin.
- [x] Do not reveal hidden offer configs that expose margin-sensitive logic if not necessary.
- [x] Avoid XSS in custom HTML.
- [x] Sanitize merchant-provided HTML.
- [x] CSP-compatible script loading.
- [x] Use Subresource Integrity if self-hosting static runtime outside Shopify CDN.
- [x] Prevent mutation loops.
- [x] Prevent cart API spam through debouncing/rate limit.

### 26.3 Discount abuse prevention

- [x] Function validates eligibility.
- [x] Function caps gift quantity.
- [x] Function caps fixed discount.
- [x] Function ignores tampered line properties.
- [x] Validation function blocks direct clone product checkout.
- [x] Direct gift product purchase blocked or charged full price.
- [x] One-use-per-customer checked at backend and order reconciliation.
- [x] Customer tag conditions rechecked in checkout where possible.
- [x] Discount codes unique and scoped.

---

## 27. Performance and scalability

### 27.1 Storefront performance

- [x] Runtime under 50 KB gzipped for core if possible.
- [x] Lazy-load heavy widgets.
- [x] Lazy-load bundle builder assets only on bundle pages.
- [x] Cache active offers in local/session storage with short TTL.
- [x] Debounce cart evaluations.
- [x] Batch cart mutations.
- [x] Avoid blocking add-to-cart interaction.
- [x] Use request idle callback where safe.
- [x] Avoid layout shifts.
- [x] Avoid excessive DOM polling.
- [x] Use MutationObserver carefully.
- [x] Use event-driven integrations where possible.
- [x] Use CSS isolation.
- [x] Support no-JS graceful fallback where possible.

### 27.2 Backend performance

- [x] Cache compiled offers per shop.
- [x] Cache product match maps.
- [x] Cache collection membership.
- [x] Cache market mappings.
- [x] Cache active offer list.
- [x] Use Redis locks for sync jobs.
- [x] Use background queues for webhooks.
- [x] Use idempotency keys.
- [x] Implement database indexes.
- [x] Avoid N+1 GraphQL requests.
- [x] Use bulk operations for full catalog sync.
- [x] Backoff on Shopify rate limits.
- [x] Use partial sync from webhooks.
- [x] Precompile function config on offer publish.
- [x] Push function config to metafields.

### 27.3 Scale targets

- [x] 100 active offers per shop.
- [x] 10,000 products.
- [x] 100,000 variants.
- [x] 100 cart lines.
- [x] 1,000 requests/min storefront evaluation per shop during sale.
- [x] Evaluation endpoint P95 under 150 ms cached.
- [x] Storefront cart prepare P95 under 700 ms excluding Shopify API latency.
- [x] No more than 2 extra cart API requests per cart update in normal flow.
- [x] No more than 1 backend evaluation per cart change after debounce.

---

## 28. Reliability

- [x] Shadow mode.
- [x] Feature flags per shop.
- [x] Feature flags per offer type.
- [x] Kill switch for storefront runtime.
- [x] Kill switch for auto-add gifts.
- [x] Kill switch for discount function.
- [x] Rollback offer version.
- [x] Rollback function config.
- [x] Health check route.
- [x] Webhook replay.
- [x] Dead letter queue.
- [x] Sync retry.
- [x] Admin visible diagnostics.
- [x] Error budget for cart mutation failures.
- [x] Alert on checkout discount failure spike.
- [x] Alert on inventory add failure spike.
- [x] Alert on function errors.
- [x] Alert on webhook failures.

---

## 29. Testing strategy

### 29.1 Unit tests

- [x] Money comparison.
- [x] Currency conversion fallback.
- [x] Product matching by product.
- [x] Product matching by variant.
- [x] Product matching by collection.
- [x] Product matching by tag.
- [x] Product matching by vendor/type.
- [x] Cart value condition.
- [x] Cart quantity condition.
- [x] Specific product condition.
- [x] Cart value multiplier.
- [x] Pack condition.
- [x] Product quantity limits AND.
- [x] Product quantity limits OR.
- [x] Exclude products.
- [x] Customer tags.
- [x] Order history.
- [x] Markets.
- [x] Subscription condition.
- [x] Sales channel condition.
- [x] Priority resolver.
- [x] Stop lower priority.
- [x] Gift value counts toward other offers.
- [x] Gift quantity cap.
- [x] Cheapest item resolver.
- [x] Most expensive item resolver.
- [x] Bundle tier resolver.
- [x] Upsell trigger resolver.
- [x] Widget page rules.
- [x] Translation fallback.

### 29.2 Integration tests

- [x] Shopify Admin API product sync.
- [x] Shopify Admin API discount creation.
- [x] Metafield config publish.
- [x] Webhook processing.
- [x] Ajax Cart add gift.
- [x] Ajax Cart update gift.
- [x] Ajax Cart remove gift.
- [x] Storefront API cartLinesAdd.
- [x] Storefront API cartLinesUpdate with attributes preserved.
- [x] Storefront API cartDiscountCodesUpdate.
- [x] Checkout prepare flow.
- [x] Function input/output test fixtures.
- [x] Cart drawer rerender.
- [x] App embed enabled/disabled.
- [x] Theme app block render.

### 29.3 E2E tests with Playwright

- [x] Create gift offer in admin.
- [x] Publish gift offer.
- [x] Visit product page.
- [x] Add qualifying product.
- [x] Verify gift auto-added.
- [x] Remove qualifying product.
- [x] Verify gift removed.
- [x] Open checkout.
- [x] Verify gift discounted.
- [x] Increase gift quantity manually.
- [x] Verify quantity corrected or extra charged.
- [x] Gift slider selection.
- [x] Cart message.
- [x] Progress bar.
- [x] Today Offer widget.
- [x] Classic bundle add.
- [x] Mix and match add.
- [x] Bundle page step flow.
- [x] Volume discount.
- [x] Cheapest item discount.
- [x] Checkout upsell.
- [x] FBT.
- [x] Thank-you upsell.
- [x] Multi-currency market.
- [x] Customer tag condition.
- [x] Logged-out customer.
- [x] POS smoke test if possible.
- [x] Headless demo app test.

### 29.4 Load tests

- [x] Evaluate 100 offers against 100-line cart.
- [x] Burst cart mutation events.
- [x] 1,000 concurrent evaluation requests.
- [x] Large bundle page product list.
- [x] Analytics event ingestion spike.
- [x] Webhook burst from bulk product update.

### 29.5 Regression matrix

Create a matrix with axes:

- [x] Offer type.
- [x] Reward type.
- [x] Gift logic mode.
- [x] Sales channel.
- [x] Market.
- [x] Currency.
- [x] Customer login status.
- [x] Cart drawer vs cart page.
- [x] Desktop vs mobile.
- [x] Theme.
- [x] Subscription vs one-time.
- [x] Discount combination.

---

## 30. Known Shopify-specific pitfalls

### 30.0 Critical 2026 deadlines

> ⚠️ These are BLOCKING for migration. Do not begin cutover without addressing these.

- [x] **Shopify Scripts — April 15, 2026**: Scripts can no longer be edited or published. Any merchant editing Scripts after this date will be blocked.
- [x] **Shopify Scripts — June 30, 2026**: All Scripts stop executing. If current BOGOS installation uses any Scripts (some older BOGOS setups do), they will silently stop working on this date.
- [x] **Action**: Complete a Scripts audit in Phase 0. If Scripts are found, they must be replaced by Discount Functions before June 30, 2026.
- [x] **Polaris React archived**: `@shopify/polaris` (React) was archived January 6, 2026. No new features or security fixes will be released. Plan migration to Polaris Web Components as a follow-up.

### 30.1 Cart and line item pitfalls

- [x] Cart line keys change after every add/update/delete operation — never cache keys across mutations.
- [x] Same variant can appear in multiple cart lines when line item properties differ — use line key, not variant ID, to target specific lines.
- [x] Updating by variant ID (`/cart/change.js?id=variant_id`) may update the wrong line when duplicates exist — always use `line_key`.
- [x] Storefront API `cartLinesUpdate` silently drops all line attributes if `attributes` field is not included in the mutation — always pass the full attributes array.
- [x] Ajax Cart API and Storefront API cart tokens/IDs are NOT interchangeable — the `token` from Ajax API does not equal the `id` from Storefront API.
- [x] Storefront API cart expires after ~10 days of inactivity — detect and handle expired cart gracefully (create new cart, migrate lines where possible).
- [x] Ajax Cart API may return stale data after rapid sequential mutations — always re-fetch after each batch.
- [x] Cart line quantity 0 via `/cart/change.js` removes the line; do not rely on it returning the removed line in the response.

### 30.2 Discount and Functions pitfalls

- [x] Discount code applied in cart preview (`/cart/update.js`) may not guarantee checkout eligibility — Discount Function is authoritative at checkout.
- [x] Functions are stateless and deterministic — cannot fetch external data at runtime. All config must be in metafields.
- [x] Function metafield config max size: 10 KB. If compiled offer config exceeds this, shard across multiple metafields and merge in function.
- [x] Discount Function runs for every cart calculation (not just checkout) — must be fast and handle partial/empty carts gracefully.
- [x] Shopify Scripts sunset June 30, 2026 — any Scripts-based promotion logic stops working on that date.
- [x] Multiple product discounts per cart line: supported as of April 30, 2026 — earlier versions only applied one discount per line.
- [x] Discount class combinations require explicit `combinesWith` configuration — default is no combination.
- [x] Discount code entered by buyer may conflict with app-generated code — test all combination policy states.

### 30.3 Cart Transform pitfalls

- [x] Only one Cart Transform function per app per store — plan what goes here carefully.
- [x] Multiple apps can each have one Cart Transform — they can conflict (e.g., subscription app + bundle app).
- [x] `lineUpdate` requires Shopify Plus — confirmed for this project, but document for future portability.
- [x] Lines with selling plans are REJECTED by `lineExpand`, `linesMerge`, and `lineUpdate` — subscription + bundle is a hard edge case.
- [x] Cart Transform output is not guaranteed to persist after browser navigation — storefront must re-evaluate on return.

### 30.4 App extension and theme pitfalls

- [x] App embed blocks are disabled by default after install — merchant must enable in theme editor. Add first-run wizard that links directly to theme editor.
- [x] Theme app extensions only work with Online Store 2.0 themes (e.g., Dawn and equivalents). Legacy themes require manual script injection workaround.
- [x] Per-market theme customization (2026): app embed settings and block settings can be configured per market — use this for market-specific widget copy.
- [x] App blocks position depends on merchant theme editor placement — cannot guarantee exact position without CSS injection fallback.
- [x] Section rendering for cart drawer updates may not be available in all themes — always provide fallback `window.PromoEngine.refreshCart()` API.

### 30.5 Inventory and product pitfalls

- [x] Market/product publication is the most common reason gift auto-add fails — gift must be published to Online Store AND buyer's market.
- [x] Inventory availability can be stale during high-volume sales — webhook lag + cache lag = race condition. Revalidate before checkout.
- [x] Shopify does NOT reliably reserve inventory in the cart — a product can be "available" in the cart but sold out at checkout.
- [x] Variant archived vs. deleted: archived variants are not purchasable but may still appear in Admin API. Treat archived as unavailable.
- [x] `available_for_sale` in Storefront API respects publication + inventory + selling plan status. Always use this field for gift eligibility.
- [x] Products with `inventory_policy: CONTINUE` allow overselling — gifts with this policy can be added even when `inventory_quantity` is 0.
- [x] Gift clone product must be excluded from: search, sitemaps, product feeds, headless catalog queries, collection pages.

### 30.6 Market and currency pitfalls

- [x] Cart currency is determined by buyer identity country code (Storefront API) or by session locale (Ajax API) — can differ from admin currency.
- [x] Fixed-amount discounts in wrong currency silently fail in Discount Function — must precompile per-currency values.
- [x] Exchange rate in Shopify is the merchant's configured rate, not real-time — can diverge during currency volatility.
- [x] Zero-decimal currencies (e.g., JPY, KRW) — all amount calculations must be integers; never use `toFixed(2)`.
- [x] Market change mid-session (buyer changes shipping country) — cart currency can change; all gift eligibility must be re-evaluated.

### 30.7 Subscriptions and selling plans pitfalls

- [x] Subscription recurring line discounts behave differently from one-time line discounts — a Discount Function applying to a subscription line may discount ALL future recurring orders, not just the first.
- [x] Cart Transform rejects lines with selling plans for `lineExpand`/`linesMerge`/`lineUpdate` — bundles with subscription products are hard.
- [x] Checkout UI Extensions cannot always add subscription lines — test with your specific subscription app.
- [x] `requires_selling_plan` products cannot be added to cart without a selling plan — gift of a subscription product requires a selling plan to be specified.

### 30.8 Checkout UI Extension pitfalls

- [x] Extension network access requires permission in TOML — without it, backend calls are blocked.
- [x] Extension render time is limited — if backend call times out, extension must show nothing (graceful degradation).
- [x] Extensions run in an isolated sandbox — no access to `window`, `document`, or parent frame.
- [x] `applyCartLinesChange` can fail in some express checkout surfaces — always handle failure.
- [x] Post-purchase extension (thank-you) can only create NEW orders, not modify the just-completed order.
- [x] Thank-you page post-purchase extension: buyer is not guaranteed to see it (redirect, mobile app, etc.) — do not rely on it for critical discount validation.

### 30.9 Other

- [x] Gift cards must be excluded from discountable/gift qualification logic unless explicitly configured.
- [x] Draft Order API does not support all storefront discount behaviors — avoid Draft Orders for promotion logic.
- [x] Some cart drawers (e.g., Rebuy, Sidecart, custom built) override cart rendering and need explicit integration hooks.
- [x] POS does not render storefront web widgets — POS promotion support requires a separate POS-specific implementation path.

---

## 31. Implementation phases

### Phase 0 — Discovery and parity audit

**Scripts audit (CRITICAL — do before anything else):**
- [x] **Check for Shopify Scripts**: in Shopify Admin → Apps → Script Editor — list all active Scripts.
- [x] **Identify which Scripts are BOGOS-managed** vs. custom store Scripts.
- [x] **Document each Script's purpose** (discount logic, gift logic, cart modification).
- [x] **Map each Script to its Function replacement** before writing any code.
- [x] **Deadline**: Scripts stop executing June 30, 2026. Complete migration before that date.

**BOGOS offer audit:**
- [x] Export/list all current BOGOS offers (use BOGOS admin export if available, or screenshot each).
- [x] Capture screenshots of all current BOGOS settings (conditions, rewards, widgets, thresholds, targeting).
- [x] Record storefront behavior for each offer (video recording + DOM/network captures).
- [x] Record cart drawer behavior when offer qualifies and disqualifies.
- [x] Record checkout behavior with each offer type in cart.
- [x] Identify all discount codes created by BOGOS (visible in Shopify Admin → Discounts).
- [x] Identify clone gift products (tagged `bogos-gift` or handle ends in `-sca_clone_freegift`).
- [x] Identify gift product tags/handles used by BOGOS clone system.

**Theme and integration audit:**
- [x] Capture DOM and network markers for current theme (BOGOS CSS classes, event names, script tags).
- [x] Identify all cart drawer/theme integrations (is there a custom cart drawer? Which app?).
- [x] Identify all other apps that modify the cart (subscription, loyalty, currency apps).
- [x] Check for Cart Transform functions from other apps (check in Shopify Partners → App Extensions).

**Infrastructure audit:**
- [x] Identify Shopify Markets configured (list all markets, currencies, domains).
- [x] Identify subscription apps used (Appstle, ReCharge, Shopify Subscriptions, etc.).
- [x] Identify POS usage (is POS used? Which offers are POS-enabled?).
- [~] ~~Identify headless/Hydrogen usage — N/A: store usa tema estándar.~~
- [x] Identify current BOGOS API usage (are any external systems calling BOGOS API?).

**Deliverables:**
- [x] Create parity matrix: each BOGOS feature → internal equivalent → implementation phase.
- [x] Create Scripts replacement checklist: each Script → Discount Function spec.
- [x] Create migration risk register: high-risk items that need extra validation.

### Phase 1 — Foundation

- [x] Scaffold Shopify React Router app (`npm create @shopify/app@latest`).
- [x] Set up monorepo structure (apps/, packages/, extensions/, workers/).
- [x] Configure custom app install (internal app — no App Store listing).
- [x] Configure scopes (see Section 4).
- [x] Set up PostgreSQL with Drizzle ORM schema (see Section 7).
- [x] Set up Redis.
- [x] Set up BullMQ queues (product sync, analytics, offer publisher).
- [x] Set up Hono router for public/storefront API endpoints.
- [x] Set up webhook HMAC validation middleware.
- [x] Set up product sync worker (initial full sync + webhook-based partial sync).
- [x] Set up variant sync worker.
- [x] Set up collection sync worker.
- [x] Set up market sync.
- [x] Set up inventory sync.
- [x] Set up admin dashboard shell.
- [x] Set up audit logs.
- [x] Set up diagnostics.

### Phase 2 — Gift engine MVP

- [x] Gift offer CRUD.
- [x] Cart value condition.
- [x] Cart quantity condition.
- [x] Specific product condition.
- [x] Auto-add gifts.
- [x] Gift slider.
- [x] Gift line properties.
- [x] Storefront runtime.
- [x] Cart message.
- [x] Discount Function for gift discount.
- [x] Checkout prepare.
- [x] Gift cleanup.
- [x] Basic analytics.
- [x] Shadow mode.

### Phase 3 — Advanced gift parity

- [x] Cart value multiplier.
- [x] Pack condition.
- [x] All subconditions.
- [x] Product quantity limits.
- [x] Multi-currency thresholds.
- [x] Markets.
- [x] Order history.
- [x] One-use-per-customer.
- [x] Gift sync quantity.
- [x] Clone product mode if required.
- [x] Priority and stacking.
- [x] Today Offer.
- [x] Progress bar.
- [x] Gift icon/thumbnail.

### Phase 4 — Bundles

- [x] Classic bundle.
- [x] Mix and match.
- [x] Bundle page.
- [x] Bundle tiers.
- [x] Bundle widgets.
- [x] Bundle discount function logic.
- [x] Bundle max/min enforcement.
- [x] Bundle analytics.
- [x] Optional Cart Transform.

### Phase 5 — Upsells and discounts

- [x] Frequently bought together.
- [x] Checkout upsell.
- [x] Thank-you upsell.
- [x] Volume discount.
- [x] Cart discount.
- [x] Cheapest/most expensive item discount.
- [x] Upsell analytics.
- [x] Discount analytics.

### Phase 6 — Headless/POS/translation

- [~] ~~N/A — headless no aplica~~
- [~] ~~N/A — headless no aplica~~
- [~] ~~N/A — headless no aplica~~
- [~] ~~N/A — headless no aplica~~
- [x] POS support.
- [x] Translation UI.
- [x] Multi-language runtime.

### Phase 7 — Hardening

- [x] Full E2E coverage.
- [x] Load tests.
- [x] Security review.
- [x] Accessibility review.
- [x] Performance budget.
- [x] Observability dashboards.
- [x] Runbook.
- [x] Rollback plan.
- [x] Migration cutover.

---

## 32. Copilot master prompt (Updated 2026-06)

Use this in the new repository. Paste into Copilot's instructions / `.github/copilot-instructions.md`.

```txt
You are a senior Shopify app engineer building an internal Shopify promotion engine
with functional parity to our documented BOGOS-like requirements, without copying
proprietary code, branding, UI assets, or private APIs.

Store plan: Shopify Plus — all Plus-gated features are available and in scope.

Monorepo structure:
  apps/shopify-admin/          → Shopify React Router app (embedded admin dashboard)
  packages/rule-engine/        → Pure TypeScript: cart evaluator, conditions, rewards, priority, stacking
  packages/storefront-runtime/ → Preact + vanilla TS: widgets, cart adapter, event bus, debounce queue
  packages/shared-types/       → Zod schemas + TypeScript types shared across all packages
  extensions/discount-function/ → Rust: gift/bundle/volume/shipping discount validation
  extensions/cart-transform/   → Rust: bundle line expansion + lineUpdate (Plus available)
  extensions/checkout-ui/      → Checkout upsell widgets (Plus — all steps including payment, thank-you)
  extensions/web-pixel/        → Analytics event collection (Web Worker sandbox)
  extensions/customer-account-ui/ → Customer portal order attribution
  workers/                     → Product/inventory/market sync, analytics reconciliation

Tech stack:
  Admin app:        Shopify React Router (React Router v7 framework mode, official Shopify template)
  Language:         TypeScript 5.x strict mode throughout
  Admin UI:         @shopify/polaris (React 18) — archived Jan 2026, pragmatic for internal use, tech debt
  Admin API:        Shopify GraphQL Admin API 2026-04 (latest)
  Package manager:  pnpm
  Runtime:          Node.js 22 LTS (never Bun as server runtime)
  Database:         PostgreSQL 16+ with Drizzle ORM (NOT Prisma)
  Cache/Queues:     Redis 7+ + BullMQ
  Public API:       Hono (edge-compatible — works on Node.js, Cloudflare Workers, Vercel Edge)
  RPC (admin):      tRPC (type-safe React ↔ React Router loader/action communication)
  Validation:       Zod 3+ for all schema validation
  Logging:          Pino (structured JSON)
  Tracing:          OpenTelemetry
  Errors:           Sentry
  Unit tests:       Vitest
  E2E tests:        Playwright
  Functions lang:   Rust (ALL Shopify Functions — Discount, Cart Transform, Validation)
  Storefront:       Preact for interactive widgets; vanilla JS Web Components for stateless widgets
  Build tool:       Bun (for storefront asset bundling and test running only — not server runtime)

Shopify-specific critical constraints (2026):
  - Shopify Scripts SUNSET June 30, 2026. Do not use or reference Script logic.
  - @shopify/polaris (React) archived Jan 2026 — use it for internal app, plan migration.
  - Cart Transform lineUpdate: available on Shopify Plus (confirmed) and dev stores.
  - Validation Functions: 5ms execution budget — Rust mandatory.
  - Discount Functions: 11M instruction budget at 200 cart items — Rust strongly recommended.
  - Multiple product discounts per cart line: supported as of April 30, 2026.
  - Function config in metafields: max 10 KB per metafield. Shard if needed.
  - Checkout UI Extensions: all surfaces available on Plus (info, shipping, payment, thank-you).
  - App embed blocks are disabled by default after install — activation step must be documented.
  - Admin API 2026-04: use discount tags, market-specific eligibility, and Buy-X-Get-Y prerequisites.

Core engineering principles (non-negotiable):
  - Storefront JavaScript is NEVER authoritative for discounts. Shopify Functions + backend are.
  - Use Result/Either type for all error handling in rule engine — no thrown exceptions.
  - Deterministic rule evaluation: same input → same output always.
  - Idempotent cart mutations: safe to run multiple times without side effects.
  - Always use line item KEY (not variant ID) when targeting specific cart lines.
  - Preserve ALL line attributes on every Storefront API cartLinesUpdate call.
  - Revalidate entire cart state before redirecting to checkout.
  - Every offer must be versioned (offer_versions table) and auditable (audit_logs table).
  - Every complex rule must have Vitest unit tests with fixtures.
  - Every storefront cart mutation must have integration tests.
  - Zero trust on line item properties (_promo_engine_*) — always verify server-side.
  - Gift clone products must be hidden from search, sitemaps, feeds, and headless catalogs.

Performance targets (enforce in CI):
  - Core storefront runtime: < 30 KB gzipped.
  - Gift slider widget: < 15 KB gzipped.
  - Bundle builder (lazy-loaded): < 50 KB gzipped.
  - Evaluation API P95: < 120 ms (origin), < 50 ms (edge cache hit).
  - Core Web Vitals on bundle pages: LCP < 2.5s, CLS < 0.1, INP < 200 ms.
  - Validation Function: < 5ms (hard Rust requirement).
  - Discount Function: benchmark 100 lines × 100 offers within 11M instruction budget.

Implementation order for Phase 1 + 2:
1. Drizzle schema: shops, offers, offer_versions, offer_conditions, offer_rewards,
   offer_combination_policies, widgets, widget_placements, bundle_definitions,
   bundle_steps, bundle_tiers, product_cache, variant_cache, analytics_events,
   cart_mutation_logs, audit_logs.
2. packages/rule-engine: cart evaluator with Result types, conditions (cart_value,
   cart_quantity, specific_product, multiplier, pack), rewards, priority resolver,
   stop-lower-priority, gift rewards. Full unit test coverage with fixtures.
3. extensions/discount-function (Rust): gift eligibility validation, product discounts,
   quantity cap enforcement, cheapest-item logic, bundle discounts, combination policy.
   Benchmark with worst-case fixture.
4. extensions/cart-transform (Rust): lineExpand for bundle components, lineUpdate for
   bundle presentation (Plus). Test with subscription-product edge case.
5. extensions/cart-and-checkout-validation (Rust): gift quantity abuse, hash verification,
   clone product direct purchase block. 5ms budget tests.
6. apps/shopify-admin: offer list, offer builder wizard (8 steps), Polaris components,
   tRPC routes, preview/debug panel.
7. packages/storefront-runtime: Preact gift slider, cart adapter (Ajax + Storefront API),
   event bus, debounce mutation queue, checkout prepare, Web Component progress bar.
8. extensions/checkout-ui: checkout upsell (all Plus surfaces including payment step).
9. extensions/web-pixel: custom event collection, relay to analytics backend.
10. Playwright E2E: full buyer flow for each offer type (gift, bundle, upsell, discount).
11. Load tests: 100 offers × 100-line cart, 1000 concurrent evaluation requests.

Forbidden:
  - Shopify Scripts (sunset June 30, 2026).
  - Prisma (use Drizzle).
  - Bun as server runtime (Node.js 22 LTS only).
  - Client-side price display as discount authority.
  - Trusting line item properties as proof of eligibility without server verification.
  - Exposing Admin API tokens to storefront JavaScript.
  - Thrown exceptions in rule engine (use Result/Either).
  - Cart Transform lineUpdate on non-Plus stores (document constraint for portability).
  - Copying BOGOS source code, private APIs, branding, or UI assets.
```

---

## 33. Definition of done

### 33.1 Feature done

A feature is done only when:

- [x] Admin configuration exists.
- [x] Backend schema exists.
- [x] Validation exists.
- [x] Preview/debug exists.
- [x] Storefront behavior exists where relevant.
- [x] Checkout/function validation exists where relevant.
- [x] Analytics events exist.
- [x] Unit tests exist.
- [x] Integration tests exist.
- [x] E2E tests exist for critical buyer flow.
- [x] Edge cases documented above are covered or explicitly deferred.
- [x] Performance impact measured.
- [x] Rollback path exists.

### 33.2 Migration done

Migration is done only when:

- [x] Every production BOGOS offer has internal equivalent.
- [x] Shadow evaluation matches expected behavior.
- [x] Gift add/remove behavior matches expected behavior.
- [x] Checkout discounts match expected behavior.
- [x] Cart drawer works.
- [x] Mobile works.
- [x] Markets/currency works.
- [x] Analytics works.
- [x] BOGOS can be disabled without loss of promotions.
- [x] Rollback plan tested.

---

## 34. Source notes consulted

Public sources used to inform this requirements document:

- Shopify App Store listing for "BOGOS: Free Gift Bundle Upsell".
- BOGOS public GitBook user guide (bogos-guideline.gitbook.io/user-guide).
- BOGOS public API/SDK integration GitBook (bogos-api-integration.gitbook.io).
- @bogos/freegifts-hydrogen npm package (deprecated, for reference only).
- Shopify official docs for API scopes (shopify.dev/docs/api/admin-graphql/latest).
- Shopify official docs for Ajax Cart API.
- Shopify official docs for Theme App Extensions.
- Shopify official docs for Discount Functions (shopify.dev/docs/api/functions/latest/discount).
- Shopify official docs for Cart Transform Functions.
- Shopify official docs for Storefront API carts.
- Shopify official docs for Checkout UI Extensions.
- Shopify Changelog (changelog.shopify.com) — 2025/2026 changes.
- Shopify Admin API 2026-04 release notes.
- Shopify Web Pixels API docs.
- Shopify Customer Account UI Extensions docs.
- @shopify/polaris deprecation announcement (January 6, 2026).
- Shopify Scripts sunset announcement (June 30, 2026).

---

## 35. Web Pixels extension

### 35.1 Overview

The Web Pixel extension (`extensions/web-pixel/`) collects browser-side promotion events through Shopify's secure Web Pixel framework. It runs in a **Web Worker sandbox** — no DOM access, no cookie access, no shared memory with the storefront.

- [x] Create Shopify Web Pixel extension using `shopify app generate extension --type web_pixel`.
- [x] Configure `shopify.extension.toml` with event subscriptions.
- [x] Use `analytics.subscribe()` to listen to standard Shopify events.
- [x] Use `analytics.subscribe("custom", callback)` to receive custom events from theme extension.
- [x] Use `browser.sendBeacon(url, payload)` to relay events to analytics backend.

### 35.2 Standard events to subscribe

- [x] `page_viewed` — track pages visited with offer present.
- [x] `product_viewed` — track product pages (for gift icon/thumbnail analytics).
- [x] `cart_viewed` — track cart page opens.
- [x] `checkout_started` — session-level checkout attribution start.
- [x] `payment_info_submitted` — user committed to checkout.
- [x] `order_placed` — conversion confirmation (supplement with order webhook).

### 35.3 Custom events to receive from theme extension

Published via `analytics.publish(eventName, payload)` from app embed/Preact widgets:

- [x] `promo_engine:widget_viewed` — widget entered viewport (offer_id, widget_id, widget_type).
- [x] `promo_engine:offer_qualified` — cart qualified for offer (offer_id, condition_summary).
- [x] `promo_engine:offer_unqualified` — cart was qualified, now disqualified (offer_id, reason).
- [x] `promo_engine:gift_auto_added` — gift auto-added (offer_id, variant_id, quantity).
- [x] `promo_engine:gift_selected` — gift chosen in slider (offer_id, variant_id).
- [x] `promo_engine:gift_removed` — gift removed from cart (offer_id, variant_id, reason).
- [x] `promo_engine:gift_slider_opened` — slider popup opened.
- [x] `promo_engine:bundle_step_completed` — bundle builder step finished (bundle_id, step_index).
- [x] `promo_engine:bundle_added_to_cart` — complete bundle added (bundle_id, component_variant_ids).
- [x] `promo_engine:upsell_viewed` — upsell shown (offer_id, product_id, position).
- [x] `promo_engine:upsell_added` — upsell accepted (offer_id, variant_id).
- [x] `promo_engine:upsell_dismissed` — upsell dismissed (offer_id).
- [x] `promo_engine:progress_goal_reached` — progress bar threshold met (offer_id, goal_index).
- [x] `promo_engine:cart_mutation_error` — cart add/remove/update failed (offer_id, error_type).
- [x] `promo_engine:inventory_failure` — gift unavailable at add attempt (offer_id, variant_id).

### 35.4 Payload contract

Each relayed event must include:

```ts
type PixelEventPayload = {
  event_name: string;
  session_id: string;       // client-generated UUID from sessionStorage
  shop_domain: string;      // public, injected at app embed init
  offer_id?: string;
  offer_version?: string;
  widget_id?: string;
  cart_token?: string;      // Ajax cart token if available
  occurred_at: string;      // ISO 8601 timestamp
  properties: Record<string, string | number | boolean>;
};
```

- [x] Do NOT include customer PII (email, name, address) in pixel events.
- [x] Do NOT include full cart contents — use cart_token for reconciliation.
- [x] Payload must stay under Shopify's pixel payload size limit.
- [x] `session_id` generated client-side: `crypto.randomUUID()` stored in `sessionStorage`.
- [x] If `sessionStorage` unavailable (SSR/headless), fallback to URL-based session or skip.

### 35.5 Pixel limitations

- [x] No DOM access — cannot read cart line keys or checkout state directly.
- [x] No cookie access — use `sessionStorage` reference from event payload, not pixel.
- [x] Cannot call arbitrary fetch() — use `browser.sendBeacon()` or `browser.fetch()`.
- [x] Cannot import npm packages — must be self-contained vanilla JS.
- [x] Test pixel in Shopify pixel sandbox (`shopify app pixel dev`) before deploying.
- [x] Pixel may be blocked by ad blockers — analytics backend must treat missing events gracefully (do not block order reconciliation on pixel data).

---

## 36. Customer Account UI Extension

### 36.1 Overview

Available on **all plans** as of 2026-01 (no longer Plus-only). Extends the new customer accounts (legacy customer accounts deprecated February 26, 2026).

- [x] Create extension: `shopify app generate extension --type customer_account_ui`.
- [x] Configure `shopify.extension.toml` with target pages.
- [x] Use Preact/TSX for the extension UI.
- [x] Fetch data from app backend via extension network access permission (`network_access: true` in TOML).

### 36.2 Target surfaces

- [x] **Order detail page** (`CustomerAccount::Order::Detail::RenderAfter`):
  - Show which promotions were active when this order was placed.
  - Show gift products included in the order (attributed offers).
  - Show "You saved X with Offer Name" summary.
- [x] **Profile page** (`CustomerAccount::Profile::RenderAfter`):
  - Show current customer tier/segment if relevant.
  - Show active offers the customer is currently eligible for (tease without exposing business logic).
  - Show one-use-per-customer status for specific offers.

### 36.3 Implementation checklist

- [x] Backend endpoint: `GET /apps/promo-engine/customer/offers?customer_gid=...` — returns eligible offers for display.
- [x] Backend endpoint: `GET /apps/promo-engine/customer/order-attribution?order_gid=...` — returns offers attributed to an order.
- [x] Extension requests both endpoints on mount.
- [x] Handle loading state (show skeleton while fetching).
- [x] Handle error state (network error) — show nothing rather than error UI.
- [x] Handle empty state (no offers attributed) — show nothing rather than empty section.
- [x] Only show customer-relevant information — no business logic, no offer config details.
- [x] Respect locale from customer account context for money formatting.

### 36.4 Edge cases

- [x] Customer has never placed an order — order detail page extension does not render.
- [x] Order placed before promotion engine was installed — no attribution data → show nothing.
- [x] Customer account context does not include customer GID (e.g., guest viewing shared order link) — skip fetch.
- [x] Network access times out — fail silently.
- [x] Order has multiple attributed offers — show all, sorted by revenue impact.

---

## 37. Per-market theme configuration

### 37.1 Overview

As of 2026, Shopify theme app extensions support per-market configuration. App embed settings and app block settings can vary per Shopify Market. This enables market-specific widget copy, thresholds display, and color themes without requiring separate extensions.

### 37.2 Use cases

- [x] Widget message copy per market (e.g., 'Free gift with orders over $50' vs. 'Gratis Geschenk ab 50€').
- [x] Currency symbol formatting per market (use Shopify's money format, not hardcoded).
- [x] Threshold display values per market (show market-local threshold, not store base currency).
- [x] Color theme per market (optional — if brand varies by region).
- [x] Disable specific widgets in specific markets (e.g., no gift slider in a specific country).

### 37.3 Implementation

- [x] In `shopify.extension.toml`, define settings that support per-market values.
- [x] Sync market list from Shopify Markets Admin API and expose in widget configuration UI.
- [x] In storefront runtime, detect current market from `window.Shopify.locale` or buyer identity context.
- [x] Pass market context in every evaluation request to backend.
- [x] Widget renders market-specific copy from evaluation response (backend sends translated strings).
- [x] Do NOT rely on per-market theme config for eligibility logic — use backend rule engine.
- [x] Test: switch market mid-session → widget copy updates → evaluation uses new market context.

### 37.4 Edge cases

- [x] Market not configured → fall back to default (store main locale and currency).
- [x] Market-specific config deleted → fall back to default silently.
- [x] Buyer's detected country doesn't match any configured market → use closest match or default.
- [x] Theme editor preview in a different market than live store → extension must handle preview context.

---

## 38. Performance strategy — exceeding BOGOS

### 38.1 Storefront runtime size budget

Size budgets must be enforced in CI (fail build if exceeded):

| Asset | Budget (gzipped) |
|---|---|
| Core runtime (app embed) | < 30 KB |
| Gift slider (Preact) | < 15 KB |
| Bundle builder (lazy) | < 50 KB |
| Today Offer widget | < 8 KB |
| Progress bar (Web Component) | < 5 KB |
| Cart message (Web Component) | < 5 KB |
| FBT widget (Preact) | < 12 KB |

- [x] Measure with `bun build --analyze` or equivalent.
- [x] Add CI step: `size-limit` package or custom script that fails on budget breach.
- [x] Lazy-load bundle builder — inject only on bundle page (check current page URL/route).
- [x] Lazy-load gift slider — inject only after first cart add.
- [x] Core runtime loads on DOMContentLoaded.
- [x] Use `import()` dynamic imports for Preact components.

### 38.2 Evaluation API performance

- [x] Cache compiled offer configs in Redis (TTL 60s) — keyed by `shop_id`.
- [x] Cache evaluation responses in edge KV (TTL 30s) — keyed by `SHA256(shop_id + cart_hash)`.
- [x] Invalidate Redis cache on offer publish/pause/archive.
- [x] Invalidate edge cache via cache tag or short TTL.
- [x] Return `stale-while-revalidate` header for non-personalized widget config.
- [x] Evaluation API P50 target: < 30 ms (edge cache hit).
- [x] Evaluation API P95 target: < 120 ms (origin miss).
- [x] `cartHash` = SHA256 of `(sortedLineVariantIds + quantities + discountCodes)` — deterministic cache key.
- [x] Do NOT cache customer-specific eligibility results (order history, customer tags).

### 38.3 Edge deployment

- [x] Deploy Hono evaluation endpoint to Cloudflare Workers or Vercel Edge Functions.
- [x] Use edge KV (Cloudflare KV or Vercel KV) for compiled offer config cache.
- [x] Stateless function — all state in PostgreSQL or Redis (no local state).
- [x] Push compiled offer config to edge KV on every offer publish (via offer-publisher worker).
- [x] Use `103 Early Hints` to preload runtime config script on page load.
- [x] CDN cache the `GET /runtime` endpoint with a short TTL (60s) + stale-while-revalidate.

### 38.4 Storefront widget performance patterns

- [x] Use `IntersectionObserver` for widget viewport detection (not scroll event listeners).
- [x] Use `PerformanceObserver` to track INP impact of widget interactions.
- [x] Use CSS `content-visibility: auto` on heavy off-screen widgets.
- [x] Use placeholder skeleton while widget data loads to prevent CLS.
- [x] Use `requestIdleCallback` for non-critical analytics enqueue (fallback to `setTimeout`).
- [x] No `setInterval` polling — use event-driven evaluation (cart change event → evaluate).
- [x] Use `sendBeacon()` for analytics events (does not block page unload).
- [x] Debounce cart evaluations: 300ms after last cart change event.
- [x] Batch cart mutations: collect all add/remove actions from one evaluation, execute in one batch.
- [x] Cancel stale evaluation: if a new cart change arrives before previous evaluation resolves, cancel the pending request.

### 38.5 Backend caching layers

```
L1: Process memory (in-memory Map) — compiled offer config — TTL 5s
L2: Redis — compiled offer config — TTL 60s
L3: Edge KV — evaluation response cache — TTL 30s (keyed by cartHash)
```

- [x] Product/variant lookup maps: Redis hash, invalidated by webhook.
- [x] Collection membership: Redis Set per collection, invalidated by collection/product webhooks.
- [x] Market data: Redis, invalidated by markets webhook, refreshed every 60 min.
- [x] Customer segment data (tags, order history): Redis, TTL 5 min (changes frequently).
- [x] **Never cache customer-specific eligibility in shared cache** — cache key must include customer GID.
- [x] Add cache hit/miss metrics to OpenTelemetry traces.

### 38.6 Client-side optimistic evaluation (advanced, gated by feature flag)

- [x] Optionally compile the rule evaluator core to WASM (< 100 KB).
- [x] WASM evaluator runs client-side on cart change → instant optimistic UI response.
- [x] Server evaluation runs in parallel → reconciles if result differs.
- [x] Optimistic result shown immediately; corrected silently if server differs (no flash).
- [x] Only include condition types that cover 90%+ of offers (cart_value, cart_quantity, specific_product).
- [x] Gate behind feature flag — A/B test to measure actual latency improvement before enabling broadly.
- [x] Do NOT use WASM for security-critical logic — server is always authoritative.

### 38.7 Core Web Vitals targets

Target on bundle pages (most complex render):

| Metric | Target |
|---|---|
| LCP | < 2.5s |
| CLS | < 0.1 |
| INP | < 200 ms |

- [x] Measure with Playwright + `web-vitals` library in E2E test.
- [x] Add Lighthouse CI step in GitHub Actions.
- [x] Alert if CWV regressions detected after any storefront deploy.
- [x] Bundle builder must not shift layout when loading products — use skeleton placeholders.
- [x] Gift slider must not shift layout when opening — use CSS transform, not layout shift.

































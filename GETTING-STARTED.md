# Promo Engine — Getting Started

Internal Shopify promotion engine. Functional parity with BOGOS.io.

## Prerequisites

- Node.js 22 LTS
- pnpm 9+
- Rust + cargo-component (for Shopify Functions)
- PostgreSQL 16+
- Redis 7+
- Shopify CLI 3.x
- A Shopify Plus dev store

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values:
# - SHOPIFY_API_KEY and SHOPIFY_API_SECRET from Partners Dashboard
# - DATABASE_URL pointing to your PostgreSQL instance
# - REDIS_URL pointing to your Redis instance
# - TOKEN_ENCRYPTION_KEY (generate with: openssl rand -hex 32)
```

### 3. Set up the database

```bash
# Run migrations
pnpm db:migrate

# (Optional) Open Drizzle Studio
pnpm db:studio
```

### 4. Update shopify.app.toml

Edit `apps/shopify-admin/shopify.app.toml`:
- Set `client_id` to your Shopify app client ID
- Set `dev_store_url` to your dev store domain

### 5. Start development

```bash
# Start the Shopify admin app (uses Shopify CLI for tunneling)
pnpm dev

# In a separate terminal, start the product sync worker
pnpm --filter @promo/worker-product-sync dev
```

### 6. Build Rust Functions

```bash
# Discount Function
cd extensions/discount-function
cargo build --release --target wasm32-wasi

# Cart Transform Function (Shopify Plus)
cd extensions/cart-transform
cargo build --release --target wasm32-wasi

# Validation Function
cd extensions/cart-validation
cargo build --release --target wasm32-wasi
```

Or use the Shopify CLI to build all extensions:

```bash
pnpm --filter shopify-admin build
```

## Project Structure

```
promo-engine/
├── apps/
│   └── shopify-admin/          → Shopify React Router app (admin dashboard)
│       ├── app/routes/         → React Router routes
│       │   ├── app._index.tsx  → Dashboard
│       │   ├── app.offers.tsx  → Offers list with bulk actions
│       │   ├── app.offers.new.tsx → New offer wizard
│       │   ├── app.offers.$id.tsx → Offer detail/edit
│       │   ├── app.offers.$id.preview.tsx → Debug/preview panel
│       │   ├── app.analytics.tsx → Analytics dashboard
│       │   ├── app.settings.tsx  → App settings
│       │   ├── auth.$.tsx      → Shopify OAuth
│       │   └── webhooks.$.tsx  → Webhook handler (products, orders, etc.)
│       ├── app/api/
│       │   └── hono.server.ts  → Hono public API (/evaluate, /analytics, /runtime)
│       └── app/shopify.server.ts → Shopify auth + session storage
├── packages/
│   ├── shared-types/           → Zod schemas + TypeScript types (Result, Money, cart types, evaluation)
│   ├── db/                     → Drizzle ORM schema + client (all 15 tables)
│   ├── rule-engine/            → Cart evaluator, conditions, priority resolver (pure TS, fully tested)
│   └── storefront-runtime/     → Browser JS: cart adapter, event bus, Preact widgets, Web Components
│       └── src/widgets/
│           ├── gift-slider.tsx     → Gift selection popup (Preact)
│           ├── today-offer.tsx     → Floating Today Offer widget (Preact)
│           ├── progress-bar.ts     → Progress bar (Web Component)
│           ├── cart-message.ts     → Cart message (Web Component)
│           └── volume-discount.ts  → Volume discount tiers (Web Component)
├── extensions/
│   ├── discount-function/      → Rust: gift + discount validation at checkout
│   ├── cart-transform/         → Rust: bundle line expansion (Plus — lineUpdate available)
│   ├── cart-validation/        → Rust: gift quantity + tamper detection (5ms budget)
│   ├── checkout-ui/            → React: upsell at checkout (Plus — all surfaces)
│   └── web-pixel/              → Vanilla JS: analytics event collection (Web Worker)
└── workers/
    └── product-sync/           → BullMQ + Redis: product/variant catalog sync
```

## Running Tests

```bash
# Unit tests (rule engine conditions)
pnpm test

# Watch mode
pnpm test:watch

# E2E tests (requires dev store)
cd apps/shopify-admin
cp .env.test.example .env.test
# Edit .env.test with DEV_STORE_URL
pnpm playwright test

# Rust tests for Shopify Functions
cd extensions/discount-function && cargo test
cd extensions/cart-transform && cargo test
cd extensions/cart-validation && cargo test
```

## Key Architecture Decisions

| Decision | Rationale |
|---|---|
| **Rust for all Shopify Functions** | 5ms validation budget requires Rust. Discount Function has 11M instruction budget. JS cannot reliably meet these under load. |
| **Drizzle over Prisma** | Better TypeScript inference, no generate step, lighter runtime. |
| **Hono for public API** | Edge-compatible — can deploy evaluation endpoint to Cloudflare Workers for global sub-50ms latency. |
| **Preact for widgets** | 3 KB vs React's 45 KB. Web Components for stateless widgets (no framework at all). |
| **Result type, no thrown exceptions** | Rule engine is pure — same input always produces same output. Error handling is explicit via Result<T, E>. |
| **Node.js 22 LTS runtime** | Shopify CLI requires Node.js. Bun is only used for asset bundling. |
| **@shopify/polaris (React 18)** | Pragmatic choice for internal app. `@shopify/polaris` React was archived Jan 2026. Migrate to Polaris Web Components as follow-up. |

## Shopify Plus Features Available

- ✅ Cart Transform `lineUpdate` — bundle presentation with title/image overrides
- ✅ Checkout UI Extensions — all steps (info, shipping, payment, thank-you)
- ✅ Post-purchase upsell surface
- ✅ All checkout customization APIs

## Critical Deadlines

- **April 15, 2026**: Shopify Scripts cannot be edited
- **June 30, 2026**: Shopify Scripts stop executing — complete migration before this date

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` | ✅ | From Shopify Partners Dashboard |
| `SHOPIFY_API_SECRET` | ✅ | From Shopify Partners Dashboard |
| `SHOPIFY_APP_URL` | ✅ | Tunnel URL (ngrok/Shopify CLI provides this) |
| `SCOPES` | ✅ | Comma-separated Shopify scopes |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection string |
| `TOKEN_ENCRYPTION_KEY` | ✅ | 32-byte hex key for encrypting access tokens |
| `SENTRY_DSN` | ❌ | Sentry error tracking (optional) |
| `ENABLE_DEBUG_MODE` | ❌ | Enable storefront debug logging |

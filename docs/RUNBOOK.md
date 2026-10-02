# Runbook

Operational procedures for the Promo Engine. Release steps live in `docs/DEPLOY.md`; this file is what you open during an incident or before a high-traffic event.

## Contents

1. [Environments and ownership](#environments-and-ownership)
2. [Cron ownership (D9)](#cron-ownership-d9)
3. [Releasing: HPN first, then Ambrosia](#releasing-hpn-first-then-ambrosia)
4. [Rollback](#rollback)
5. [Migration policy](#migration-policy)
6. [Neon: PITR drill](#neon-pitr-drill)
7. [Prime Day plan](#prime-day-plan)
8. [Alerting setup](#alerting-setup)
9. [Secrets rotation](#secrets-rotation)
10. [Analytics table: index review](#analytics-table-index-review)
11. [Env var reference](#env-var-reference)

## Environments and ownership

| Thing | HPN project | Ambrosia project |
|---|---|---|
| Vercel project | `freebies-app-shopify-admin` | `freebies-app-ambrosia` |
| Shopify app config | `shopify.app.toml` | `shopify.app.ambrosia.toml` |
| Stores | HPN, TRU, hpn-test-store | Ambrosia (**live, Prime Day reference load**) |

Both Vercel projects build the same folder from the same push. Anything that must differ between them is an env var, never a file (see `docs/DEPLOY.md`: no `alias` in any `vercel.json`).

## Cron ownership (D9)

Both projects deploy the same `vercel.json`, so **both** invoke every cron. Each cron route is wrapped in `runCron` (`app/lib/cron-run.server.ts`), which:

1. returns `200 {"skipped":"crons_disabled"}` when the project is not the cron owner (no work, no Sentry check-in);
2. checks `CRON_SECRET`;
3. takes an overlap lock (Redis `SET NX PX`, falling back to a `rate_limits` row; TTL = the route's `maxDuration`), so a slow run or a duplicate Vercel delivery cannot overlap itself. A skipped run returns `{"skipped":"already_running"}`;
4. sends Sentry cron-monitor check-ins `in_progress`, then `ok` or `error` (a 207/`ok:false` partial failure counts as `error`), under the monitor slug `cron-<name>`;
5. reports thrown errors to Sentry through `handleApiError`.

| Cron | Schedule | maxDuration | Monitor slug |
|---|---|---|---|
| `/api/cron/offers` | every 5 min | 300 s | `cron-offers` |
| `/api/cron/catalog-sync` | every minute | 60 s | `cron-catalog-sync` |
| `/api/cron/gift-stock` | every 10 min | 300 s | `cron-gift-stock` |
| `/api/cron/skio-shipping` | every 15 min | 300 s | `cron-skio-shipping` |
| `/api/cron/analytics-cleanup` | daily 03:00 UTC | 60 s | `cron-analytics-cleanup` |

The schedules live in `CRON_JOBS` and `cron-config.test.ts` fails if either `vercel.json` drifts from it. The old `/apps/promo-engine/evaluate` "warm" cron is removed: it sent a GET to a POST-only route (405), so it warmed nothing. Add a cheap DB ping only if measured cold starts hurt.

**Flag semantics.** Unset keeps today's behaviour (crons run) so nothing changes on deploy. Resolution order: `CRONS_ENABLED` (`false`/`0`/`no`/`off` = off, anything else = on) → `CRONS_DISABLED=true` → `DISABLE_CRONS=1` (legacy) → on.

**User action U1 (do in this order):**

1. Confirm both projects point at the **same** Neon database. If they use different databases, each project must run its own crons: set `CRONS_ENABLED=true` on both and skip step 2.
2. On the **HPN** project (`freebies-app-shopify-admin`) set `CRONS_ENABLED=false` (Production scope) and redeploy. Its crons now answer `skipped`.
3. On the **Ambrosia** project set `CRONS_ENABLED=true` (Production scope) so ownership is explicit, and redeploy.
4. Verify in Vercel → each project → Cron Jobs that HPN shows 200 responses with `skipped`, and in Sentry → Crons that `cron-*` monitors check in only from Ambrosia.
5. Optional later change: flip the default to "off when unset" in `cronsEnabled` once both projects have an explicit value.

## Releasing: HPN first, then Ambrosia

HPN (with hpn-test-store) is the canary; Ambrosia is live.

1. Merge to `main`. Both projects build; each runs `scripts/vercel-migrate.mjs` (production only) which applies pending migrations once under the advisory lock. Migrations therefore hit the shared database **before** either project serves the new code, so every migration must be expand-only.
2. Wait for **HPN** Ready. Run `shopify app deploy --config shopify.app.toml` (Functions and theme extension). Smoke-test hpn-test-store: add a gift, change quantities, apply a code, check `/api/health`.
3. Watch Sentry (release = the commit sha) and the cron monitors for 15 minutes. If anything regresses, roll back HPN only; Ambrosia has not changed its extensions yet.
4. Wait for **Ambrosia** Ready, then `shopify app deploy --config shopify.app.ambrosia.toml`. Smoke-test read-only on the live store. Watch Sentry for 30 minutes.

Never run `shopify app deploy` before the Vercel deploy of the same project is Ready: the theme bundle calls the new server API.

### Function config namespace (`promo_engine` -> `$app:promo_engine`)

The Functions' input queries read `function_config` from the app-reserved `$app:promo_engine` namespace (cart-validation's `validation_config` still reads `promo_engine` until `cart-validation.server.ts` also writes `$app:promo_engine`). The publisher writes **both** namespaces (`FUNCTION_CONFIG_NAMESPACES` in `offer-publisher.server.ts`, legacy first because drift detection reads index 0), so:

- Server deployed, Functions not yet: old Functions keep reading `promo_engine`; nothing changes.
- Functions deployed, server not yet: the new Functions read `$app:promo_engine`, which only exists after the shop's first publish by the new server. Shops that were never republished would apply no offers. This is why the release order above (server Ready, then `shopify app deploy`) is mandatory for this release.
- Between the two steps: republish every shop (admin republish, or run `/api/cron/offers`) so each discount node gets the `$app:promo_engine` metafield, and spot-check one node in the Shopify admin (GraphiQL: `discountNode(id) { metafield(namespace: "$app:promo_engine", key: "function_config") { value } }`).
- Rolling the Functions back is safe: the legacy namespace is still written.
- After both deploys are live on every shop (HPN and Ambrosia) and a full republish has run, a later release can remove `"promo_engine"` from `FUNCTION_CONFIG_NAMESPACES` (and move `CONFIG_NAMESPACE` in `discount-reconciliation.server.ts` to the new one). Delete the stale `promo_engine` metafields after that if desired; they are inert.

## Rollback

### Vercel (server code)

- Dashboard → project → Deployments → pick the last good Production deployment → **Instant Rollback** (or CLI: `vercel rollback <deployment-url>`). It is a pointer change, takes seconds and does not rebuild. Roll back the affected project only.
- Instant Rollback pauses auto-promotion of new pushes for that project; promote a fixed deployment (or "Undo rollback") to resume.
- Env var changes need a redeploy to apply; rolling back a deployment keeps the env it was built with. Revert the env change **and** redeploy if the env was the cause.
- **Migrations are not rolled back.** Because migrations are expand-only, the previous release keeps working against the newer schema. Never run a down-migration in production; fix forward with a new expand migration.

### Shopify app versions (Functions, theme extension, toml)

- Every `shopify app deploy` creates an app version. List them in Partner Dashboard → the app → Versions, or run `shopify app versions list --config <toml>`.
- Roll back by releasing the previous version: `shopify app release --version <previous-version> --config shopify.app.toml` (or `shopify.app.ambrosia.toml`). This restores the Function wasm, theme app extension and toml-managed config of that version.
- A Function rollback does **not** revert data: discount-node metafields (`promo_engine/function_config`, `validation_config`) are written by the server on publish. After rolling back Functions across a config-shape change, re-publish the shop's offers (admin → offers → republish, or wait for the 5-minute offers cron to reconcile drift) so the metafield matches the Function again.
- Order when both moved: roll back Vercel first (so the server stops emitting the new config shape), then release the previous Shopify version, then re-publish.

### Decision table

| Symptom | First action |
|---|---|
| 5xx spike right after a Vercel deploy | Instant Rollback that project |
| Wrong discount at checkout after `app deploy` | `shopify app release --version <previous>`, then republish offers |
| Storefront widgets misbehaving, checkout fine | Kill switch `ENABLE_STOREFRONT_RUNTIME=false` or disable the app embed (see Prime Day plan) |
| One bad offer | Pause that offer in the admin (republishes the shop config) |
| Bad migration | Fix forward; do not edit an applied migration file (journal hash check will flag it) |

## Migration policy

Migrations run on every production Vercel build, before the new code is live and while the old code is still serving. They therefore have to be safe for **both** the previous and the next release.

### Mechanics (`packages/db/scripts/migrate-with-lock.ts`)

- Always the **unpooled** URL: `DATABASE_URL_UNPOOLED` is required. There is no fallback to the pooled `DATABASE_URL` (only a localhost database may use it).
- `pg_try_advisory_lock` is polled for up to `MIGRATION_LOCK_WAIT_MS` (120 s) so two concurrent deploys serialize.
- `lock_timeout = 5 s` (`MIGRATION_LOCK_TIMEOUT_MS`): DDL gives up instead of queueing behind a long transaction and blocking every query behind it. `statement_timeout = 120 s` (`MIGRATION_STATEMENT_TIMEOUT_MS`).
- Transient failures (`55P03` lock not available, `57014` statement timeout, deadlock, dropped connection) retry up to 4 times with 2/4/8 s backoff. Drizzle applies all pending files in one transaction, so a retry starts clean. A permanent error fails the build.
- If a migration legitimately needs longer (big index build), run it as a manual one-off script off-peak with a larger `MIGRATION_STATEMENT_TIMEOUT_MS`, not by raising the default.

### Expand / contract

Allowed in a normal migration (**expand**):

- `CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN` that is nullable or has a `DEFAULT`, new enum values, new constraints that are `NOT VALID`.

Not allowed in a normal migration (**contract**), because the previous release still reads and writes them:

- `DROP TABLE`, `DROP COLUMN`, `DROP SCHEMA/TYPE`, `TRUNCATE`
- `RENAME` of a table or column
- `ALTER COLUMN ... SET NOT NULL`, `ALTER COLUMN ... TYPE` (table rewrite)
- `ADD COLUMN ... NOT NULL` without a `DEFAULT`
- `DELETE FROM` without `WHERE`

`scripts/check-migration-safety.mjs` (CI job "TypeScript + Vitest") fails on those in any migration numbered above 0017. To allow one deliberately, put this line in the file: `-- destructive-ok: <why it is safe, and which release already stopped using it>`.

Doing a rename or a drop safely takes releases, not one migration:

1. **Expand** (release N): add the new column/table (nullable or with default). Deploy code that writes **both** and reads the old one.
2. **Backfill** (between N and N+1): copy data in batches from a script (`packages/db/scripts`, dry-run first, `--apply` after), never one huge `UPDATE` inside a migration.
3. **Switch** (release N+1): code reads the new column, still writes both. Verify in production.
4. **Stop writing the old column** (release N+2).
5. **Contract** (release N+3 or later): migration that drops the old column, with the `destructive-ok` marker naming release N+2. Take a Neon branch/PITR marker first.

`SET NOT NULL` on an existing column: add a `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` in a separate statement, then set NOT NULL (cheap once validated) with the marker.

### Verifying the journal against production (read-only)

After a deploy, confirm 0016, 0017 and everything newer is recorded. The `drizzle.__drizzle_migrations` table stores `hash` (sha256 of the SQL file) and `created_at` (the journal's `when`), not the file tag, so the check matches by timestamp.

Preferred, a script that compares the whole journal and the file hashes and exits 1 on a gap (SELECT only, opens the connection with `default_transaction_read_only=on`):

```bash
DATABASE_URL_UNPOOLED='<read-only or normal unpooled url>' \
  pnpm --filter @promo/db exec tsx scripts/verify-migration-journal.ts
```

Manual equivalent:

```sql
select id, hash, created_at, to_timestamp(created_at / 1000.0) as applied_for
from drizzle.__drizzle_migrations
order by created_at desc
limit 10;
```

Compare `created_at` with the `when` values of `0016_discount_codes`, `0017_variant_cache_inventory_tracked` and the newest entries in `packages/db/drizzle/meta/_journal.json`. A missing row means that migration never ran (check the Vercel build log of the production deploy: migrations run only when `VERCEL_ENV=production`). Not yet run against production by WS-E: no read-only database path exists in the repo and agents must not read `.env*`.

## Neon: PITR drill

Do this once before Prime Day and after any plan change (user action U2: confirm the restore window of your Neon plan first; Free is a few hours to 1 day, paid plans up to 7-30 days).

1. Note the Neon project, the production branch and its current restore window (Neon console → Branches → Restore, or Settings → Storage).
2. Pick a restore timestamp 10-15 minutes in the past. Create a **branch from that point in time** (Branches → Create branch → "Past data", timestamp). This never touches production.
3. Get the new branch's connection strings. Run `verify-migration-journal.ts` against it and spot-check row counts: `select count(*) from offers; select count(*) from discount_codes; select max(occurred_at) from analytics_events;`.
4. Point a **Vercel preview** deployment of HPN at the branch (`DATABASE_URL` and `DATABASE_URL_UNPOOLED` as preview-scoped env) and load the admin and `/api/health`. Time every step: that is your real RTO.
5. Delete the drill branch and the preview env vars.

Real recovery: use Neon "Restore" on the production branch to a timestamp (it keeps a backup of the pre-restore state under a new name), then re-point nothing (same endpoint). Afterwards re-run the journal check, run `/api/cron/offers` once, and republish offers for each shop so Shopify metafields match the restored rows. Decide per case whether the restore point predates a webhook-driven change (orders/paid attribution rows will be missing for the gap: reconcile from Shopify).

## Prime Day plan

Reference load: Ambrosia. Capacity estimate behind the numbers: about 1,500 concurrent shoppers x about 6 evaluations per minute is about 9,000 evaluations/min (150 rps). With offer definitions and the shop row cached in Redis for 30 s, one evaluation costs about 3 indexed queries (about 450 qps) and about 25 concurrent function instances at about 150 ms. The shop-wide cap is `EVALUATE_SHOP_LIMIT_PER_MINUTE` (default 12,000/min, 200 rps). Confirm with `scripts/load/evaluate.k6.js` (profile `peak`) against hpn-test-store **before** the event.

### T-7 days

- [ ] Run the k6 `peak` profile against hpn-test-store; p95 < 400 ms through Shopify, error rate < 1%, Neon CPU and connection count comfortable. Adjust `EVALUATE_SHOP_LIMIT_PER_MINUTE` if the measured ceiling differs.
- [ ] Neon: confirm compute autoscaling min/max and the pooler is in use for `DATABASE_URL` (runtime) and the unpooled URL only for migrations. Do the PITR drill.
- [ ] Upstash Redis: confirm the plan covers the command rate (per evaluate: up to 5 rate-limit commands plus 3 cache reads; budget about 10 commands x 150 rps = 1,500 commands/s).
- [ ] Sentry alerts and the `/api/health` uptime monitor are live (see Alerting setup); the cron monitors have checked in for 48 h.
- [ ] `ENABLE_GRAPHQL_CONSOLE` is unset on both projects (U4).
- [ ] Freeze: no deploys and no `shopify app deploy` from T-24 h until the event ends, except rollbacks and kill-switch flips.

### Kill switches

| Switch | Effect | Who flips it | How | Time to effect |
|---|---|---|---|---|
| `ENABLE_STOREFRONT_RUNTIME=false` (Vercel env, Ambrosia project) | `/apps/promo-engine/evaluate` returns an inert result: no gift adds, sliders, banners; zero DB/Redis work. **Checkout discounts keep working** (they run in the Functions). | On-call engineer (primary), engineering lead (backup) | Vercel → project → Settings → Environment Variables → set → Redeploy (or Instant Rollback to a deployment built with it) | one redeploy, about 1-2 min |
| Theme app embed off | The runtime script is not loaded at all | Store owner / merchant admin (Ambrosia), on request from on-call | Online Store → Themes → Customize → App embeds → toggle "Promo Engine" off → Save | immediate, per theme |
| Shadow mode (`shadow_mode.enabled` app setting) | Evaluation still runs, but every cart action, code add/remove and gift slider is suppressed | On-call engineer | `setShadowMode(shopId, true)` (admin settings) | within 30 s (cached) |
| Pause an offer | That offer stops applying in Functions and the storefront | Merchant or on-call via admin | Offer page → Pause (republishes the shop config) | seconds |
| Deactivate the automatic discount nodes | Function discounts stop entirely (last resort, merchant-visible) | Engineering lead with merchant approval | Shopify admin → Discounts → deactivate `promo-engine-*` nodes | immediate |

`ENABLE_WASM_EVALUATOR` appears (empty) in `apps/shopify-admin/.env.production` but **no code reads it**; do not rely on it. The checkout evaluator is the Rust Functions, and the only ways to take it out of the path are pausing offers or deactivating the discount nodes above. Open item for the orchestrator: delete the unused variable from `.env.production` or wire it.

### During the event

- One named on-call per shift (engineering lead assigns; the on-call owns every kill switch above) and one merchant contact for the embed toggle.
- Watch: Sentry (error rate, `cron-*` monitors), Vercel (function errors, duration, concurrency), Neon (connections, CPU, slow queries), Upstash (command rate, errors), `/api/health`.
- Expected under load: some 429s (`RATE_LIMITED`) from a single cart token (a loop) are healthy; sustained shop-wide 429s mean the cap is below real demand: raise `EVALUATE_SHOP_LIMIT_PER_MINUTE` only after checking Neon headroom.
- If Redis is down, evaluation still works (DB fallback), but every request pays the DB cost: expect higher Neon load and watch the shop cap.

### After

- Re-enable anything switched off, remove temporary env changes (with a redeploy), review Sentry and the slow-evaluation logs (`[evaluate] slow ...`), file follow-ups.

## Alerting setup

User action U3. Create in Sentry (org → Alerts), project = shopify-admin:

1. **Error spike**: issue alert, "number of events in an issue is more than 20 in 5 minutes", environment `production`, notify the on-call channel.
2. **New issue in production**: "a new issue is created", environment `production`, low-priority channel.
3. **Cron monitors**: Monitors → Crons shows `cron-offers`, `cron-catalog-sync`, `cron-gift-stock`, `cron-skio-shipping`, `cron-analytics-cleanup`, created automatically from the first check-in (schedule and margins come from the code). Add an alert on each: "missed check-in" and "failed check-in" (2 consecutive, matches `failure_issue_threshold`). Only the cron-owning project checks in; if HPN shows up here, `CRONS_ENABLED=false` is not applied.
4. **Function errors**: Shopify Partner Dashboard → app → Monitoring → Functions: enable email alerts for failed runs for the discount, delivery, validation and transform Functions on both apps. Function failures never reach Sentry.
5. **Uptime**: any uptime monitor (Sentry Uptime, Better Stack, Vercel checks) on `https://freebies-app-ambrosia.vercel.app/api/health` and `https://freebies-app-shopify-admin.vercel.app/api/health`, 1-minute interval, alert after 2 failures.
6. **Vercel**: Settings → Notifications → deployment failed, and Spend/usage alerts.
7. **Neon**: Project → Settings → Notifications for storage/compute limits.

Sentry is initialised with `sendDefaultPii: false` and a `beforeSend` scrubber (`app/lib/sentry-scrub.server.ts`) that strips cookies, auth headers, client IPs, proxy signatures, emails and Shopify tokens.

## Secrets rotation

General rule: add the new value, deploy, verify, remove the old one. Do both Vercel projects. Env var changes need a redeploy.

| Secret | Where | Rotation notes |
|---|---|---|
| `CRON_SECRET` | both Vercel projects | Vercel sends it automatically to cron invocations; change it, redeploy, nothing else to update |
| `SHOPIFY_API_SECRET` (and client id) | per project | Rotate in Partner Dashboard (the old secret stays valid briefly), update the project env, redeploy; app-proxy and webhook HMAC verification use it |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | per project | Reset the Neon role password, update both URLs in both projects, redeploy. Brief errors until the redeploy completes |
| Redis tokens (`UPSTASH_*`, `KV_*`, `REDIS_URL`) | per project | Rotate in Upstash, update, redeploy. Redis failure only degrades to the DB path |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` | per project | DSN is low risk; rotate the auth token (source-map upload) in Sentry settings |
| `TOKEN_ENCRYPTION_KEY` | per project (**must be identical on both if they share a database**) | Needs the versioning design below. Do not just replace the value: every stored Shopify token and Skio key would become undecryptable |

### `TOKEN_ENCRYPTION_KEY` versioning (design, not implemented yet)

Today `token-crypto.server.ts` encrypts with AES-256-GCM using one key, stored as `<iv_hex>:<ciphertext_hex>`, so changing the key strands all existing ciphertext (`decryptToken` would return the raw ciphertext). Proposed design, to implement as one small change:

- Ciphertext format `v<N>:<iv_hex>:<ciphertext_hex>`. The existing unprefixed format is read as `v1`.
- Env: `TOKEN_ENCRYPTION_KEY` is the current key (id from `TOKEN_ENCRYPTION_KEY_ID`, default `1`); `TOKEN_ENCRYPTION_KEY_PREVIOUS` plus `TOKEN_ENCRYPTION_KEY_PREVIOUS_ID` hold the one prior key. `encryptToken` always writes the current id. `decryptToken` picks the key by prefix and tries the other key on an auth-tag failure.
- Re-encryption: a script in `packages/db/scripts` (dry-run first, `--apply` after) walks `shops.access_token_encrypted` and the encrypted `app_settings` rows (Skio API keys, integration credentials), decrypts with whichever key matches and re-writes with the current key, in batches and idempotently (rows already at the current id are skipped).
- Rotation procedure: (1) set `TOKEN_ENCRYPTION_KEY_PREVIOUS` to the old key and `TOKEN_ENCRYPTION_KEY` to the new one, ids bumped, on **both** projects; redeploy. (2) Run the re-encryption script. (3) Verify zero rows still on the old id. (4) Remove `TOKEN_ENCRYPTION_KEY_PREVIOUS`; redeploy. (5) Keep the old key in the password manager for the PITR window: a restore can bring back old-id rows.
- The Redis shop cache (`shop:v1:<domain>`) stores only the ciphertext and expires in 30 s, so it needs no special handling.
- Rotate immediately if the key is ever exposed; until the versioning change ships, the only safe emergency path is: set the new key, then force every merchant to re-authenticate (token exchange re-encrypts on the next load) and re-enter Skio keys.

## Analytics table: index review

`analytics_events` takes every storefront event, so each index is paid for on every insert. Nothing is dropped here: dropping needs evidence from production. Current indexes and what uses them:

| Index | Used by |
|---|---|
| `(shop_id, offer_id, occurred_at)` | offer analytics pages |
| `(shop_id, session_id)` | GDPR lookups by session (`webhooks/gdpr.server.ts`) |
| `(shop_id, event_name, occurred_at)` | dashboards, one-use-per-customer counts |
| `(shop_id, event_name, order_id, occurred_at)` | `DISTINCT ON (order_id)` dashboard dedupe |
| `(order_id)` | order attribution (also covered by the 4-column index only when `shop_id`/`event_name` lead the predicate) |
| `(shop_id, customer_id)` | one-use states, GDPR, order attribution |
| `(occurred_at)` | retention cleanup |
| unique `(deduplication_key)` | idempotent server events |

Candidates to review: `(order_id)` and `(shop_id, session_id)`. Before dropping either, run on production (read-only):

```sql
select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where relname = 'analytics_events'
order by idx_scan;
```

An index with `idx_scan` near zero after at least 30 days of stats (and no remaining query in the code) can go, via a migration with the `destructive-ok` marker.

Ingestion hardening (shipped): stored `properties` are an allowlist of scalar fields (`app/lib/analytics-properties.server.ts`); URLs keep path and `utm_*` only; `customer_id` comes only from the signed app-proxy parameter; the endpoint rate-limits by shop and session, never by IP.

## Env var reference

| Variable | Project | Purpose | Default |
|---|---|---|---|
| `CRONS_ENABLED` | both | `true` on the cron owner (Ambrosia), `false` on the other | unset = crons run |
| `CRONS_DISABLED` / `DISABLE_CRONS` | either | alternative opt-outs | unset |
| `ENABLE_STOREFRONT_RUNTIME` | either | `false` = evaluate returns an inert result | unset = on |
| `EVALUATE_SHOP_LIMIT_PER_MINUTE` | either | shop-wide evaluate cap | 12000 |
| `DB_STATEMENT_TIMEOUT_MS` | either | opt-in startup `statement_timeout` for the app pool (test on a preview first: a transaction-mode pooler may reject startup parameters). Pooler-safe alternative: `ALTER ROLE <app_role> SET statement_timeout = '15s';` run once in Neon | unset = none |
| `DATABASE_URL_UNPOOLED` | both | **required** for migrations | none |
| `MIGRATION_LOCK_TIMEOUT_MS`, `MIGRATION_STATEMENT_TIMEOUT_MS`, `MIGRATION_LOCK_WAIT_MS`, `MIGRATION_ATTEMPTS` | both | migration tuning | 5000, 120000, 120000, 4 |
| `ANALYTICS_RETENTION_DAYS` | either | analytics retention | 90 |
| `ENABLE_GRAPHQL_CONSOLE` | both | must be unset in production (U4) | unset |

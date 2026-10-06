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
12. [Storefront rate limits and code guessing](#storefront-rate-limits-and-code-guessing)
13. [Drift repair pause switch](#drift-repair-pause-switch)
14. [Cart validation and blockOnFailure](#cart-validation-and-blockonfailure)
15. [Load testing](#load-testing)
16. [Live-store E2E](#live-store-e2e)

## Environments and ownership

| Thing | HPN project | Ambrosia project | One Sol project |
|---|---|---|---|
| Vercel project | `freebies-app-shopify-admin` | `freebies-app-ambrosia` | `freebies-app-onesol` |
| Shopify app config | `shopify.app.toml` | `shopify.app.ambrosia.toml` | `shopify.app.onesol.toml` |
| Stores | HPN, TRU, hpn-test-store | Ambrosia (**live, Prime Day reference load**) | One Sol (onesolsupps) |
| Crons | owner (`CRONS_ENABLED=true`) | `CRONS_ENABLED=false` | `CRONS_ENABLED=false` |

Both Vercel projects build the same folder from the same push. Anything that must differ between them is an env var, never a file (see `docs/DEPLOY.md`: no `alias` in any `vercel.json`).

## Cron ownership (D9)

Both projects deploy the same `vercel.json`, so **both** invoke every cron. Each cron route is wrapped in `runCron` (`app/lib/cron-run.server.ts`), which:

1. returns `200 {"skipped":"crons_disabled"}` when the project is not the cron owner (no work, no Sentry check-in);
2. checks `CRON_SECRET`;
3. takes an overlap lock (Redis `SET NX PX`, falling back to a `rate_limits` row; TTL = the route's `maxDuration`), so a slow run or a duplicate Vercel delivery cannot overlap itself. The key is `cron-lock:<VERCEL_PROJECT_ID or CRON_PROJECT or default>:<name>`: the lock is per Vercel project, so a stuck lock in one project never blocks the other, **and it no longer stops both projects from running the same cron at once**. That is why exactly one project must have `CRONS_ENABLED=true`. A skipped run returns `{"skipped":"already_running"}`;
4. sends Sentry cron-monitor check-ins `in_progress`, then `ok` or `error` (a 207/`ok:false` partial failure counts as `error`), under the monitor slug `cron-<name>`;
5. reports thrown errors to Sentry through `handleApiError`.

| Cron | Schedule | maxDuration | Monitor slug |
|---|---|---|---|
| `/api/cron/offers` | every 5 min | 300 s | `cron-offers` |
| `/api/cron/catalog-sync` | every minute | 60 s | `cron-catalog-sync` |
| `/api/cron/gift-stock` | every 10 min | 300 s | `cron-gift-stock` |
| `/api/cron/skio-shipping` | every 15 min | 300 s | `cron-skio-shipping` |
| `/api/cron/analytics-cleanup` | daily 03:00 UTC | 60 s | `cron-analytics-cleanup` |

`catalog-sync` runs two drains (product sync, then the catalog refresh queue) that share one 50 s budget (30 s for the first, the remainder for the second, skipped when none is left), because the route's `maxDuration` is 60 s and a step started near the end still finishes.

The schedules live in `CRON_JOBS` and `cron-config.test.ts` fails if either `vercel.json` drifts from it. The old `/apps/promo-engine/evaluate` "warm" cron is removed: it sent a GET to a POST-only route (405), so it warmed nothing. Add a cheap DB ping only if measured cold starts hurt.

**Flag semantics.** Unset keeps today's behaviour (crons run) so nothing changes on deploy. Resolution order: `CRONS_ENABLED` (`false`/`0`/`no`/`off` = off, anything else = on) → `CRONS_DISABLED=true` → `DISABLE_CRONS=1` (legacy) → on.

**Current state (set 2026-10-02): HPN (`freebies-app-shopify-admin`) owns the crons with `CRONS_ENABLED=true`; Ambrosia has `CRONS_ENABLED=false` (it also carries a legacy `DISABLE_CRONS` from 2026-09-26). Both projects use the same Neon database, so one owner runs every shop's jobs. HPN was kept as owner because it is the arrangement already proven in production. To move ownership, flip both flags and redeploy both projects.**

1. Confirm both projects point at the **same** Neon database. If they use different databases, each project must run its own crons: set `CRONS_ENABLED=true` on both and skip step 2.
2. On the project giving up ownership set `CRONS_ENABLED=false` (Production scope) and redeploy. Its crons now answer `skipped`.
3. On the new owner set `CRONS_ENABLED=true` (Production scope) and redeploy.
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
- The advisory lock belongs to the database connection. A connection-class error (`ECONNRESET`, `57P01`, `08xxx`) drops it and the driver reconnects with a fresh session, so **every retry takes the lock again before migrating** (`runLockedWithRetry` in `migrate-lib.ts`); the lock is released with `pg_advisory_unlock_all()` at the end.
- If a migration legitimately needs longer (big index build), run it as a manual one-off script off-peak with a larger `MIGRATION_STATEMENT_TIMEOUT_MS`, not by raising the default.

### Expand / contract

Allowed in a normal migration (**expand**):

- `CREATE TABLE`, `CREATE INDEX` on a table created in the same file (or `CREATE INDEX CONCURRENTLY`, see below), `ADD COLUMN` that is nullable or has a `DEFAULT`, new enum values, new constraints that are `NOT VALID`.

Not allowed in a normal migration (**contract**), because the previous release still reads and writes them:

- `DROP TABLE`, `DROP COLUMN`, `DROP SCHEMA/TYPE`, `TRUNCATE`
- `RENAME` of a table or column
- `ALTER COLUMN ... SET NOT NULL`, `ALTER COLUMN ... TYPE` (table rewrite)
- `ADD COLUMN ... NOT NULL` without a `DEFAULT`
- `DELETE FROM` or `UPDATE` without `WHERE` (or `WHERE true`): an unbounded backfill
- `CREATE INDEX` without `CONCURRENTLY` on a table the file did not create: it blocks writes for the whole build

`scripts/check-migration-safety.mjs` (CI job "TypeScript + Vitest") fails on those in any migration numbered above 0017. To allow one deliberately, put this line in the file: `-- destructive-ok: <why it is safe, and which release already stopped using it>`. For a reviewed index, `UPDATE` or `DELETE` the narrower `-- backfill-ok: <reason, e.g. offers has 40 rows>` is enough.

### Lock order, index builds and backfills

- **Put exclusive-lock `ALTER`s last.** Drizzle runs all pending files in one transaction, and `ALTER TABLE` takes `ACCESS EXCLUSIVE` on the table until commit. An `ALTER` early in the file holds that lock while every later statement (index builds, backfills) runs, so live traffic on that table stalls for the whole migration. Order each file: new tables and columns, indexes, data statements, and the `ALTER`s that need an exclusive lock (constraints, `SET NOT NULL`, type changes) last, so they hold the lock for milliseconds. `lock_timeout` (5 s) makes the migration fail instead of queueing behind traffic.
- **Split backfills.** Never one `UPDATE` over a large table inside a migration. Ship the column in the migration, then backfill in batches from a script in `packages/db/scripts` (`UPDATE ... WHERE id IN (SELECT id ... LIMIT 1000)` in a loop, dry-run first, `--apply` after), and only then add the constraint in a later migration.
- **Indexes on big tables.** A normal migration cannot `CREATE INDEX CONCURRENTLY` (it cannot run inside a transaction). For a table that is not small, create the index by hand off-peak with `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` (unpooled URL), then ship the migration with `CREATE INDEX IF NOT EXISTS` and a `-- backfill-ok: index already built concurrently` marker so it is a no-op.

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
| Drift repair pause (`DRIFT_REPAIR_DISABLED=true`, or `setDriftRepairPaused(shopId, true)` for one shop) | Stops the 5-minute drift repair from re-activating nodes a merchant switched off and republishing code nodes, which would undo an emergency "deactivate the nodes" within 5 minutes. Detection continues and Sentry gets an info event "Discount drift detected, repair is paused" per shop every 5 minutes. **Pause this before deactivating nodes; unpause when the emergency ends.** | Engineering lead | Vercel env + redeploy (all shops), or the app setting `drift_repair.paused` (one shop). See [Drift repair pause switch](#drift-repair-pause-switch) | one redeploy, or within the next cron run |

`ENABLE_WASM_EVALUATOR` appears (empty) in `apps/shopify-admin/.env.production` but **no code reads it**; do not rely on it. The checkout evaluator is the Rust Functions, and the only ways to take it out of the path are pausing offers or deactivating the discount nodes above. Open item for the orchestrator: delete the unused variable from `.env.production` or wire it.

### During the event

- One named on-call per shift (engineering lead assigns; the on-call owns every kill switch above) and one merchant contact for the embed toggle.
- Watch: Sentry (error rate, `cron-*` monitors), Vercel (function errors, duration, concurrency), Neon (connections, CPU, slow queries), Upstash (command rate, errors), `/api/health`.
- Expected under load: some 429s (`RATE_LIMITED`) from a single cart token (a loop) are healthy; sustained shop-wide 429s mean the cap is below real demand: raise `EVALUATE_SHOP_LIMIT_PER_MINUTE` only after checking Neon headroom.
- If Redis is down, evaluation still works. The shop-wide caps are **skipped** (they would otherwise upsert one hot `rate_limits` row per shop on every request), while the per-cart-token, per-customer and missed-code limits fall back to the database: expect higher Neon load, and no shop-wide shedding until Redis is back. See [Storefront rate limits and code guessing](#storefront-rate-limits-and-code-guessing).

### After

- Re-enable anything switched off, remove temporary env changes (with a redeploy), review Sentry and the slow-evaluation logs (`[evaluate] slow ...`), file follow-ups.

## Alerting setup

User action U3. Create in Sentry (org → Alerts), project = shopify-admin:

1. **Error spike**: issue alert, "number of events in an issue is more than 20 in 5 minutes", environment `production`, notify the on-call channel.
2. **New issue in production**: "a new issue is created", environment `production`, low-priority channel.
3. **Cron monitors**: Monitors → Crons shows `cron-offers`, `cron-catalog-sync`, `cron-gift-stock`, `cron-skio-shipping`, `cron-analytics-cleanup`, created automatically from the first check-in (schedule and margins come from the code). Add an alert on each: "missed check-in" and "failed check-in" (2 consecutive, matches `failure_issue_threshold`). Only the cron-owning project checks in; if Ambrosia shows up here, its `CRONS_ENABLED=false` is not applied.
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
| `CRONS_ENABLED` | both | `true` on the cron owner (HPN), `false` on Ambrosia | unset = crons run |
| `CRONS_DISABLED` / `DISABLE_CRONS` | either | alternative opt-outs | unset |
| `ENABLE_STOREFRONT_RUNTIME` | either | `false` = evaluate returns an inert result | unset = on |
| `EVALUATE_SHOP_LIMIT_PER_MINUTE` | either | shop-wide evaluate cap for callers without a cart token or a prior successful evaluation | 12000 |
| `EVALUATE_KNOWN_SHOP_LIMIT_PER_MINUTE` | either | shop-wide cap for cart tokens that already completed an evaluation | 3x the previous |
| `EVALUATE_CALLER_LIMIT_PER_MINUTE`, `EVALUATE_IP_LIMIT_PER_MINUTE` | either | per cart token / customer, and per IP (direct callers only) | 120, 600 |
| `BUNDLE_SHOP_LIMIT_PER_MINUTE`, `PRODUCT_CUSTOMIZATIONS_SHOP_LIMIT_PER_MINUTE`, `ORDER_ATTRIBUTION_SHOP_LIMIT_PER_MINUTE`, `ANALYTICS_SHOP_LIMIT_PER_MINUTE` | either | shop-wide caps of the other storefront endpoints | 12000, 24000, 3000, 12000 |
| `CODE_MISS_SHOP_LIMIT` | either | missed discount codes per 10 min before the shop's code matching is locked | 500 |
| `CRON_PROJECT` | either | names the project in the cron lock key when `VERCEL_PROJECT_ID` is absent | unset |
| `DRIFT_REPAIR_DISABLED` | either | `true` = drift repair detects and alerts but never repairs | unset |
| `DB_STATEMENT_TIMEOUT_MS` | either | opt-in startup `statement_timeout` for the app pool (test on a preview first: a transaction-mode pooler may reject startup parameters). Pooler-safe alternative: `ALTER ROLE <app_role> SET statement_timeout = '15s';` run once in Neon | unset = none |
| `DATABASE_URL_UNPOOLED` | both | **required** for migrations | none |
| `MIGRATION_LOCK_TIMEOUT_MS`, `MIGRATION_STATEMENT_TIMEOUT_MS`, `MIGRATION_LOCK_WAIT_MS`, `MIGRATION_ATTEMPTS` | both | migration tuning | 5000, 120000, 120000, 4 |
| `ANALYTICS_RETENTION_DAYS` | either | analytics retention | 90 |
| `ENABLE_GRAPHQL_CONSOLE` | both | must be unset in production (U4) | unset |

## Storefront rate limits and code guessing

Every app-proxy endpoint is rate limited by shop-wide counters (Redis fixed window, O(1)) and, for logged-in visitors and cart tokens, per-caller counters. The client IP is never a key behind the proxy (it is Shopify's address).

**Evaluate (`/apps/promo-engine/evaluate`) keeps two shop budgets so anonymous traffic cannot lock real shoppers out.**

- `evaluate:shop:<shop>` (`EVALUATE_SHOP_LIMIT_PER_MINUTE`) counts and sheds callers with no cart token, or a token that has not completed an evaluation yet.
- `evaluate:shop-known:<shop>` (`EVALUATE_KNOWN_SHOP_LIMIT_PER_MINUTE`, default 3x) counts callers whose cart token was marked as seen: after every successful evaluation the token is stored in Redis (`evaluate:seen:<shop>:<token>`, 30 min). Bot traffic can exhaust the first budget; shoppers who already evaluated once keep working on the second.
- Per cart token and per signed customer: `EVALUATE_CALLER_LIMIT_PER_MINUTE` (120/min), on the database when Redis is down.
- A 429 carries `Retry-After` (seconds) with 0 to 10 s of server-side jitter on top of the window remainder, so shed clients do not return on the same tick. Clients should wait at least that long and add their own small jitter and exponential backoff.
- **Redis down:** the shop-wide counters are skipped (`onRedisUnavailable: "skip"`). No shop-wide shedding until Redis is back; the per-caller limits stay on the database.

**Code guessing (the code gate is a guessing oracle).**

- A request that carries discount codes through the app proxy **must** carry `cart.token` (otherwise `400 CART_TOKEN_REQUIRED`). Only 5 distinct codes are looked at per request.
- Misses (codes that exist nowhere in the shop) count against the visitor: `code-miss:<shop>:<cart token | c:<customer> | anon>`, 10 per 10 min. No token falls into the shared `anon` bucket, never "no limit".
- Every miss also counts against `code-miss-shop:<shop>`: `CODE_MISS_SHOP_LIMIT` (500) per 10 min. When it is spent the shop is **locked** for 10 min: every request that carries codes matches nothing (valid codes too, otherwise hits would be distinguishable from misses) and answers 429 `Too many invalid discount codes`. A Sentry warning "Discount code guessing suspected" is raised once per lock. The lock lives in Redis (`code-lock:<shop>`) and in instance memory.
- Responding: check Sentry for the source (cart tokens, timing). A real campaign with a mistyped code can also trip it; shoppers without codes are unaffected. To lift a lock early, delete the Redis key `code-lock:<shopId>` (Upstash console) and `code-miss-shop:<shopId>:*`; otherwise it expires in 10 min. Raise `CODE_MISS_SHOP_LIMIT` only if the traffic is legitimate.

**Other endpoints.** `bundle`, `product-customizations`, `order-attribution` and `analytics` take their shop cap from `<SCOPE>_SHOP_LIMIT_PER_MINUTE` (see the env table), skipped when Redis is down. Analytics also limits per session id for **every** event of a batch (at most 10 distinct sessions per request; events without a session id share one bucket) and stores no client-supplied order id or amount: revenue comes only from the orders/paid webhook.

**`/api/report-error`** requires an App Bridge session token (`Authorization: Bearer <id token>`, verified locally with the app secret: signature, expiry, audience). Its `dest` shop gets a 30/min budget; the 120/min global ceiling stays. Requests without a valid token get 401. The admin ErrorBoundary must send the token (`await shopify.idToken()`).

**Sentry scrubbing** (`app/lib/sentry-scrub.server.ts`): query params whose name ends in `code`, `token` or `email` (case-insensitive) and the signed proxy params are redacted in request URLs, query strings, breadcrumbs and messages; extras with discount-code, token, secret, password or email keys are replaced wholesale.

## Drift repair pause switch

The 5-minute offers cron includes a drift check that repairs discount nodes (re-activates automatic nodes a merchant switched off, republishes code nodes). During an emergency that deliberately deactivates the discount nodes (see Kill switches), repair would undo the switch within five minutes. Pause it first:

- **Every shop:** set `DRIFT_REPAIR_DISABLED=true` on the Vercel project and redeploy. Drift is still detected (Sentry info event "Discount drift detected, repair is paused" per shop every 5 minutes), but nothing is repaired.
- **One shop:** set the app setting `drift_repair.paused` to `true` for that shop (`setDriftRepairPaused(shopId, true)` in `app/lib/drift-repair-settings.server.ts`).
- Remove the pause (and redeploy) when the incident is over, then let the next cron run repair.

## Cart validation and blockOnFailure

The cart-validation Function only blocks placeholder/clone products priced below their minimum. Gift limits, listed variants and offer existence are enforced on the discount side: the discount Function refuses to discount a gift line that breaks them, so it is charged at the variant price like any other line. The validation is registered with `blockOnFailure: false`, so a Function error or instruction overrun never blocks checkout.

Trade-off: if the validation itself fails, a below-minimum placeholder could be bought at its low price. That is accepted because the discount-side caps already prevent free gifts without a valid offer. After a deploy, `validationUpdate` flips existing validations to `false`.

### Function input variables and the `$app:promo_engine` namespace

The Function input variables (`c1` to `c3`, `customerTags`) are now read from `$app:promo_engine`. They live in the same dual-written `function_config` metafield (see [Function config namespace](#function-config-namespace-promo_engine---apppromo_engine)), so the deploy order does not change: **server first, confirm the drift check is clean (no unresolved findings from `/api/cron/offers`), then `shopify app deploy`.** Rolling the Functions back stays safe because the legacy namespace is still written.

## Load testing

`scripts/load/evaluate.k6.js` (profiles `smoke`, `peak`, `soak`) runs **only against hpn-test-store** and goes through the storefront (`https://hpn-test-store.myshopify.com/apps/promo-engine/evaluate`), never the app origin. App-proxy requests need Shopify's signature (`signature`, `timestamp`, `shop`, `logged_in_customer_id` query params, HMAC with the app secret), and **only Shopify's proxy can produce it**: the script therefore cannot sign requests itself. Requesting the app origin directly (`https://freebies-app-shopify-admin.vercel.app/apps/promo-engine/evaluate`) fails signature verification with 401, which would test nothing. Do not copy the app secret into k6 to sign by hand.

Run it from a machine with k6 installed (`winget install k6` / `brew install k6`):

```bash
k6 run -e STORE_URL=https://hpn-test-store.myshopify.com \
       -e VARIANT_IDS=gid://shopify/ProductVariant/<id> \
       -e PROFILE=smoke \
       [-e STORE_COOKIE='storefront_digest=...'] scripts/load/evaluate.k6.js
```

Notes for the run:

- The script mints a fresh random cart token per request, so every request counts against the anonymous shop budget (`EVALUATE_SHOP_LIMIT_PER_MINUTE`, 200 rps at the default): it is the worst case for H6, not the typical one. The known-shopper budget is exercised by repeating a token (`__ITER % 50` cycles are not enough: change the script to reuse the token across iterations to test it).
- 429s now carry a jittered `Retry-After`; the script should not count them as errors above the cap.
- Watch Neon connections/CPU, Upstash command rate (about 4 commands per evaluate now: seen lookup, shop counter, token counter, seen mark), Vercel concurrency and Sentry.

## Live-store E2E

Two layers, both required:

- `ci.yml` job **Browser UI**: `pnpm --filter shopify-admin test:ui`. Real wizard code, stubbed loaders, no secrets. Runs on every push and PR.
- `e2e-live.yml` **Storefront E2E**: buyer flows against `hpn-test-store` (never HPN, TRU, Ambrosia or One Sol). Runs on push to `main`, nightly (05:23 UTC) and `workflow_dispatch` (optional `grep` and `mobile` inputs). It waits for the push's Vercel deployment first because the specs hit the deployed app. Runs queue (`concurrency: e2e-live`): one cart-API budget per IP.

**Fixtures.** The specs need offers that live in the production database under the `hpn-test-store` shop: the 11 `[Ambrosia E2E]` offers, `E2E Gift Offer` (auto-adds a free gift when `test-bundle-product` is added), `E2E Volume Discount` (tiers at 2 and 5 on `test-volume-product`) and `E2E Classic Bundle` (two ebooks, 10% from two items). All are created by `pnpm seed:ambrosia-e2e` and checked by `pnpm verify:ambrosia-e2e`. Both need `DATABASE_URL` and `TOKEN_ENCRYPTION_KEY` and only ever touch `hpn-test-store.myshopify.com`. Run the seed after any reinstall of the test store (a reinstall archives offers).

Global setup probes the live storefront before any spec runs. If a fixture is missing it fails with the repair command instead of dozens of assertion errors.

**GitHub secrets** (environment `e2e`): `DEV_STORE_URL`, `DEV_STORE_PASSWORD`, `APP_URL`, `E2E_PRODUCT_HANDLE`, `E2E_BUNDLE_PRODUCT_HANDLE`, `E2E_VOLUME_PRODUCT_HANDLE`, `E2E_QUALIFYING_VARIANT_ID` (all required). Optional, for a self-healing job that re-seeds each run: `E2E_DATABASE_URL`, `E2E_TOKEN_ENCRYPTION_KEY`. They grant production-database access, so add them only if that trade-off is acceptable; without them the job still runs the probe.

**Bot protection.** Shopify answers bursts of `/cart/*.js` with HTTP 429 and a "Verifying your connection..." page, then keeps the IP blocked for about ten minutes. Measured from a residential IP: four cart calls per second trips it, one call every 2.5 s ran 90 calls clean. `helpers/storefront.ts` spaces cart calls (`E2E_CART_GAP_MS`, default 2000), uses a real Chrome user agent, backs off 10/25/45 s on a 429 and then fails every remaining storefront test immediately with "Shopify bot protection blocked the runner". That is an environment block, not a product failure: wait ten minutes and re-run.

**Widgets.** The test theme has no promo blocks in its templates and the app has no `write_themes` scope, so specs mount the custom elements the block liquid would render (`helpers/widgets.ts`) and drive them through the real `/apps/promo-engine/*` endpoints. Theme-editor placement of the blocks is merchant configuration and is not covered.

**Admin lifecycle suite** (`offer-lifecycle.spec.ts`, `pnpm --filter shopify-admin test:e2e:admin`). The embedded app answers **410 Gone** to any request made outside the Shopify admin iframe, so `APP_URL/app/...` can never authenticate in a headless runner, and a stored cookie jar does not change that. Running it needs a logged-in admin session (`E2E_ADMIN_STORAGE_STATE`, base64 of a Playwright storage state) and specs that drive `https://admin.shopify.com/store/<shop>/apps/<app>/app/...` through the app iframe. That rewrite has not been done, so the suite is not part of any CI gate.

## Subscriptions (Skio / selling plans)

- Shopify skips an app discount on selling-plan lines unless the node has `appliesOnSubscription` (default only became true in API 2026-07). Every create/update of every node now sends `appliesOnSubscription` and `appliesOnOneTimePurchase` explicitly. Shared nodes are always true/true (the Function filters per offer through the reward `subscriptionMode`); a per-offer code node only opts out of a type when all its rewards are discounts that exclude it. `recurringCycleLimit` is left at Shopify's default (first billing cycle).
- The drift cron (every 5 min, `purchase_type_mismatch`) reads both flags and republishes a shop whose live node differs from what the last publish recorded in the manifest, so old nodes self-heal.
- Merchant control: "Apply to: One-time purchases / Subscriptions" on the code wizard, discount wizard, upsell wizard and the rewards editor (product and order rewards) maps to `target.subscriptionMode` (`any` | `subscription_only` | `one_time_only`). Order rewards honour it in the Function by excluding lines of the other type from the order-subtotal target.
- Page-origin stamping: lines without `_promo_engine_metadata` are skipped by `onlyMatchedLines` offers. The bridge patches fetch/XHR/form submit/`form.submit()`, and a late stamper (resource-timing observer on /cart/add|update|change) stamps lines that appeared during the page view without metadata via `/cart/change.js`. Lines already in the cart at page load are never relabelled. The app embed targets `body`, so scripts that cache `window.fetch` in the head before it runs are covered only by the late stamper.

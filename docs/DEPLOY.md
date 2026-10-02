# Deploy

## Vercel: two projects, one folder

The GitHub repo is git-connected to two Vercel projects, and **both build from `apps/shopify-admin`**. A push to `main` deploys both.

| Vercel project | Production domain | Shopify app config |
|---|---|---|
| `freebies-app-shopify-admin` | `freebies-app-shopify-admin.vercel.app` | `shopify.app.toml` (promo-engine-hpn: HPN, TRU, hpn-test-store) |
| `freebies-app-ambrosia` | `freebies-app-ambrosia.vercel.app` | `shopify.app.ambrosia.toml` (promo-engine-ambrosia) |

**Never add `"alias"` to `apps/shopify-admin/vercel.json`, or to the root `vercel.json`.** Both projects read the same file. An alias for one project's domain makes the other project fail with *Domain Error: the chosen alias is already in use*. That happened on 2026-06 and again on 2026-10-01. Production domains are assigned only in each project's Settings → Domains. `vercel-config.test.ts` enforces this.

Env vars (Shopify client id/secret, `DATABASE_URL`, `CRON_SECRET`, …) are per project. Set them in both when a new one is added. Both projects run Node 24.x (root `engines`, CI and Vercel agree).

**Crons run in one project only.** Both projects deploy the same `vercel.json`, so the project that is not the owner sets `CRONS_ENABLED=false` (Ambrosia sets `true`). Unset = crons run. Details and the exact steps: `docs/RUNBOOK.md#cron-ownership-d9`. Cron routes need a literal `export const config = { maxDuration: N }` (the Vercel preset parses it statically); `cron-config.test.ts` keeps it in line with `CRON_JOBS`.

`DATABASE_URL_UNPOOLED` is **required** on both projects: migrations never fall back to the pooled URL.

## Order for a release

1. Push to `main`. Each Vercel build runs `scripts/vercel-migrate.mjs` (Drizzle migrations under an advisory lock, `lock_timeout` 5 s, retries on transient errors) before `react-router build`. Migrations therefore apply even if the build later fails, so keep them expand-only; CI blocks `DROP`/`RENAME`/`SET NOT NULL` unless the file carries a `-- destructive-ok: <reason>` marker (policy and the expand/contract recipe: `docs/RUNBOOK.md#migration-policy`).
2. Wait until both Vercel production deploys are Ready. The theme bundle calls the new server API, so the server goes first.
3. Deploy **HPN first, then Ambrosia** (canary order, `docs/RUNBOOK.md#releasing-hpn-first-then-ambrosia`). Run `cd apps/shopify-admin && shopify app deploy --config shopify.app.toml --allow-updates --message "..."`. Then run it again with `--config shopify.app.ambrosia.toml`. Put `~/.cargo/bin` first on PATH, because another cargo on PATH lacks the `wasm32-wasip1` target.
4. Run one-off data scripts dry-run first, then with `--apply`.

## Checks before pushing

- `pnpm exec react-router build` in `apps/shopify-admin`. Vitest runs under Node, so it won't catch Node-only imports (`node:*`) that end up in a client bundle. Only the build does.
- `pnpm test`, `pnpm typecheck`.
- Function wasm must be ≤ 249000 B. The extension build commands enforce it. Input queries must be ≤ complexity 30, and Shopify validates that only at release.

## CI gates (`.github/workflows/ci.yml`)

- `pnpm audit --audit-level=high` (overrides for transitive advisories live in the root `package.json` `pnpm.overrides`; pnpm 9 ignores `pnpm-workspace.yaml` overrides).
- `scripts/check-migration-safety.mjs`: expand-only migrations.
- `scripts/check-function-query-cost.mjs`: every Function `input_query` has cost <= 30 (leaf 1, `__typename` 0, `metafield` 3, `hasTags` 3).
- `scripts/check-wasm-sizes.mjs`: built wasm <= 249000 B. `scripts/check-instruction-budget.sh`: at least one `instruction_budget` Rust test must run.
- `scripts/check-storefront-freshness.mjs`: rebuilds the storefront runtime and fails if the committed `theme-extension/assets/promo-engine.js` differs (fix: `pnpm build:storefront`).
- Load test: `scripts/load/evaluate.k6.js` (hpn-test-store only).

Incidents, rollback, Prime Day, alerting and secrets rotation: `docs/RUNBOOK.md`.

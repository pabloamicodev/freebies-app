# Deploy

## Vercel: two projects, one folder

The GitHub repo is git-connected to three Vercel projects, and **all build from `apps/shopify-admin`**. A push to `main` deploys all three.

| Vercel project | Production domain | Shopify app config |
|---|---|---|
| `freebies-app-shopify-admin` | `freebies-app-shopify-admin.vercel.app` | `shopify.app.toml` (promo-engine-hpn: HPN, TRU, hpn-test-store) |
| `freebies-app-ambrosia` | `freebies-app-ambrosia.vercel.app` | `shopify.app.ambrosia.toml` (promo-engine-ambrosia) |
| `freebies-app-onesol` | `freebies-app-onesol.vercel.app` | `shopify.app.onesol.toml` (promo-engine-onesol: onesolsupps) |

**Never add `"alias"` to `apps/shopify-admin/vercel.json`, or to the root `vercel.json`.** Both projects read the same file. An alias for one project's domain makes the other project fail with *Domain Error: the chosen alias is already in use*. That happened on 2026-06 and again on 2026-10-01. Production domains are assigned only in each project's Settings → Domains. `vercel-config.test.ts` enforces this.

Env vars (Shopify client id/secret, `DATABASE_URL`, `CRON_SECRET`, …) are per project. Set them in both when a new one is added. Both projects run Node 24.x (root `engines`, CI and Vercel agree).

**Crons run in one project only.** Both projects deploy the same `vercel.json`, so HPN (the owner) has `CRONS_ENABLED=true` and Ambrosia has `CRONS_ENABLED=false` (both set 2026-10-02). The code is opt-out: unset = crons run, so both must stay set. Details and the exact steps: `docs/RUNBOOK.md#cron-ownership-d9`. Cron routes need a literal `export const config = { maxDuration: N }` (the Vercel preset parses it statically); `cron-config.test.ts` keeps it in line with `CRON_JOBS`.

`DATABASE_URL_UNPOOLED` is **required** on both projects: migrations never fall back to the pooled URL.

## Order for a release

1. Push to `main`. Each Vercel build runs `scripts/vercel-migrate.mjs` (Drizzle migrations under an advisory lock, `lock_timeout` 5 s, retries on transient errors) before `react-router build`. Migrations therefore apply even if the build later fails, so keep them expand-only; CI blocks `DROP`/`RENAME`/`SET NOT NULL` unless the file carries a `-- destructive-ok: <reason>` marker (policy and the expand/contract recipe: `docs/RUNBOOK.md#migration-policy`).
2. Wait until both Vercel production deploys are Ready. The theme bundle calls the new server API, so the server goes first.
3. Deploy **HPN first, then Ambrosia** (canary order, `docs/RUNBOOK.md#releasing-hpn-first-then-ambrosia`). Run `pnpm deploy:hpn`, then `pnpm deploy:ambrosia` (and `pnpm deploy:onesol`). Each first runs `scripts/write-extension-app-url.mjs`, which bakes that app's `application_url` into the checkout and customer-account extensions (they have no runtime env), then `shopify app deploy --config <toml>`. The committed `app-url.ts` files default to HPN; after deploying another app, `scripts/deploy-app.mjs` restores them afterwards, even if the deploy fails. Put `~/.cargo/bin` first on PATH, because another cargo on PATH lacks the `wasm32-wasip1` target.
4. Run one-off data scripts dry-run first, then with `--apply`.

## Checks before pushing

- `pnpm exec react-router build` in `apps/shopify-admin`. Vitest runs under Node, so it won't catch Node-only imports (`node:*`) that end up in a client bundle. Only the build does.
- `pnpm test`, `pnpm typecheck`.
- Function wasm must be ≤ 249000 B. The extension build commands enforce it. Input queries must be ≤ complexity 30, and Shopify validates that only at release.
- Compact ids (FIX-cap-10): the Functions accept bare numeric ids and full GIDs in every id list. The server emits the compact form per shop, only when `app_settings` `function_compact_ids.enabled` = "true" (default off; env `FUNCTION_COMPACT_IDS=off` forces it off everywhere). Publish, preflight and the shard planner read the same flag, so their byte estimates agree. Deploy order: `shopify app deploy` (Functions) first, then `pnpm tsx scripts/set-function-compact-ids.ts <shop> on` (canary hpn-test-store first) and republish. Republish the shop right after flipping the flag (it is read outside the publish lock, so a publish already running may use the old value). Rollback: `off` and republish. Code-discount pool configs keep full GIDs (still accepted).

- Combination groups (FIX-cap-12): nodes are split by each offer's combination flags (non-combining offers get their own Shopify discount) instead of forcing one node. Default on for every shop; `app_settings` `function_shards.combination_domains` = "false" turns one shop off (`pnpm tsx scripts/set-function-shards.ts <shop> status --domains off`), env `FUNCTION_SHARD_DOMAINS=off` forces it off everywhere (the Diagnostics toggle then refuses to change it). A shop that no longer fits one node cannot go back to one discount until offers are paused. Publish applies each node's combinesWith strict-first: tighten before the config swap, loosen after, folding in the live policy read from Shopify.
- Instruction-aware sharding: the planner also keeps each node under an estimated instruction budget (`NODE_INSTRUCTION_BUDGET` 7,000,000 on a 200-line cart, floor included; Shopify's limit is 11M) and spreads a heavy shop over more nodes. Estimates come from `apps/shopify-admin/app/lib/sync/instruction-estimate.ts` (per offer shape, upper envelope of measurements of the built Function; regenerate with `node scripts/check-function-instructions.mjs --dump-inputs <dir>` then `FUNCTION_RUNNER=<runner> node scripts/calibrate-instruction-estimate.mjs --inputs <dir> --write` after any change to the Rust hot path, and commit the module and `instruction-estimate.measured.json`). It is soft: it never adds a block code. If the budget would need more nodes than the automatic-discount budget allows, the plan falls back to today's byte-only packing and logs `INSTRUCTION_BUDGET_UNREACHABLE` (preflight returns it in `plan.warnings`); a node holding one bundle bigger than the budget logs `INSTRUCTION_BUDGET_EXCEEDED`. Default on for every shop where sharding is on; `app_settings` `function_shards.instruction_budget` = "false" turns one shop off, env `FUNCTION_SHARD_INSTRUCTIONS=off` forces it off everywhere (vitest defaults it off through `FUNCTION_SHARD_INSTRUCTIONS_DEFAULT`, ignored outside tests). Publisher and preflight read it the same way, so their plans match. Rollout: merge, republish the canary hpn-test-store and check the node count and `plan.warnings`, then republish the shops (TRU, Ambrosia, OneSol); more nodes means more automatic discounts, so check `automaticNodeBudget` headroom first. Rollback: flag off (or the env) and republish; nodes already created stay and are reused by the byte planner.

## CI gates (`.github/workflows/ci.yml`)

- `pnpm audit --audit-level=high` (overrides for transitive advisories live in the root `package.json` `pnpm.overrides`; pnpm 9 ignores `pnpm-workspace.yaml` overrides).
- `scripts/check-migration-safety.mjs`: expand-only migrations.
- `scripts/check-function-query-cost.mjs`: every Function `input_query` has cost <= 30 (leaf 1, `__typename` 0, `metafield` 3, `hasTags` 3).
- `scripts/check-wasm-sizes.mjs`: the module the CLI uploads (trampoline included, ~12 KB) must be <= 256 KiB; the build commands keep the pre-trampoline module <= 249000 B. `scripts/check-instruction-budget.sh`: at least one `instruction_budget` Rust test must run.
- `scripts/check-function-instructions.mjs`: runs the built (trampolined) discount, code-discount and delivery-discount modules (the latter against a shipping config derived from each spec) through Shopify's function-runner (v9.2.3) on carts of 1 to 200 lines generated from the anonymized live-config specs in `apps/shopify-admin/extensions/discount-function/src/fixtures/instructions/`, and fails above Shopify's 11,000,000-instruction limit (warns above 8,000,000). Locally: `pnpm shopify:build`, then `FUNCTION_RUNNER=<function-runner> node scripts/check-function-instructions.mjs` (add `--dump-inputs <dir>` to keep the generated inputs, laid out for `compare-function-outputs.mjs --inputs <dir>`, and `--summary` for a spec x size table). The synthetic stress fixture is printed, never enforced. To refresh a spec after a live config change, replace its `config` and keep offer `version` below 2^31 (it is an i32 in the Function: a larger value silently drops the offer).
- `scripts/check-storefront-freshness.mjs`: rebuilds the storefront runtime and fails if the committed `theme-extension/assets/promo-engine.js` differs (fix: `pnpm build:storefront`).
- Load test: `scripts/load/evaluate.k6.js` (hpn-test-store only).

Incidents, rollback, Prime Day, alerting and secrets rotation: `docs/RUNBOOK.md`.

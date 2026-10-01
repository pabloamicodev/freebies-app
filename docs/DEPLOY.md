# Deploy

## Vercel: two projects, one folder

The GitHub repo is git-connected to two Vercel projects, and **both build from `apps/shopify-admin`**. A push to `main` deploys both.

| Vercel project | Production domain | Shopify app config |
|---|---|---|
| `freebies-app-shopify-admin` | `freebies-app-shopify-admin.vercel.app` | `shopify.app.toml` (promo-engine-hpn: HPN, TRU, hpn-test-store) |
| `freebies-app-ambrosia` | `freebies-app-ambrosia.vercel.app` | `shopify.app.ambrosia.toml` (promo-engine-ambrosia) |

**Never add `"alias"` to `apps/shopify-admin/vercel.json`, or to the root `vercel.json`.** Both projects read the same file. An alias for one project's domain makes the other project fail with *Domain Error: the chosen alias is already in use*. That happened on 2026-06 and again on 2026-10-01. Production domains are assigned only in each project's Settings → Domains. `vercel-config.test.ts` enforces this.

Env vars (Shopify client id/secret, `DATABASE_URL`, `CRON_SECRET`, …) are per project. Set them in both when a new one is added.

## Order for a release

1. Push to `main`. Each Vercel build runs `scripts/vercel-migrate.mjs` (Drizzle migrations, with an advisory lock) before `react-router build`. Migrations therefore apply even if the build later fails, so keep them additive.
2. Wait until both Vercel production deploys are Ready. The theme bundle calls the new server API, so the server goes first.
3. Run `cd apps/shopify-admin && shopify app deploy --config shopify.app.toml --allow-updates --message "..."`. Then run it again with `--config shopify.app.ambrosia.toml`. Put `~/.cargo/bin` first on PATH, because another cargo on PATH lacks the `wasm32-wasip1` target.
4. Run one-off data scripts dry-run first, then with `--apply`.

## Checks before pushing

- `pnpm exec react-router build` in `apps/shopify-admin`. Vitest runs under Node, so it won't catch Node-only imports (`node:*`) that end up in a client bundle. Only the build does.
- `pnpm test`, `pnpm typecheck`.
- Function wasm must be ≤ 249000 B. The extension build commands enforce it. Input queries must be ≤ complexity 30, and Shopify validates that only at release.

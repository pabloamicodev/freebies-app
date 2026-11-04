# MCP server (Promo Engine)

`POST /api/mcp` (Streamable HTTP, stateless, JSON responses): read tools for every shop (phase 0/1) and, behind two locks, write tools (phase 3).
Plan: Brain `Repos/freebies-app/PLAN-MCP-SERVER.md`.

## Transport

`@modelcontextprotocol/sdk@1.26.0` (pinned) with `WebStandardStreamableHTTPServerTransport`, stateless, JSON responses,
one server + transport per request. `mcp-handler@1.1.0` was not used: it peers on `next >=13` and pulls redis/commander/chalk,
none of which this React Router app needs. zod 4 works with the SDK (it resolves against the repo's zod 4.6.x).

## Where it runs

The route ships in every build but answers **404 unless `MCP_ENABLED=true`**. Set it only on the HPN Vercel
project (`freebies-app-shopify-admin`). Never add `alias` to a `vercel.json`.

| Env var | Purpose |
|---|---|
| `MCP_ENABLED` | `true` turns the endpoint on. Anything else: 404. |
| `MCP_TOKEN_PEPPER` | 16+ chars. PATs are stored as `sha256(pepper + token)`. Changing it invalidates every PAT. |
| `MCP_PUBLIC_URL` | Optional. Pins the public origin (issuer, OAuth endpoints, `resource_metadata`) when the request host is not the public one. Defaults to the request origin. |
| `MCP_WRITE_SHOPS` | Comma list of myshopify domains that may ever be write-enabled (only `hpn-test-store.myshopify.com`). |
| `MCP_CONFIRM_SECRET` | 32+ chars. HMAC key of the write `confirmToken`s. Missing or short: every write tool (dry runs too) answers `UPSTREAM_UNAVAILABLE`; reads are unaffected. Rotating it only invalidates tokens in flight (5 min). |

Write mode needs both locks: the env list above AND `app_settings` key `mcp.writeMode` = `"write"` for that shop.
`shops_list` and `mcp_whoami` report the mode per shop.

## Auth

Bearer PAT (`pemcp_...`) or OAuth access token (`pemcp_at_...`), tied to an operator (`mcp_operators`) with a role (`viewer|editor|admin`, default `viewer`) and a
shop allow list. Least privilege: an empty allow list sees NO shops; the explicit entry `*` sees all shops; otherwise a list
of `<store>.myshopify.com` domains (lowercased and validated). 90-day maximum expiry (`--ttl-days` 1-90), revocable. Every
auth failure is the same 401. Without a usable `MCP_TOKEN_PEPPER` (16+ chars) the endpoint answers 503 `UPSTREAM_UNAVAILABLE`.
Rate limits: 120/min per IP (`x-vercel-forwarded-for`, then `x-real-ip`, then `x-forwarded-for`), 60/min per operator.

Create the first admin (prints the PAT once; run against the database that serves the endpoint, with the same
`MCP_TOKEN_PEPPER`; do it from a trusted terminal with `--env <file>` pointing at that environment). `--shops` is required:

```
pnpm mcp:operator create --email you@example.com --name "You" --role admin --shops '*'
pnpm mcp:operator list
pnpm mcp:operator revoke --email you@example.com
```

Runbook: rotating `MCP_TOKEN_PEPPER` invalidates every PAT (no pepper versioning). After a rotation, re-issue each PAT with
`pnpm mcp:operator` (`revoke` disables the old operator row, which keeps its email, so `create` the replacement with a new email).

## Connect Claude Code

```
claude mcp add --transport http promo-engine https://freebies-app-shopify-admin.vercel.app/api/mcp \
  --header "Authorization: Bearer pemcp_..."
```

## Connect from claude.ai (OAuth 2.1)

Phase 2. claude.ai discovers everything from the 401 of `/api/mcp` (`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`).

1. claude.ai: Settings > Connectors > Add custom connector, URL `https://freebies-app-shopify-admin.vercel.app/api/mcp`. Leave the OAuth client fields empty (dynamic client registration).
2. claude.ai opens `/mcp/authorize`. Paste your operator PAT (`pemcp_...`, from `pnpm mcp:operator create`), press Continue, check the role and the shops on the consent screen, press Allow.
3. Claude gets an opaque access token (1 h) and a rotating refresh token (30 d). Nothing else to do; reconnect if the PAT is revoked or expires.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` (also `/api/mcp` suffix form) | RFC 9728 |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 (S256 only, public clients) |
| `POST /api/mcp/oauth/register` | RFC 7591 DCR. Redirect URIs: `https://claude.ai/...`, `https://claude.com/...`, `http://localhost[:port]/...`, `http://127.0.0.1[:port]/...` only |
| `GET/POST /mcp/authorize` | PAT paste + consent. PKCE S256 mandatory, `state` passed through, CSRF cookie + Origin check, not frameable |
| `POST /api/mcp/oauth/token` | `authorization_code` (+ PKCE) and `refresh_token` grants |
| `POST /api/mcp/oauth/revoke` | RFC 7009; ends the whole token family |

Rules: codes live 2 minutes and are single use (replaying one revokes the tokens issued from it). Refresh tokens rotate on every
use; presenting an already-used refresh token revokes the whole family. Access and refresh tokens are stored as `sha256(pepper + token)`
in `mcp_credentials` (kind `access`/`refresh`). Each grant is bound to the exact PAT that was pasted: it stops working as soon as that PAT is revoked or expires (or the
operator is disabled), even if the operator has other PATs, so `pnpm mcp:operator revoke` cuts claude.ai off too. A refresh
token replayed within 30 s of its rotation is refused without revoking the family (retry after a lost response); an older
replay revokes it. The consent step keeps the PAT out of the page: it is swapped for a signed (HMAC with the pepper), HttpOnly,
5-minute cookie scoped to `/mcp/authorize`. Registrations are capped at 100/hour deployment-wide on top of the per-IP limit.
The nightly `analytics-cleanup` cron deletes auth codes 1 day past expiry, dead access/refresh tokens after 30 days and
unreferenced clients older than 30 days. Every OAuth endpoint is rate limited per IP and answers 404 without
`MCP_ENABLED=true`. After deploying, smoke test `curl -i <origin>/.well-known/oauth-protected-resource` (React Router serves it; no
`vercel.json` rewrite was added).

## Verify the token encryption key

`pnpm mcp:verify-tokens [--env <file>]` decrypts each shop's stored token and runs `{ shop { myshopifyDomain } }`.
Read-only; prints `<domain> ok|fail` only.

## Contract

Every tool returns `structuredContent` = `{ summary, data, perShop?, links, warnings, nextActions, meta }`
(`lib/mcp/result.server.ts`), shared with the Experiment Engine MCP: `nextActions[].mcp`, refs
`promo:<shopHandle>:<offerId>`, money `{ amount, currency }`, errors `{ code, message, suggestedAction, mcp }`.
Claude joins both MCPs by `shopDomain`; neither calls the other.

## Phase 1 insight tools (read-only, `lib/mcp/tools/register-insights.server.ts`)

| Tool | What it returns |
|---|---|
| `mcp_whoami` | Operator, role, visible shops with `writeMode`. |
| `promo_performance` | Funnel per offer/day/type over up to 90 days from `analytics_events` (shop+offer+time indexes). Rates from summed counts, `null` when the denominator is 0; money per currency, never converted; `dataQuality` lists missing event types. Never returns customer, session, cart or order identifiers. |
| `promo_audit_log` | `audit_logs` newest first (shops/ref/actor/since, keyset cursor), readable before/after, secret and PII keys stripped, emails masked. |
| `promo_health` | Prioritized findings: publish errors, system pauses, `publish_pending`, drift visible from the DB (missing discount nodes, uncompiled or mis-scheduled offers), each with a next read tool. |
| `suggest_promo_tests` | Per shop: active promos with performance, gaps, `experimentDirectory[]` (shop metafield `experiment_engine.directory`), `experimentBindings[]`, and `candidates[]` (TestIdea plus `nextActions` with `mcp: "experiment-engine"`). Does not call the Experiment Engine MCP. |

## Phase 3 write tools (`lib/mcp/tools/register-writes.server.ts`)

Every write calls the `offer-lifecycle.server.ts` service (validate, update, publish, rollback, audit), never SQL on offers.

| Tool | Role | What it does |
|---|---|---|
| `promo_pause` / `promo_resume` | editor | Pause a live offer / resume a paused one (validates, schedule decides active, scheduled or expired). Publish failure rolls the status back. |
| `promo_archive` | admin, destructive | Archive and republish. Max 3 executions a minute. |
| `promos_republish_shop` | admin | Re-publish the shop's config; the dry run shows live offers and bytes vs the 9500 B limit. |
| `promo_duplicate` | editor | Draft copy (no codes, widgets, versions) with a unique name (`name (2)`); `targetShop`, if given, must be the source shop: cross-shop copies are refused (`VALIDATION`) because product, variant and collection ids can't be translated yet. |
| `promo_create_draft_from_template` | editor | v1: clone an existing offer as the template + bounded overrides (`startsAt`, `endsAt`, `excludeUrls` max 100, `pageUrls` max 50, each 300 chars; unknown keys rejected). Overrides are validated against the template in the dry run; if one still fails after the draft exists, the result is the draft plus an `OVERRIDE_FAILED` warning (so an idempotent retry replays it instead of creating a second draft). |
| `promo_set_page_exclude_urls` | editor | Replace `excludeUrls` / `pageUrls` of the Store pages condition (same normalization and limits as the UI). |
| `promo_set_schedule` | editor | `startsAt` / `endsAt` in the shop's timezone (`YYYY-MM-DDTHH:mm`) or an ISO instant. |
| `codes_set_status` | editor | `active` / `disabled` for `ids`, a `batchId` or `all` codes of an offer (max 2000; exhausted codes never change); the snapshot and update run in one transaction, and if the publish fails the statuses are restored and re-synced (the message says whether the re-sync worked). |

Flow (all of them): `dryRun` defaults to `true` and returns the diff plus `meta.confirmToken` (HMAC-SHA256 over tool, canonical args hash,
operator, shop, the offer's `updated_at`, expiry 5 min and a `jti`). Execute with the same arguments plus `dryRun:false` and the token. The token is
single use (the `jti` is claimed in `mcp_call_log.confirm_jti`, unique), tied to the operator, and refused as `CONFIRM_INVALID` / `CONFIRM_EXPIRED` if anything differs.
If the offer changed since the dry run: `STATE_CONFLICT`. `idempotencyKey` (8-128 chars, optional) replays the stored result of an executed call for 24 h
(warning `IDEMPOTENT_REPLAY`); the same key with other arguments is `VALIDATION`; a failed execution frees the key.

Errors added to the shared list: `STATE_CONFLICT`, `PUBLISH_FAILED` (message says whether the change was rolled back; `promo_set_schedule`,
`promo_set_page_exclude_urls` keep the saved change like the admin UI and may pause the offer), plus `CONFIRM_REQUIRED/INVALID/EXPIRED`, `SHOP_READ_ONLY`, `RATE_LIMITED`.

Audit: `audit_logs.performed_by = mcp:<operatorId>`, `after._mcp = { operator, client, tool, requestId }` (+ `reason`). Every call, reads included, writes a
`mcp_call_log` row (operator, tool, shops, outcome, duration, and args through a per-tool allow list: ids, refs, shops, status, dryRun, limits and dates only; free text such as `reason` or `q`, names, URLs and anything keyed like email/phone/code/token is dropped, with the dropped key names kept in `_omitted`). Rate limits per operator per minute: 60 reads, 10 writes (dry runs count), 3 critical executions; override with `MCP_RATE_READS`, `MCP_RATE_WRITES`, `MCP_RATE_CRITICAL` (integer 1-600, invalid values fall back to the default). `RATE_LIMITED` errors carry `retryAfterSeconds`.

Operators: `pnpm mcp:operator list` shows PAT prefix, role, allow list, last used, expiry and TOTP on/off (never secrets). There is no operator screen in the admin UI; the CLI is enough for an internal app.

Optional TOTP (RFC 6238, SHA-1, 6 digits, 30 s, +-1 step) on `/mcp/authorize`: `pnpm mcp:operator totp-enable --email x` stores the secret encrypted with `TOKEN_ENCRYPTION_KEY` (migration 0032) and prints the `otpauth://` URI once; `totp-disable` removes it. While enabled, the authorize review step needs a valid code, and a used step is never accepted again. PAT bearer calls to `/api/mcp` are not affected.

Load check: `scripts/load/mcp.k6.js` (read tools, hpn-test-store only, 2 VUs by default; see its header).
Retention: the daily `analytics-cleanup` cron (`call-log-retention.server.ts`, next to the OAuth cleanup) deletes `mcp_call_log` rows older than 90 days and PATs expired for more than 7 days.

### Enabling writes on hpn-test-store

1. Vercel (HPN project only): set `MCP_WRITE_SHOPS=hpn-test-store.myshopify.com` and `MCP_CONFIRM_SECRET` (32+ random chars), redeploy.
2. In that shop's database, upsert the setting (value is JSON text):
   `INSERT INTO app_settings (shop_id, key, value) SELECT id, 'mcp.writeMode', '"write"' FROM shops WHERE myshopify_domain = 'hpn-test-store.myshopify.com' ON CONFLICT (shop_id, key) DO UPDATE SET value = '"write"';`
   Set it back to `"read_only"` (or delete the row) to lock the shop again; removing the domain from the env also locks it.
3. Give the operator the `editor` (or `admin`) role: `pnpm mcp:operator create ... --role editor --shops '*'`.
4. Test only on offers named `[MCP test] ...`: hpn-test-store shares the app with HPN and TRU. Any other shop answers `SHOP_READ_ONLY` even for admins.

## Resources and prompts (`lib/mcp/resources.server.ts`)

Resources reuse the read tools and the operator shop visibility; an unknown or invisible shop is an error, never data. Template lists only show visible shops.

| URI | Content |
|---|---|
| `shop://{shop}/capacity` | Same as `discount_capacity` for one shop (domain or handle). |
| `promo://{shop}/{offerId}` | Same as `promo_detail`. |
| `docs://offer-types` | Offer and reward types, gift limit semantics (limit = times the gift SET is granted, per gift product, never duplicated on re-qualification), picker vs auto-add. |
| `docs://page-conditions` | Store pages, `excludeUrls` (`!<path>` patterns), template, section, test group. |

Prompts: `promo_weekly_readout` (shops?, lastDays?) -> promos_active, promo_performance, promo_health. `promo_test_ideas` (shop, goal?) -> suggest_promo_tests, then the Experiment Engine MCP experiments_list / results_get, joined by shopDomain. `why_not_applying` (ref, pageUrl) -> page_conditions_explain + promo_detail.

# MCP server (Promo Engine)

`POST /api/mcp` (Streamable HTTP, stateless, JSON responses): every admin capability as a tool (about 100 tools, listed by area in the `docs://tool-catalog` resource). Full access (owner decision 2026-11-13): every authenticated operator can call every tool on every shop they can see, writes execute directly, `dryRun:true` is an optional preview.
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

`MCP_WRITE_SHOPS` and `MCP_CONFIRM_SECRET` are no longer read: there is no per-shop write lock and no confirmToken. They can be removed from Vercel. `mcp.writeMode` rows in `app_settings` are ignored too (`shops_list` and `mcp_whoami` always report `write`).

## Auth

Bearer PAT (`pemcp_...`) or OAuth access token (`pemcp_at_...`), tied to an operator (`mcp_operators`) with a legacy role label (`viewer|editor|admin`, default `viewer`; it gates nothing, every operator can call every tool) and a
shop allow list. Least privilege: an empty allow list sees NO shops; the explicit entry `*` sees all shops; otherwise a list
of `<store>.myshopify.com` domains (lowercased and validated). 90-day maximum expiry (`--ttl-days` 1-90), revocable. Every
auth failure is the same 401. Without a usable `MCP_TOKEN_PEPPER` (16+ chars) the endpoint answers 503 `UPSTREAM_UNAVAILABLE`.
Rate limits: 120/min per IP (`x-vercel-forwarded-for`, then `x-real-ip`, then `x-forwarded-for`), 60/min per operator.

Create the first admin (prints the PAT once; run against the database that serves the endpoint, with the same
`MCP_TOKEN_PEPPER`; do it from a trusted terminal with `--env <file>` pointing at that environment). `--shops` is required:

```
pnpm mcp:operator create --email you@example.com --name "You" --role admin --shops '*'
pnpm mcp:operator list
pnpm mcp:operator rotate --email you@example.com --grace-minutes 60   # new PAT printed once; old PAT (and claude.ai grants bound to it) expire after the grace, default 60, max 1440
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
2. claude.ai opens `/mcp/authorize`. Paste your operator PAT (`pemcp_...`, from `pnpm mcp:operator create`), press Continue, check the shops on the consent screen, press Allow.
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
| `mcp_whoami` | Operator, visible shops (writeMode is always `write`). |
| `mcp_call_log_query` `{ operatorEmail?, tool?, outcome?, since?, until?, limit = 50 (max 200), cursor? }` | Read rate class, any operator. Rows of `mcp_call_log`, newest first with a keyset cursor: id, time, operator id and name (the email filters but is never returned), tool, shops, outcome, duration and `args` exactly as redacted at write time. `result_ref`, idempotency keys and confirm jtis are never returned. |
| `promo_performance` | Funnel per offer/day/type over up to 90 days from `analytics_events` (shop+offer+time indexes). Rates from summed counts, `null` when the denominator is 0; money per currency, never converted; `dataQuality` lists missing event types. Never returns customer, session, cart or order identifiers. |
| `promo_audit_log` | `audit_logs` newest first (shops/ref/actor/since, keyset cursor), readable before/after, secret and PII keys stripped, emails masked. |
| `promo_health` | Prioritized findings: publish errors, system pauses, `publish_pending`, drift visible from the DB (missing discount nodes, uncompiled or mis-scheduled offers), each with a next read tool. |
| `suggest_promo_tests` | Per shop: active promos with performance, gaps, `experimentDirectory[]` (shop metafield `experiment_engine.directory`), `experimentBindings[]`, and `candidates[]` (TestIdea plus `nextActions` with `mcp: "experiment-engine"`). Does not call the Experiment Engine MCP. |
| `discount_capacity` `{ shops?, live? }` | Per shop: shared-config bytes against the 9500 B node limit, planned vs allowed cart slots, `blockedBy` (the preflight code the next activation would hit) and `singleShardReason` (`flag_off`, `combination` with `combinationBlockers`, or `budget`). Flag off: one node, `bytesUsed`/`headroom` are that node's. Flag on (sharded): `slots[]` = `{ index, nodeId, bytes, pct, offerCount }` from the plan; `bytesUsed` is the fullest slot, `headroom` is `maxCartSlots * 9500 - sum(slot bytes)` (free bytes across all allowed slots), `nodeCount` counts every slot node plus delivery, and `risk` is `block` only when the preflight is blocked, `warn` when planned slots reach 80 % of `maxCartSlots` or one unsplittable offer fills 80 % of its slot. `live: true` reads every cart node (slot 0 plus shards) and flags `drifted` per node against the hash stored by the last publish. Warnings: `CAPACITY_EXCEEDED` (flag off, over limit), `CAPACITY_<code>` (blocked), `CAPACITY_HIGH`, `CAPACITY_SINGLE_SHARD`, `LIVE_DRIFT`. |

## Phase 3 write tools (`lib/mcp/tools/register-writes.server.ts`)

Every write calls a typed service (`offer-lifecycle.server.ts`, `offer-graph.server.ts` and the per-area services in `lib/`: validate, update, publish, rollback, audit), never SQL on offers. These are the original write tools; the authoring, conditions, rewards, codes, widgets, settings and the rest are in the area sections below and in `docs://tool-catalog`.

| Tool | What it does |
|---|---|
| `promo_pause` / `promo_resume` | Pause a live offer / resume a paused one (validates, schedule decides active, scheduled or expired). Publish failure rolls the status back. |
| `promo_archive` | Archive and republish. Counts as a critical execution (3 a minute). |
| `promos_republish_shop` | Re-publish the shop's config; the dry run shows live offers and bytes vs the 9500 B limit. |
| `promo_duplicate` | Draft copy (no codes, widgets, versions) with a unique name (`name (2)`). With `targetShop` = another shop: both shops must be visible to the operator. Every product, variant and collection GID in conditions, rewards and bundle config/steps/tiers is mapped to the target shop via each shop's offline token: products and collections by handle, variants by SKU (fallback product handle + option values). The dry run returns `data.resourceMapping` (`mapped[]`, `unmatched[]`) and an `UNMATCHED_RESOURCES` warning; pass `expectedUpdatedAt` to refuse the copy with `STATE_CONFLICT` if the source offer changed. Execute always creates a draft, strips unmatched references (review before activating) and lists them in warnings. Gift clone products are never copied: they appear as `gift_clone` unmatched entries to recreate. The audit row is written on the target shop with `sourceShop` / `sourceOfferId`. Shopify read failures while mapping are `UPSTREAM_UNAVAILABLE`. |
| `promo_create_draft_from_template` | Clone an existing offer as the template + bounded overrides (`startsAt`, `endsAt`, `excludeUrls` max 100, `pageUrls` max 50, each 300 chars; unknown keys rejected). Overrides are validated (also in a `dryRun`); if one still fails after the draft exists, the result is the draft plus an `OVERRIDE_FAILED` warning (so an idempotent retry replays it instead of creating a second draft). |
| `promo_set_page_exclude_urls` | Replace `excludeUrls` / `pageUrls` of the Store pages condition (same normalization and limits as the UI). |
| `promo_set_schedule` | `startsAt` / `endsAt` in the shop's timezone (`YYYY-MM-DDTHH:mm`) or an ISO instant. |
| `codes_set_status` | `active` / `disabled` for `ids`, a `batchId` or `all` codes of an offer (max 2000; exhausted codes never change); the snapshot and update run in one transaction, and if the publish fails the statuses are restored and re-synced (the message says whether the re-sync worked). |

### Phase 4.1 critical tools (`lib/mcp/tools/critical-tools.server.ts`)

`destructiveHint`, 3 executions a minute, audited as `mcp:<operatorId>`. Any operator can call them on any visible shop; `dryRun:true` previews (default is to execute) and `idempotencyKey` / `expectedUpdatedAt` apply as for every write.

| Tool | What it does |
|---|---|
| `promos_pause_all` `{ shop, reason }` | `bulkPauseOffers` over every active/scheduled offer of the shop in one publish; `dryRun:true` lists them (first 50). Rolled back if the publish fails. |
| `promo_activate_draft` `{ ref }` | Draft -> live via `activateDraftOffer` (offer-lifecycle): main condition and reward required, `validateActivation`, schedule-aware status (active or scheduled), publish with status rollback, `offer_versions` snapshot, audit `publish`. The admin's advisory theme/Experiment Engine warnings need a shop token and are not run (warning `ADMIN_WARNINGS_NOT_CHECKED`). |
| `codes_create_batch` `{ ref, count <= 500, prefix?, length? }` | `createDiscountCodeBatch` (app-generated codes, unambiguous charset, entropy and uniqueness checks). The response never contains plaintext codes: only the count, the batch id and 3 masked samples; export the batch from the Codes tab in the admin. A live offer is republished; if that fails the batch is removed (codes already on Shopify are disabled) and `PUBLISH_FAILED` is returned. `prefix` is not written to the call log. |
| `codes_delete` `{ ref, ids \| batchId, onlyUnused = true }` | `deleteDiscountCodes`. Dry run returns `matched / deletable / skippedUsed / skippedOnShopify`. Codes still on Shopify (synced or pending) are never deleted (disable them first); with `onlyUnused` redeemed codes are kept too, `onlyUnused:false` deletes them (warning `DELETES_REDEEMED_CODES`). Max 2000 per call. |
| `shop_set_limits_enforced` `{ shop, enforced }` | `setLimitsEnforced` + republish, reverted if the publish fails. Same preconditions as Settings -> Limits: the shop must be in `LIMITS_TOGGLE_SHOPS` (else `VALIDATION`) and, to enable, no limited automatic offers may share a discount title. The usage backfill cannot be verified from the database; the dry run warns `BACKFILL_NOT_VERIFIED`. |
| `drift_repair_settings` `{ shop }` | `repairShopDrift` (`lib/discount-reconciliation.server.ts`), the same per-shop code the `api.cron.offers` drift repair runs. One shop per call. `dryRun:true` only reads Shopify and lists every out-of-sync item (discount node, `function_config` metafield per namespace, purchase-type flags, code counts, cart-validation config, missing manifest) with `current` vs `expected`, `bytesBefore` / `bytesAfter` (after is known when the other namespace copy still holds the expected config, else null), the action, and `wouldWrite` (node reactivation, re-queue of codes deleted on Shopify, one shop publish). Executing reactivates switched-off automatic nodes, re-queues missing codes, republishes and re-checks; the result is `repaired`, `deferred` (publish parked, the cron retries) or `unresolved` (warning `DRIFT_UNRESOLVED`, Sentry alert). Refused with `INVALID_STATE` while repair is paused for the shop (`drift_repair.paused` / `DRIFT_REPAIR_DISABLED`) or when the shop published less than 2 minutes ago. Audit entry `drift_repair` on the shop, `performedBy = mcp:<operatorId>` with `_mcp`. |

Not exposed on purpose: `shopify app deploy`, tokens, `TOKEN_ENCRYPTION_KEY`, deleting shops, `neutralize*` and backfill scripts.

Flow (every write tool, existing and new): the call executes directly. `dryRun:true` returns the full outcome (diff, validation, capacity preflight) without writing; there is no `confirmToken` (one is honoured if sent, never required). `idempotencyKey` (8-128 chars, optional) replays the stored result of an executed call for 24 h (warning `IDEMPOTENT_REPLAY`); the same key with other arguments is `VALIDATION`; a failed execution frees the key. `expectedUpdatedAt` (the `updatedAt` from `promo_detail` or the last result) refuses the write with `STATE_CONFLICT` if the offer changed meanwhile.

Shopify caps: a publish or activation that would exceed a cap (config size about 10 KB per node, 25 automatic discounts, 100 ids per product list) fails with `CAPACITY_LIMIT`; `error.details` has `capacity` (`code`, `offerIds`, `numbers`), `limit` (the cap in plain words) and `workarounds[]` (what the admin capacity modal offers). The offer stays saved as a draft. Apply a workaround with `capacity_incident_apply` or edit the offer, then activate again.

Errors added to the shared list: `STATE_CONFLICT`, `PUBLISH_FAILED` (message says whether the change was rolled back; `promo_set_schedule`,
`promo_set_page_exclude_urls` keep the saved change like the admin UI and may pause the offer), `CAPACITY_LIMIT`, `RATE_LIMITED`. `SHOP_READ_ONLY` and `CONFIRM_REQUIRED/INVALID/EXPIRED` stay in the shared code list for the Experiment Engine MCP but this MCP never returns them.

Audit: `audit_logs.performed_by = mcp:<operatorId>`, `after._mcp = { operator, client, tool, requestId }` (+ `reason`). Every call, reads included, writes a
`mcp_call_log` row (operator, tool, shops, outcome, duration, and args through a per-tool allow list: ids, refs, shops, status, dryRun, limits and dates only; free text such as `reason` or `q`, names, URLs and anything keyed like email/phone/code/token is dropped, with the dropped key names kept in `_omitted`). Rate limits per operator per minute: 60 reads, 10 writes (dry runs count), 3 critical executions; override with `MCP_RATE_READS`, `MCP_RATE_WRITES`, `MCP_RATE_CRITICAL` (integer 1-600, invalid values fall back to the default). `RATE_LIMITED` errors carry `retryAfterSeconds`.

Operators: `pnpm mcp:operator list` shows PAT prefix, legacy role label, allow list, last used, expiry and TOTP on/off (never secrets). There is no operator screen in the admin UI; the CLI is enough for an internal app.

Optional TOTP (RFC 6238, SHA-1, 6 digits, 30 s, +-1 step) on `/mcp/authorize`: `pnpm mcp:operator totp-enable --email x` stores the secret encrypted with `TOKEN_ENCRYPTION_KEY` (migration 0032) and prints the `otpauth://` URI once; `totp-disable` removes it. While enabled, the authorize review step needs a valid code, and a used step is never accepted again. PAT bearer calls to `/api/mcp` are not affected.

Load check: `scripts/load/mcp.k6.js` (read tools, hpn-test-store only, 2 VUs by default; see its header).
Retention: the daily `analytics-cleanup` cron (`call-log-retention.server.ts`, next to the OAuth cleanup) deletes `mcp_call_log` rows older than 90 days and PATs expired for more than 7 days.

### Writes (no per-shop enabling)

Nothing to enable: every shop in the operator's allow list is writable by every operator. The old two-lock setup (`MCP_WRITE_SHOPS` + `mcp.writeMode`, `pnpm mcp:operator write-mode`) and the `MCP_CONFIRM_SECRET` token key are obsolete. The only scoping is the operator's shop allow list (`--shops`); to limit blast radius create the operator with an explicit list, and rotate or revoke the PAT on any doubt (see RUNBOOK, MCP section). Test first on hpn-test-store, on offers named `[MCP test] ...`: it shares the app with HPN and TRU.

## Resources and prompts (`lib/mcp/resources.server.ts`)

Resources reuse the read tools and the operator shop visibility; an unknown or invisible shop is an error, never data. Template lists only show visible shops.

| URI | Content |
|---|---|
| `shop://{shop}/capacity` | Same as `discount_capacity` for one shop (domain or handle). |
| `promo://{shop}/{offerId}` | Same as `promo_detail`. |
| `docs://offer-types` | Offer and reward types, gift limit semantics (limit = times the gift SET is granted, per gift product, never duplicated on re-qualification), picker vs auto-add. |
| `docs://page-conditions` | Store pages, `excludeUrls` (`!<path>` patterns), template, section, test group. |
| `docs://tool-catalog` | Every tool by area (read or write, one line each). Rendered from `TOOL_AREAS`; a test fails if a registered tool is missing or an unknown one is listed. |
| `docs://full-access` | The write model: every operator, every shop, direct writes, `dryRun`, `idempotencyKey`, `expectedUpdatedAt`, `CAPACITY_LIMIT`, audit, what is not exposed, how to roll back. |
| `docs://authoring` | The create-an-offer flow and the OneSol worked example (`promo_create` with `quantityTiers`). |

Prompts: `promo_weekly_readout` (shops?, lastDays?) -> promos_active, promo_performance, promo_health. `promo_test_ideas` (shop, goal?) -> suggest_promo_tests, then the Experiment Engine MCP experiments_list / results_get, joined by shopDomain. `why_not_applying` (ref, pageUrl) -> page_conditions_explain + promo_detail. `create_offer` (shop, request) -> catalog_search, promo_create (draft, `dryRun` optional), promo_preview_cart, promo_set_status active, promo_detail. `rollback_mcp_change` (ref) -> promo_audit_log, pause, restore, verify.

## Error codes

Errors use the contract shared with the Experiment Engine MCP: `code`, `message`, `retryable`, `suggestedAction`, optional `retryAfterSeconds` and `details`. A shop outside the operator allow list is `SHOP_FORBIDDEN`; a Shopify cap is `CAPACITY_LIMIT` (see above). There is no role or write-mode refusal.

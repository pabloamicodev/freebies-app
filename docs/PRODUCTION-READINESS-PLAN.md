# Production readiness plan

Source: the October 2026 production-readiness audit. Nine specialist auditors covered:

- Shopify Admin APIs
- Shopify Functions
- code quality
- the storefront in production
- security
- data and infrastructure
- QA
- admin UX
- performance

Two code reviews also fed into it: one of the own-codes commit `60be3d2`, and one of the Discount Codes wizard.

**Goal:** close 100% of the findings and leave the app ready for production, with Ambrosia live and Prime Day as the reference load.

## Ground rules (every agent)

- Read `CLAUDE.md` and `docs/DEPLOY.md` first. Use `graphify query` for orientation.
- **Never remove an existing feature** to fit a budget. That covers Function query complexity ≤ 30, wasm ≤ 249,000 B, metafield size and bundle gzip ≤ 30 KB. If a budget blocks you, build a separate extension or flow and say so in the report.
- **Only edit files your workstream owns** (see the ownership table). If you need a change in someone else's file, write the exact change in your report and do not make it.
- Do not commit, push or deploy. The orchestrator commits per workstream after the integration gate.
- Never touch `.env*` or `apps/shopify-admin/dryrun-*.mjs`.
- No `alias` in any `vercel.json`. Two Vercel projects build `apps/shopify-admin`.
- Rust budget hygiene:
  - avoid `to_uppercase`, `to_lowercase`, `trim`, `format!`, `eprintln` (ASCII variants are fine);
  - measure each Function: `PATH=$HOME/.cargo/bin:$PATH node ../../../../scripts/build-shopify-function.mjs target/wasm32-wasip1/release/<name>.wasm 249000`.
- Run the tests from the **repo root**:
  - `npx vitest run`
  - `cargo test --release` in every Function you touch
  - `npx tsc --noEmit -p <pkg>`
- Every fix comes with a test that fails without it.
- Changes that alter what a **live** offer does must be listed explicitly in your report. Ambrosia is live.
- Run `graphify update .` at the end.

## Architecture decisions (made by the orchestrator, binding)

**D1. Page-condition semantics, one definition for Rust, TS and delivery.**
- A non-gift line *matches* when its metadata satisfies **all** of the offer's page conditions:
  - `page_url`
  - `specific_link`
  - `utm_parameters`
  - `page_types`
- These line-scope flags resolve at the offer level. If any condition sets them, they apply to the whole offer:
  - `restrictToMatchedLines` (exclude mode)
  - `rejectUnmatchedLines` (reject mode)
- Lines excluded by product rules are ignored in both modes.
- App-added lines (`_promo_engine_line_type` in {gift, upsell}) are exempt from the reject check. They are discounted only if they match.

**D2. Shipping and page conditions.**
- Exclude mode: at least 1 matched non-gift line is required.
- Reject mode: every non-gift line must match.
- Tier thresholds keep counting the whole cart.
- The delivery query adds `promoMetadata` (22 → 23 of 30).

**D3. URL handling.**
- Strip scheme and host only when the value starts with `http://`, `https://` or `//`.
- Query values are percent-decoded and `+` is decoded as a space.
- `utm_*` comparisons are ASCII case-insensitive.
- The compiler stops `encodeURIComponent`-ing UTM values. **Behaviour change for live offers whose values need encoding: list them.**

**D4. Stored line metadata (privacy and line merging).**
- `_promo_page_url` and `_promo_landing_url` keep only:
  - the path;
  - `utm_*` parameters;
  - the specific-link parameter names delivered in the runtime config (default `freegifts_code`).
- Everything else is dropped (`email`, `_kx`, `gclid`, `fbclid`…).
- The visit landing lives in `localStorage` with a 24 h expiry.
- Line updates and migrations never stamp a page.

**D5. Landing and quiz reward abuse.**
- Landing and tagged rewards get a hard unit cap in Rust: the configured `maxQuantity`, otherwise the matched anchor quantity (1:1).
- Quiz bundle prices come from config, never from line properties (`_quiz_target_cents` is advisory only).
- **Behaviour change. Diff Ambrosia's compiled configs and cart outcomes before and after.**

**D6. Gift validation.**
- Drop the exact `offer_version` match.
- A gift line is valid when its `offer_id` and `reward_id` still exist and qualify under the current config.
- A gift line that lost our discount allocation, for example to a non-combinable merchant code, is **not** blocked. It is charged normally.
- Blocking stays only for placeholder or clone products below their minimum price, compared in presentment currency.
- `merchandise` must accept `CustomProduct`. Non-variant lines are ignored, never an error.

**D7. Config fault isolation.**
- Offers are parsed one at a time (`Vec<serde_json::Value>`). A malformed offer is skipped and the others still apply.
- The publisher already validates; this is defence in depth.

**D8. Own discount codes.**
- Backend A stays the default.
- The shipping part of a code offer gets its own delivery code node, gated natively by Shopify. Code hashes leave the shared config, which removes the ~600-code shop-wide publish failure.
- Lock timeouts (55P03) never pause offers: the offer is marked publish-pending and retried in the background, with the cron as backstop.
- orders/paid records the redemption synchronously and publishes in `waitUntil`.
- Mutations are not auto-retried on timeout. Instead the code looks up the result before resending.
- Discount-node lookups use `query:` filters.

**D9. Crons run in exactly one Vercel project.**
- A new env flag `CRONS_ENABLED=true` gates every cron route. Set it on Ambrosia only (user action U1).
- Remove the useless evaluate warm cron. Replace it with a cheap DB ping only if measurements show cold starts hurt.

**D10. Storefront hot path.**
- Cache offer definitions and the shop row in Redis for 30 s, invalidated on publish.
- Rate limits are keyed by shop + cart token + signed customer, never by the app-proxy IP alone.
- The shop evaluate cap is raised to the load-tested capacity.
- `bundle` and `product-customizations` get `s-maxage=30, stale-while-revalidate=60`.

**D11. Single create-offer catalogue.**
- The modal is the source of truth.
- `/app/offers/new` renders the same catalogue: shipping, subscription, codes and booster appear everywhere.

## Phases and gates

### Phase 0: stabilise (1 agent)
The working tree holds the finished Discount Codes wizard plus half-finished fixes from two stopped agents:
- `discount-node.server.ts`
- `shopify-fetch.server.ts` (`ShopifyOutcomeUnknownError`, `retryable`)
- the coded-shipping pool
- migration `0018_discount_code_sync_pending`

One test fails (`discount-node.server.test.ts` → `createOrFindCodeDiscount` recovery).

Finish or revert each partial change so that everything is green and coherent: tsc, vitest, cargo and wasm sizes. Write down which audit items it already closes.

**Gate 0:** green tree, then the orchestrator commits it as the baseline.

### Phase 1: parallel workstreams (7 Sonnet agents, strict file ownership)

#### WS-A1, Functions engineer (discount and code Functions)
**Owns:**
- `extensions/discount-function/**` (except `delivery_discount_logic.rs`)
- `extensions/code-discount-function/**`
- `scripts/build-shopify-function.mjs`
- `scripts/optimize-wasm.mjs`

**Tasks:**
- D1 and D3 in Rust, with the URL parse fix.
- Create `src/page_match.rs`, a shared helper with `line_matches(raw_metadata: Option<&str>, conds)`, used via `#[path]`.
- D5 unit caps and quiz price.
- D7 per-offer isolation.
- Parse `promoMetadata` once per line, not three times (instruction count).
- Fix stop-lower-priority to match TS (TS is the source of truth after WS-D: equal-priority behaviour is decided in WS-D, Rust follows).
- Use `customer_location` with the same source as TS, as decided in WS-D.
- Round fixed amounts per currency, with zero-decimal handling.
- Emit the code-gate accept operation only when the offer's conditions pass.
- Delete the stale root `discount-function/input.graphql`.
- **Golden parity:** a Rust test reads `packages/rule-engine/test-fixtures/parity/*.json`, written by WS-D, and asserts the expected outcomes.
- **Instruction budget:** a test with the full Ambrosia config and 40 stamped lines asserting a runtime bound (`function-runner` if it works locally, otherwise a native timing proxy plus a documented threshold).

#### WS-A2, Functions engineer (delivery, validation, transform)
**Owns:**
- `extensions/delivery-discount-function/**`
- `discount-function/src/delivery_discount_logic.rs`
- `extensions/cart-validation/**`
- `extensions/cart-transform/**`

**Tasks:**
- D2: add `promoMetadata` to the delivery query and use `page_match.rs`. Wait for WS-A1's file and coordinate through the orchestrator.
- Fix JPY and KRW in the delivery subtotal (the minor-unit ratio, the same way `config.rs` does it).
- D6 validation rules, the `CustomProduct` merchandise fix, and the clone minimum price in presentment currency.
- Dedupe the validation config: gift variant ids stored once.
- cart-transform: validate the bundle image URL and components from line properties, and drop invalid ones instead of failing.
- Delivery fixed-amount rounding.

#### WS-B, storefront runtime engineer
**Owns:**
- `packages/storefront-runtime/**`
- `extensions/theme-extension/**`
- `extensions/web-pixel/**`

**Tasks:**
- D4.
- Stamp page metadata on XHR and jQuery adds (a `send` patch for POST `/cart/add`).
- Fix the declined-gift false positive: only count gifts whose add actually succeeded.
- Add a runtime init guard so the script never runs twice.
- Scope `refreshGuard` per request.
- Add an evaluate timeout of 6–8 s and honour `Retry-After`.
- Re-evaluate after a bfcache restore (`pageshow` with `persisted`).
- Set the esbuild target to `es2019`/`safari13`.
- Format currency with `Shopify.locale` or the market locale.
- Localise the aria labels and finish the today-offer dialog's focus trap and Escape handling.
- Fix the XSS: use the quote-escaping `escapeHtml` from `src/html.ts` in `gift-icon.ts` and `today-offer-block.ts`.
- Respect the Customer Privacy API for analytics and pixel tracking.
- Keep focus and scroll in `refreshCartUI`.
- Drop the unused `cart-drawer-integration.ts`, or leave it isolated.
- Rebuild the bundle (≤ 30 KB gzip).

#### WS-C, Shopify Admin API backend engineer
**Owns:**
- `app/lib/discount-node.server.ts`
- `app/lib/discount-codes.server.ts`
- `app/lib/code-*.server.ts`
- `app/lib/shopify-fetch.server.ts`
- `app/lib/sync/offer-publisher.server.ts`
- `app/lib/offer-publish-flow.server.ts`
- `app/lib/webhooks/**`
- `app/routes/webhooks.$.tsx`
- `app/lib/sync/{product,inventory}-sync*`
- `app/lib/discount-reconciliation.server.ts`
- `app/lib/resolve-customer.server.ts`
- `shopify.server.ts`
- `shopify.app*.toml`
- the code-related `packages/db` schema and migrations

**Tasks:**
- D8 in full:
  - a dedicated delivery code node per code offer with shipping;
  - publish-pending on lock timeout;
  - orders/paid with `waitUntil`;
  - mutation outcome-unknown handling with lookup before resend;
  - `query:` filters;
  - quote the `removeRedeemCodes` search terms and confirm the removals;
  - a sync-pending state so codes are never orphaned;
  - skip preflight for generated codes;
  - move hashes to `$app:promo_engine` if the Functions' graphql needs no change, otherwise send the proposal to WS-A1;
  - forbid mixed once-per-customer codes in one node (split or block);
  - count/exists queries and a streamed CSV.
- Code guessing:
  - cap entered codes at 5 per evaluate;
  - rate-limit missed codes;
  - a minimum entropy for batches;
  - warn on typed codes shorter than 6 characters.
- A drift-repair cron step: verify both automatic nodes, their metafields and the code nodes, and repair or alert.
- Move inventory and products webhook work out of the 5 s window: enqueue, coalesce, `variants(first: 5)`.
- Nightly full catalogue reconcile, and check the real query cost (`extensions.cost`).
- Guard `shop/redact` (skip when the shop is active or was reinstalled after the uninstall).
- On reinstall, offer to restore the offers archived at uninstall: a banner plus a one-click restore action.
- `resolveCustomer`: cache failures for 5 s, not 45 s.
- Remove the no-op `customers/update` subscription and the redundant `read_discounts` scope.
- One source for the API version, plus a drift test.
- Real GDPR `customers/data_request`: generate a JSON export, record it in the audit log, and make it downloadable from an admin route (WS-F builds the UI).

#### WS-D, rule-engine and compiler engineer
**Owns:**
- `packages/rule-engine/**`
- `packages/shared-types/**`
- `app/lib/sync/compile-config.ts`
- `app/lib/gift-subconditions.ts`
- `app/lib/subcondition-prefill.ts`
- `app/lib/page-types.ts`
- `app/lib/code-offer-wizard.server.ts`
- `app/lib/offer-summaries.ts`
- `app/lib/offer-condition-defaults.ts`

**Tasks:**
- D1, D3 and D5 on the TS side.
- One compiler helper for the four page condition types, used by both the offer compiler and the shipping compiler. New keys are left out when empty.
- Allow page conditions on shipping offers. The validation lives in `offer-publish-flow.server.ts` (WS-C's file), so hand WS-C the exact hunk.
- Golden parity fixtures in `packages/rule-engine/test-fixtures/parity/*.json`: carts, config and expected per-line outcomes. Cover page types, locale prefixes, URLs nested in queries, UTM encoding and case, both mixed-cart modes, priority stop, customer location, gift and upsell lines.
- Decide and document equal-priority stop behaviour and the `customer_location` source. The rule: match Rust's current checkout behaviour unless it is a bug.
- Fix the `specific_link` evaluator `new URL` relative bug.
- Add `rejectUnmatchedLines` and `restrictToMatchedLines` to `CompiledOfferSchema`.
- Code wizard server:
  - the product cap derived from the real config byte limit, which is per-offer node for code offers;
  - free shipping keeps the page and UTM steps.
- Zod schemas for every `request.json()` / `formData()` payload in `api.*` routes. Provide the schemas in shared-types; WS-E and WS-F wire them.

#### WS-E, platform, SRE and performance engineer
**Owns:**
- `vercel.json`
- `apps/shopify-admin/vercel.json`
- `scripts/**`, except the Function build scripts owned by WS-A1
- `packages/db/scripts/**`
- `packages/db/src/client.ts`
- `app/routes/api.cron.*`
- `app/routes/apps.promo-engine.*`
- `app/lib/promo-evaluation.server.ts`
- `app/lib/offer-definitions.server.ts`
- `app/lib/rate-limit*.ts`
- `app/lib/proxy-rate-limit.server.ts`
- `app/lib/redis.server.ts`
- `app/lib/api-response.server.ts`
- `app/lib/shadow-mode.server.ts`
- `.github/**`
- `eslint.config.ts`
- the root `package.json`
- `docs/DEPLOY.md`
- `docs/RUNBOOK.md` (new)
- the analytics ingestion route

**Tasks:**
- Migrations: `lock_timeout` 5 s and `statement_timeout`, with retry; remove the pooled-URL fallback; a CI guard against destructive DDL; document expand/contract.
- Read-only check of the migration journal against production (`drizzle.__drizzle_migrations` contains 0016, 0017 and 0018 after deploy). Write the query in the runbook and run it only if a read-only DB path is available.
- D9: `CRONS_ENABLED`, `maxDuration` on every cron route, Sentry cron monitors (`withMonitor`), idempotency checks for gift-stock and skio-shipping.
- D10.
- `statement_timeout` on the app pool.
- Code-gate query: replace `selectDistinct` with the `requiresCode` flag.
- Analytics:
  - allowlist the stored properties;
  - stop storing full URLs with queries;
  - review the indexes, documenting before dropping any.
- Make sure `handleApiError` and every cron capture to Sentry. Set `sendDefaultPii: false` and add a `beforeSend` scrubber.
- `report-error`: per-shop budget.
- Dependencies: `pnpm.overrides` brace-expansion ≥ 2.1.7, plus a `pnpm audit` gate in CI.
- ESLint: ignore `**/.claude/**`.
- CI:
  - a freshness check that rebuilds `promo-engine.js` and diffs it;
  - a query-complexity lint for every Function `.graphql`;
  - wasm size checks;
  - an instruction-budget test.
- Align Node `engines` with the Vercel projects (24.x).
- A k6 load-test script (`scripts/load/`) against the hpn-test-store deployment.
- Runbook:
  - rollback (Vercel and `shopify app deploy` versions);
  - migration policy;
  - deploying one project first;
  - Neon PITR drill;
  - Prime Day plan with kill switches and who flips them;
  - alerting setup;
  - secrets rotation, with a design for `TOKEN_ENCRYPTION_KEY` versioning;
  - cron ownership.

#### WS-F, admin UX and front-end engineer
**Owns:**
- `app/routes/app.*` except the code-system files owned by WS-C
- `app/components/**`
- `app/styles/**` and the `*.css` files
- `app/root.tsx`

**Tasks:**
- D11 (single catalogue).
- Remove all merchant-visible BOGOS strings and links; hide the migration route from merchants or gate it.
- An unsaved-changes guard (App Bridge `ui-save-bar` or `useBlocker`) on every `app.offers.$id.*` edit route.
- Restyle the root `ErrorBoundary` with navigation and retry.
- Sanitise `error.message` leaks: an allowlist of validation messages plus a generic fallback.
- Non-UUID ids return 404, not 500. Add a shared `parseUuidParam`.
- Confirm archive and delete go through `ConfirmDialog`.
- Accessibility:
  - toasts: success messages use `role=status`/`polite`;
  - wizard fieldsets and legends, with `aria-invalid`/`aria-describedby` on errors;
  - restore `:focus-visible` where `outline: none` is set.
- Raise the loading pill delay and skip it for background fetchers.
- `PageTypesConditionEditor`: require at least 1 page type.
- Wizard copy:
  - UTMs are not secret;
  - which add paths count as "other pages";
  - the free-shipping exclude-mode note;
  - UTM case-insensitivity.
- GDPR export download UI, using WS-C's data.
- Reinstall banner to restore archived offers, using WS-C's action.
- A 375 px pass on the wizards and pickers.

### Phase 2: integration gate (orchestrator)
1. Apply the cross-ownership hunks reported by the agents.
2. Full validation:
   - vitest
   - tsc on all packages
   - eslint
   - cargo test on all 5 Functions
   - wasm sizes
   - complexity count
   - bundle gzip
   - `react-router build`
3. Opus architecture review of the full diff.
4. Fix any regressions.
5. Commit per workstream.

### Phase 3: QA (WS-G, 1–2 Sonnet agents)
- Route-level tests:
  - `api.cron.offers`
  - pause, resume, duplicate, archive and delete, including node and code cleanup
  - import and export
  - reinstall followed by republish
- An Ambrosia compiled-config diff before and after, read-only from the DB. Explain every difference (D3 and D5 are expected).
- The playwright e2e suite against hpn-test-store.
- Deploy to hpn-test-store (Vercel HPN, then `shopify app deploy --config shopify.app.toml`).
- Run the manual matrix with real carts, rate-limited:
  - page types;
  - UTM visit and page scope;
  - both mixed-cart modes;
  - free shipping with page conditions;
  - stacking;
  - priority;
  - gift add, remove and sold-out;
  - schedule and pause;
  - code limits;
  - JPY market if one is configured.
- k6 load test against the HPN deployment.

### Phase 4: release
- Ambrosia: Vercel deploy, then `shopify app deploy --config shopify.app.ambrosia.toml`.
- Smoke test the live store read-only.
- Watch Sentry for 30 minutes.

## User actions (cannot be done by agents)
- **U1.** Set `CRONS_ENABLED=true` on the Ambrosia Vercel project only.
- **U2.** Confirm the Neon PITR window and plan.
- **U3.** Create the Sentry alert rules (error spike, cron monitor missed, function errors) and an uptime monitor on `/api/health`.
- **U4.** Make sure `ENABLE_GRAPHQL_CONSOLE` is unset in production on both projects.
- **U5.** Confirm whether Ambrosia uses POS custom sales or draft custom items. D6 fixes the crash either way, but this sets the priority.
- **U6.** Review the D5 behaviour change (landing gift unit caps) against the merchant's intent.
- **U7.** Reactivate the hpn-test-store offers that were archived by the reinstall, or use the new restore banner.

## Finding → workstream index
| Area | Findings | WS |
|---|---|---|
| Functions | CustomProduct crash, landing/quiz abuse, validation cascade, instruction cost, JPY delivery, version strictness, stacking block, parse isolation, wasm/complexity CI, priority/location parity, rounding, validation dedupe, clone min price, accept op, transform props | A1, A2, D, E |
| Codes (60be3d2) | shared-config hashes, usage limits, inline webhook publish, lock timeout pause, code guessing, removeRedeemCodes, orphan codes, preflight, namespace, once-per-customer, heavy queries, FNV/UTF-8 | C, A1 |
| Codes wizard review | URL parse, missing metadata lines, product cap, Rust/TS combine, UTM encoding/case, per-tab landing, update stamping, privacy, specific_link, a11y, schema | A1, B, D, F |
| Admin API | drift detection, inventory webhooks, mutation retries, node lookup, shop/redact, reinstall archive, catalogue reconcile, query cost, resolveCustomer cache, scopes, API version | C |
| Storefront | line splitting, gift decline, double init, refreshGuard, evaluate timeout, privacy, XHR, refreshCartUI focus, bfcache, per-tab state, esbuild target, cart parsing cost, currency locale, aria, dead file, XSS | B |
| Security | XSS, analytics forgery, GDPR export, GraphQL console, non-UUID 500, report-error, Sentry PII, deps, key rotation | B, E, C, F, U4 |
| Data/infra | migration timeouts, rollback, 0017 journal, cron maxDuration, duplicate crons, warm cron, connections, env parity, retention, Node, Sentry/uptime, logging, PITR, runbook | E, U1–U3 |
| Performance | proxy-IP rate limits, evaluate cap, query count/caching, cache headers, analytics write load, code-gate query, client timeout, customer cache | E, B, C |
| Code quality | brace-expansion, Zod at boundaries, TS/Rust parity test, coverage, giant files (post-launch), dual condition editors (post-launch), `!` assertions, swallowed errors, Sentry capture, eslint worktrees, bundle freshness | D, E, F |
| UX | dual pickers, BOGOS strings, unsaved guards, root error UI, raw errors, a11y, toasts, focus rings, migration page, 375 px | F |
| QA gaps | stacking, config diff, cron/lifecycle tests, express checkout, markets, POS/B2B, import/export, reinstall | G, U5 |

Post-launch refactors, tracked here so they are not lost: a shared wizard scaffold; one condition-editing path (delete the legacy modals); typed offer `target`/`value` JSONB; raising coverage thresholds; splitting the `b-*` CSS from Polaris.

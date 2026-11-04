# MCP server (Promo Engine)

Read-only phase 0: `POST /api/mcp` (Streamable HTTP, stateless, JSON responses) with one tool, `shops_list`.
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

Write mode needs both locks: the env list above AND `app_settings` key `mcp.writeMode` = `"write"` for that shop.
Phase 0 has no write tools; `shops_list` only reports the mode.

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
in `mcp_credentials` (kind `access`/`refresh`). They stop working as soon as the operator has no active PAT (revoked, expired) or is
disabled, so `pnpm mcp:operator revoke` cuts claude.ai off too. Every OAuth endpoint is rate limited per IP and answers 404 without
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

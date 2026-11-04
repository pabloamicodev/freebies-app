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
| `MCP_WRITE_SHOPS` | Comma list of myshopify domains that may ever be write-enabled (only `hpn-test-store.myshopify.com`). |

Write mode needs both locks: the env list above AND `app_settings` key `mcp.writeMode` = `"write"` for that shop.
Phase 0 has no write tools; `shops_list` only reports the mode.

## Auth

Bearer PAT (`pemcp_...`), tied to an operator (`mcp_operators`) with a role (`viewer|editor|admin`, default `viewer`) and a
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

## Verify the token encryption key

`pnpm mcp:verify-tokens [--env <file>]` decrypts each shop's stored token and runs `{ shop { myshopifyDomain } }`.
Read-only; prints `<domain> ok|fail` only.

## Contract

Every tool returns `structuredContent` = `{ summary, data, perShop?, links, warnings, nextActions, meta }`
(`lib/mcp/result.server.ts`), shared with the Experiment Engine MCP: `nextActions[].mcp`, refs
`promo:<shopHandle>:<offerId>`, money `{ amount, currency }`, errors `{ code, message, suggestedAction, mcp }`.
Claude joins both MCPs by `shopDomain`; neither calls the other.

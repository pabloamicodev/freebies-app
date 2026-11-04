import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { mcpCredentials, mcpAuthCodes, mcpOauthClients, type Db } from "@promo/db";
import { createOperatorWithPat, generatePat, hashToken, revokeOperatorCredentials } from "./auth.server.js";
import { handleMcpRequest } from "./handler.server.js";
import {
  handleAuthorize,
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
  handleRegister,
  handleRevoke,
  handleToken,
  type OAuthDeps,
} from "./oauth-http.server.js";
import { pkceChallengeS256 } from "./oauth.server.js";
import { deleteExpiredMcpOauthState } from "./oauth-retention.server.js";
import { createTestDb, seedShop } from "../test-support/pglite-db.js";

const env = { MCP_ENABLED: "true", MCP_TOKEN_PEPPER: "test-pepper-0123456789" } as NodeJS.ProcessEnv;
const ORIGIN = "https://promo.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(50);
const CHALLENGE = pkceChallengeS256(VERIFIER);
let db: Db;
let close: () => Promise<void>;
let clock = new Date("2026-11-04T12:00:00Z");
const ok = async () => ({ ok: true as const });
const deps = (over: Partial<OAuthDeps> = {}): OAuthDeps => ({ db, env, now: () => clock, rateLimit: ok, ...over });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedShop(db, "alpha.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

const form = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const postJson = (url: string, body: unknown) =>
  new Request(`${ORIGIN}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function register(redirectUris = [REDIRECT]): Promise<string> {
  const res = await handleRegister(postJson("/api/mcp/oauth/register", { redirect_uris: redirectUris, client_name: "Claude" }), deps());
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

let seq = 0;
async function newOperator(role: "viewer" | "admin" = "admin") {
  seq += 1;
  return createOperatorWithPat(db, { email: `op${seq}@example.com`, name: `Op ${seq}`, role, shopAllowList: ["*"] }, env, clock);
}

/** Drives GET authorize -> POST review -> POST approve and returns the authorization code. */
async function authorize(clientId: string, pat: string, opts: { redirect?: string; state?: string } = {}): Promise<string> {
  const redirect = opts.redirect ?? REDIRECT;
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: opts.state ?? "st-1",
  };
  const get = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams(params)}`), deps());
  expect(get.status).toBe(200);
  const cookie = get.headers.getSetCookie()[0]!.split(";")[0]!;
  const csrf = cookie.split("=")[1]!;
  const headers = { cookie, origin: ORIGIN };
  const review = await handleAuthorize(form("/mcp/authorize", { ...params, csrf, pat, intent: "review" }, headers), deps());
  expect(review.status).toBe(200);
  const consent = review.headers.getSetCookie().find((c) => c.startsWith("mcp_consent="))!.split(";")[0]!;
  const approve = await handleAuthorize(form("/mcp/authorize", { ...params, csrf, intent: "approve" }, { cookie: `${cookie}; ${consent}`, origin: ORIGIN }), deps());
  expect(approve.status).toBe(303);
  const location = new URL(approve.headers.get("location")!);
  expect(location.searchParams.get("state")).toBe(opts.state ?? "st-1");
  return location.searchParams.get("code")!;
}

const exchange = (clientId: string, code: string, over: Record<string, string> = {}) =>
  handleToken(
    form("/api/mcp/oauth/token", { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...over }),
    deps(),
  );
const refresh = (clientId: string, token: string) =>
  handleToken(form("/api/mcp/oauth/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: token }), deps());
type Tokens = { access_token: string; refresh_token: string; expires_in: number; token_type: string };

describe("metadata", () => {
  it("serves RFC 9728 and RFC 8414 documents with S256 only", async () => {
    const prm = (await handleProtectedResourceMetadata(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), { env }).json()) as Record<string, unknown>;
    expect(prm["resource"]).toBe(`${ORIGIN}/api/mcp`);
    expect(prm["authorization_servers"]).toEqual([ORIGIN]);
    const as = (await handleAuthorizationServerMetadata(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), { env }).json()) as Record<string, unknown>;
    expect(as["issuer"]).toBe(ORIGIN);
    expect(as["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(as["registration_endpoint"]).toBe(`${ORIGIN}/api/mcp/oauth/register`);
    expect(as["token_endpoint"]).toBe(`${ORIGIN}/api/mcp/oauth/token`);
  });
  it("MCP_PUBLIC_URL pins the origin", async () => {
    const res = handleProtectedResourceMetadata(new Request("http://internal/.well-known/oauth-protected-resource"), {
      env: { ...env, MCP_PUBLIC_URL: "https://mcp.example.org/" } as NodeJS.ProcessEnv,
    });
    expect(((await res.json()) as { resource: string }).resource).toBe("https://mcp.example.org/api/mcp");
  });
});

describe("404 when MCP is disabled", () => {
  const off = { MCP_TOKEN_PEPPER: env["MCP_TOKEN_PEPPER"] } as NodeJS.ProcessEnv;
  it("every OAuth surface answers 404", async () => {
    const d = deps({ env: off });
    expect((await handleRegister(postJson("/api/mcp/oauth/register", {}), d)).status).toBe(404);
    expect((await handleToken(form("/api/mcp/oauth/token", {}), d)).status).toBe(404);
    expect((await handleRevoke(form("/api/mcp/oauth/revoke", {}), d)).status).toBe(404);
    expect((await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize`), d)).status).toBe(404);
    expect(handleProtectedResourceMetadata(new Request(`${ORIGIN}/x`), { env: off }).status).toBe(404);
    expect(handleAuthorizationServerMetadata(new Request(`${ORIGIN}/x`), { env: off }).status).toBe(404);
  });
});

describe("dynamic client registration", () => {
  it("accepts claude.ai, claude.com and loopback redirect URIs on any port", async () => {
    for (const uri of [REDIRECT, "https://claude.com/api/mcp/auth_callback", "http://localhost:53682/callback", "http://127.0.0.1:9/cb"]) {
      const res = await handleRegister(postJson("/api/mcp/oauth/register", { redirect_uris: [uri], client_name: "x" }), deps());
      expect(res.status, uri).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["token_endpoint_auth_method"]).toBe("none");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("rejects everything else", async () => {
    for (const uri of [
      "https://evil.example.com/cb",
      "https://claude.ai.evil.com/cb",
      "https://evilclaude.ai/cb",
      "http://claude.ai/cb",
      "https://user@claude.ai/cb",
      "http://localhost.evil.com/cb",
      "javascript:alert(1)",
      "https://claude.ai/cb#frag",
      "not a url",
    ]) {
      const res = await handleRegister(postJson("/api/mcp/oauth/register", { redirect_uris: [uri] }), deps());
      expect(res.status, uri).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
    expect((await handleRegister(postJson("/api/mcp/oauth/register", { redirect_uris: [] }), deps())).status).toBe(400);
    expect((await handleRegister(postJson("/api/mcp/oauth/register", { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }), deps())).status).toBe(400);
  });
  it("is rate limited per IP and refuses oversized bodies", async () => {
    const limited = await handleRegister(postJson("/api/mcp/oauth/register", {}), deps({ rateLimit: async () => ({ ok: false, retryAfterSeconds: 7 }) }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    const big = await handleRegister(postJson("/api/mcp/oauth/register", { redirect_uris: [REDIRECT], client_name: "a".repeat(20_000) }), deps());
    expect(big.status).toBe(400);
  });
});

describe("authorize page", () => {
  it("shows role and visible shops, never redirects an unregistered redirect_uri, and is frame/cache locked", async () => {
    const clientId = await register();
    const { pat } = await newOperator("viewer");
    const params = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s" };
    const get = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams(params)}`), deps());
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(get.headers.getSetCookie()[0]).toMatch(/HttpOnly; SameSite=Strict/);
    const cookie = get.headers.getSetCookie()[0]!.split(";")[0]!;
    const csrf = cookie.split("=")[1]!;
    const review = await (await handleAuthorize(form("/mcp/authorize", { ...params, csrf, pat, intent: "review" }, { cookie, origin: ORIGIN }), deps())).text();
    expect(review).toContain("viewer");
    expect(review).toContain("alpha.myshopify.com");

    const bad = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams({ ...params, redirect_uri: "https://evil.example.com/cb" })}`), deps());
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
  });
  it("requires PKCE S256 (error goes back to the registered redirect)", async () => {
    const clientId = await register();
    const base = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "keep" };
    for (const extra of [{} as Record<string, string>, { code_challenge: CHALLENGE, code_challenge_method: "plain" }, { code_challenge: "short", code_challenge_method: "S256" }]) {
      const res = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams({ ...base, ...extra })}`), deps());
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("state")).toBe("keep");
    }
  });
  it("rejects a POST without a matching CSRF cookie or with a foreign Origin", async () => {
    const clientId = await register();
    const { pat } = await newOperator();
    const params = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s", pat, intent: "approve" };
    const noCookie = await handleAuthorize(form("/mcp/authorize", { ...params, csrf: "abc" }, { origin: ORIGIN }), deps());
    expect(noCookie.status).toBe(400);
    const mismatch = await handleAuthorize(form("/mcp/authorize", { ...params, csrf: "abc" }, { cookie: "mcp_csrf=other", origin: ORIGIN }), deps());
    expect(mismatch.status).toBe(400);
    const foreign = await handleAuthorize(form("/mcp/authorize", { ...params, csrf: "abc" }, { cookie: "mcp_csrf=abc", origin: "https://evil.example.com" }), deps());
    expect(foreign.status).toBe(400);
    expect(await db.select().from(mcpAuthCodes)).toHaveLength(0);
  });
  it("rejects a bad PAT, an access token as PAT, and escapes the client name", async () => {
    const clientId = await register();
    const res0 = await handleRegister(postJson("/api/mcp/oauth/register", { redirect_uris: [REDIRECT], client_name: '<script>alert(1)</script>' }), deps());
    const xssClient = ((await res0.json()) as { client_id: string }).client_id;
    const params = { response_type: "code", client_id: xssClient, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s" };
    const get = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams(params)}`), deps());
    expect(await get.text()).not.toContain("<script>alert");
    const cookie = get.headers.getSetCookie()[0]!.split(";")[0]!;
    const csrf = cookie.split("=")[1]!;
    const bad = await handleAuthorize(form("/mcp/authorize", { ...params, csrf, pat: "pemcp_nope", intent: "review" }, { cookie, origin: ORIGIN }), deps());
    expect(bad.status).toBe(401);

    const { pat } = await newOperator();
    const tokens = (await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens;
    const withAccess = await handleAuthorize(form("/mcp/authorize", { ...params, csrf, pat: tokens.access_token, intent: "review" }, { cookie, origin: ORIGIN }), deps());
    expect(withAccess.status).toBe(401);
  });
  it("is rate limited per IP", async () => {
    const res = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize`), deps({ rateLimit: async () => ({ ok: false, retryAfterSeconds: 3 }) }));
    expect(res.status).toBe(429);
  });
  it("deny returns access_denied with state", async () => {
    const clientId = await register();
    const { pat } = await newOperator();
    const params = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "zz" };
    const get = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams(params)}`), deps());
    const cookie = get.headers.getSetCookie()[0]!.split(";")[0]!;
    const res = await handleAuthorize(form("/mcp/authorize", { ...params, csrf: cookie.split("=")[1]!, pat, intent: "deny" }, { cookie, origin: ORIGIN }), deps());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("zz");
  });
});

describe("authorization code exchange", () => {
  it("PKCE success returns opaque tokens stored hashed, usable as Bearer on /api/mcp", async () => {
    const clientId = await register();
    const { pat, operatorId } = await newOperator();
    const res = await exchange(clientId, await authorize(clientId, pat));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = (await res.json()) as Tokens;
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    const rows = await db.select().from(mcpCredentials).where(eq(mcpCredentials.operatorId, operatorId));
    const stored = rows.map((r) => r.tokenHash);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    const access = rows.find((r) => r.kind === "access")!;
    const refreshRow = rows.find((r) => r.kind === "refresh")!;
    expect(access.expiresAt!.getTime() - clock.getTime()).toBe(3600_000);
    expect(refreshRow.expiresAt!.getTime() - clock.getTime()).toBe(30 * 86_400_000);
    expect(access.familyId).toBe(refreshRow.familyId);

    const mcp = await handleMcpRequest(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      { db, env, now: () => clock, rateLimit: ok },
    );
    expect(mcp.status).toBe(200);
  });
  it("a refresh token is not accepted as a Bearer on /api/mcp", async () => {
    const clientId = await register();
    const { pat } = await newOperator();
    const tokens = (await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens;
    const res = await handleMcpRequest(new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.refresh_token}` } }), { db, env, now: () => clock, rateLimit: ok });
    expect(res.status).toBe(401);
  });
  it("wrong code_verifier fails and burns the code", async () => {
    const clientId = await register();
    const { pat } = await newOperator();
    const code = await authorize(clientId, pat);
    const bad = await exchange(clientId, code, { code_verifier: "w".repeat(50) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await exchange(clientId, code)).status).toBe(400);
  });
  it("wrong redirect_uri or client_id fails", async () => {
    const clientId = await register();
    const other = await register();
    const { pat } = await newOperator();
    expect((await exchange(clientId, await authorize(clientId, pat), { redirect_uri: "https://claude.ai/other" })).status).toBe(400);
    expect((await exchange(other, await authorize(clientId, pat))).status).toBe(400);
    expect((await exchange("mcpc_unknown", await authorize(clientId, pat))).status).toBe(401);
  });
  it("code reuse fails and revokes the tokens issued from it", async () => {
    const clientId = await register();
    const { pat } = await newOperator();
    const code = await authorize(clientId, pat);
    const tokens = (await (await exchange(clientId, code)).json()) as Tokens;
    expect((await exchange(clientId, code)).status).toBe(400);
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(400);
  });
  it("an expired code fails", async () => {
    const clientId = await register();
    const { pat } = await newOperator();
    const code = await authorize(clientId, pat);
    const early = clock;
    clock = new Date(clock.getTime() + 121_000);
    try {
      expect((await exchange(clientId, code)).status).toBe(400);
    } finally {
      clock = early;
    }
  });
  it("rejects unsupported grants and non-form bodies", async () => {
    const clientId = await register();
    const g = await handleToken(form("/api/mcp/oauth/token", { grant_type: "password", client_id: clientId }), deps());
    expect(((await g.json()) as { error: string }).error).toBe("unsupported_grant_type");
    const j = await handleToken(postJson("/api/mcp/oauth/token", { grant_type: "refresh_token" }), deps());
    expect(j.status).toBe(400);
    expect((await handleToken(new Request(`${ORIGIN}/api/mcp/oauth/token`), deps())).status).toBe(405);
  });
});

describe("refresh rotation", () => {
  it("rotates, and reuse of the old refresh token revokes the whole family", async () => {
    const clientId = await register();
    const { pat } = await newOperator();
    const first = (await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens;
    const second = (await (await refresh(clientId, first.refresh_token)).json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    const bearer = (t: string) => new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${t}` } });
    const call = (t: string) => handleMcpRequest(bearer(t), { db, env, now: () => clock, rateLimit: ok });
    expect((await call(second.access_token)).status).not.toBe(401);

    const early = clock;
    clock = new Date(clock.getTime() + 31_000);
    try {
      const replay = await refresh(clientId, first.refresh_token);
      expect(replay.status).toBe(400);
      expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
      expect((await call(second.access_token)).status).toBe(401);
      expect((await refresh(clientId, second.refresh_token)).status).toBe(400);
    } finally {
      clock = early;
    }
  });
  it("a refresh token bound to another client, or expired, fails", async () => {
    const clientId = await register();
    const other = await register();
    const { pat } = await newOperator();
    const t = (await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens;
    expect((await refresh(other, t.refresh_token)).status).toBe(400);
    const early = clock;
    clock = new Date(clock.getTime() + 31 * 86_400_000);
    try {
      expect((await refresh(clientId, t.refresh_token)).status).toBe(400);
    } finally {
      clock = early;
    }
  });
});

describe("PAT revocation cascade", () => {
  it("revoking the operator credentials kills access and refresh tokens", async () => {
    const clientId = await register();
    const { pat, operatorId } = await newOperator();
    const t = (await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens;
    await revokeOperatorCredentials(db, operatorId, clock);
    const res = await handleMcpRequest(new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}` } }), { db, env, now: () => clock, rateLimit: ok });
    expect(res.status).toBe(401);
    expect((await refresh(clientId, t.refresh_token)).status).toBe(400);
  });
  it("revoking only the PAT row also invalidates OAuth tokens", async () => {
    const clientId = await register();
    const { pat, operatorId } = await newOperator();
    const t = (await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens;
    await db.update(mcpCredentials).set({ revokedAt: clock }).where(and(eq(mcpCredentials.operatorId, operatorId), eq(mcpCredentials.kind, "pat")));
    const res = await handleMcpRequest(new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}` } }), { db, env, now: () => clock, rateLimit: ok });
    expect(res.status).toBe(401);
    expect((await refresh(clientId, t.refresh_token)).status).toBe(400);
  });
});

describe("refresh reuse grace window", () => {
  it("a replay within 30 s is refused without revoking the family; an older replay revokes it", async () => {
    const clientId = await register();
    const { pat } = await newOperator();
    const first = (await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens;
    const second = (await (await refresh(clientId, first.refresh_token)).json()) as Tokens;
    const early = clock;
    try {
      clock = new Date(early.getTime() + 10_000);
      const quick = await refresh(clientId, first.refresh_token);
      expect(quick.status).toBe(400);
      expect(((await quick.json()) as { error: string }).error).toBe("invalid_grant");
      const third = await refresh(clientId, second.refresh_token);
      expect(third.status).toBe(200);
      clock = new Date(early.getTime() + 40_000);
      expect((await refresh(clientId, first.refresh_token)).status).toBe(400);
      expect((await refresh(clientId, ((await third.json()) as Tokens).refresh_token)).status).toBe(400);
    } finally {
      clock = early;
    }
  });
});

describe("grants are bound to the pasted PAT", () => {
  async function addPat(operatorId: string): Promise<string> {
    const pat = generatePat();
    const [row] = await db
      .insert(mcpCredentials)
      .values({ operatorId, kind: "pat", tokenHash: hashToken(pat, env), prefix: pat.slice(0, 14), expiresAt: new Date(clock.getTime() + 86_400_000) })
      .returning({ id: mcpCredentials.id });
    patIds.set(pat, row!.id);
    return pat;
  }
  const patIds = new Map<string, string>();
  const callWith = (token: string) =>
    handleMcpRequest(new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}` } }), { db, env, now: () => clock, rateLimit: ok });

  it("revoking PAT-A kills the tokens even while PAT-B is live; PAT-B grants survive", async () => {
    const clientId = await register();
    const { pat: patA, operatorId } = await newOperator();
    const patB = await addPat(operatorId);
    const a = (await (await exchange(clientId, await authorize(clientId, patA))).json()) as Tokens;
    const b = (await (await exchange(clientId, await authorize(clientId, patB))).json()) as Tokens;
    expect((await callWith(a.access_token)).status).not.toBe(401);
    const [rowA] = await db.select().from(mcpCredentials).where(eq(mcpCredentials.tokenHash, hashToken(patA, env)));
    await db.update(mcpCredentials).set({ revokedAt: clock }).where(eq(mcpCredentials.id, rowA!.id));
    expect((await callWith(a.access_token)).status).toBe(401);
    expect((await refresh(clientId, a.refresh_token)).status).toBe(400);
    expect((await callWith(b.access_token)).status).not.toBe(401);
    expect((await refresh(clientId, b.refresh_token)).status).toBe(200);
  });
});

describe("consent cookie", () => {
  async function startReview() {
    const clientId = await register();
    const { pat } = await newOperator();
    const params = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s" };
    const get = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams(params)}`), deps());
    const cookie = get.headers.getSetCookie()[0]!.split(";")[0]!;
    const csrf = cookie.split("=")[1]!;
    const review = await handleAuthorize(form("/mcp/authorize", { ...params, csrf, pat, intent: "review" }, { cookie, origin: ORIGIN }), deps());
    const consent = review.headers.getSetCookie().find((c) => c.startsWith("mcp_consent="))!.split(";")[0]!;
    const approve = (cookies: string) => handleAuthorize(form("/mcp/authorize", { ...params, csrf, intent: "approve" }, { cookie: cookies, origin: ORIGIN }), deps());
    return { cookie, consent, approve };
  }
  it("approve works only with the signed, unexpired cookie", async () => {
    const { cookie, consent, approve } = await startReview();
    expect((await approve(cookie)).status).toBe(400);
    const [body, mac] = consent.slice("mcp_consent=".length).split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), o: "00000000-0000-0000-0000-000000000000" })).toString("base64url");
    expect((await approve(`${cookie}; mcp_consent=${forged}.${mac}`)).status).toBe(400);
    expect((await approve(`${cookie}; mcp_consent=${body}.${mac}x`)).status).toBe(400);
    const early = clock;
    clock = new Date(clock.getTime() + 301_000);
    try {
      expect((await approve(`${cookie}; ${consent}`)).status).toBe(400);
    } finally {
      clock = early;
    }
    expect((await approve(`${cookie}; ${consent}`)).status).toBe(303);
  });
  it("is bound to the CSRF token of the browser session", async () => {
    const { consent, approve } = await startReview();
    expect((await approve(`mcp_csrf=other; ${consent}`)).status).toBe(400);
  });
  it("approve fails if the PAT was revoked while the consent page was open", async () => {
    const { cookie, consent, approve } = await startReview();
    await db.update(mcpCredentials).set({ revokedAt: clock });
    expect((await approve(`${cookie}; ${consent}`)).status).toBe(400);
  });
  it("labels loopback redirects as a program on this computer", async () => {
    const clientId = await register(["http://127.0.0.1:5555/cb"]);
    const { pat } = await newOperator();
    const params = { response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:5555/cb", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s" };
    const get = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams(params)}`), deps());
    const cookie = get.headers.getSetCookie()[0]!.split(";")[0]!;
    const review = await handleAuthorize(form("/mcp/authorize", { ...params, csrf: cookie.split("=")[1]!, pat, intent: "review" }, { cookie, origin: ORIGIN }), deps());
    const html = await review.text();
    expect(html).toContain("http://127.0.0.1:5555/cb");
    expect(html).toContain("a program on this computer");
  });
});

describe("registration global cap and retention", () => {
  it("caps registrations deployment-wide at 100 per hour", async () => {
    const seen: Array<[string, number]> = [];
    const res = await handleRegister(
      postJson("/api/mcp/oauth/register", { redirect_uris: [REDIRECT] }),
      deps({
        hourlyRateLimit: async (key, limit) => {
          seen.push([key, limit]);
          return { ok: false, retryAfterSeconds: 60 };
        },
      }),
    );
    expect(res.status).toBe(429);
    expect(seen).toEqual([["mcp:oauth:register:global", 100]]);
  });
  it("deletes old codes, dead tokens and orphaned clients but keeps live and recent ones", async () => {
    const day = 86_400_000;
    const now = clock;
    const { operatorId } = await newOperator();
    const mk = async (id: string, createdAt: Date) => {
      await db.insert(mcpOauthClients).values({ clientId: id, redirectUris: [REDIRECT], name: id, createdAt });
    };
    await mk("old-orphan", new Date(now.getTime() - 40 * day));
    await mk("old-with-live-token", new Date(now.getTime() - 40 * day));
    await mk("recent-orphan", new Date(now.getTime() - 2 * day));
    const cred = (kind: "access" | "refresh", over: Partial<typeof mcpCredentials.$inferInsert>) =>
      db.insert(mcpCredentials).values({ operatorId, kind, tokenHash: `h-${Math.random()}`, prefix: "p", ...over });
    await cred("access", { clientId: "old-with-live-token", expiresAt: new Date(now.getTime() + day) });
    await cred("access", { expiresAt: new Date(now.getTime() - 31 * day), tokenHash: "dead-expired" });
    await cred("refresh", { revokedAt: new Date(now.getTime() - 31 * day), expiresAt: new Date(now.getTime() + day), tokenHash: "dead-revoked" });
    await cred("refresh", { revokedAt: new Date(now.getTime() - 1 * day), tokenHash: "recently-revoked" });
    const code = (hash: string, expiresAt: Date) =>
      db.insert(mcpAuthCodes).values({ codeHash: hash, operatorId, clientId: "recent-orphan", codeChallenge: CHALLENGE, redirectUri: REDIRECT, expiresAt });
    await code("code-old", new Date(now.getTime() - 2 * day));
    await code("code-fresh", new Date(now.getTime() - 3600_000));

    const result = await deleteExpiredMcpOauthState(db, now);
    expect(result.authCodes).toBe(1);
    expect(result.credentials).toBe(2);
    const clients = (await db.select().from(mcpOauthClients)).map((c) => c.clientId);
    expect(clients).toContain("old-with-live-token");
    expect(clients).toContain("recent-orphan");
    expect(clients).not.toContain("old-orphan");
    const hashes = (await db.select().from(mcpCredentials)).map((c) => c.tokenHash);
    expect(hashes).toContain("recently-revoked");
    expect(hashes).not.toContain("dead-expired");
    expect((await db.select().from(mcpAuthCodes)).map((c) => c.codeHash)).toContain("code-fresh");
    expect((await db.select().from(mcpCredentials)).filter((c) => c.kind === "pat").length).toBeGreaterThan(0);
  });
});

describe("revocation endpoint", () => {
  it("revokes the family, is silent for unknown tokens, and ignores other clients", async () => {
    const clientId = await register();
    const other = await register();
    const { pat } = await newOperator();
    const t = (await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens;
    const revoke = (client: string, token: string) => handleRevoke(form("/api/mcp/oauth/revoke", { client_id: client, token }), deps());
    expect((await revoke(other, t.refresh_token)).status).toBe(200);
    expect((await refresh(clientId, t.refresh_token)).status).toBe(200);
    const t2 = (await (await refresh(clientId, ((await (await exchange(clientId, await authorize(clientId, pat))).json()) as Tokens).refresh_token)).json()) as Tokens;
    expect((await revoke(clientId, "pemcp_rt_unknown")).status).toBe(200);
    expect((await revoke(clientId, t2.refresh_token)).status).toBe(200);
    expect((await refresh(clientId, t2.refresh_token)).status).toBe(400);
  });
});

describe("/api/mcp 401", () => {
  it("carries WWW-Authenticate with resource_metadata", async () => {
    for (const authorization of [undefined, "Bearer pemcp_unknown", "Bearer garbage"]) {
      const res = await handleMcpRequest(
        new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: authorization ? { authorization } : {} }),
        { db, env, now: () => clock, rateLimit: ok },
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
      expect(await res.text()).not.toMatch(/\bat\s.+\.ts/);
    }
  });
});

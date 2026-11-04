import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@promo/db";
import { authenticatePat, type Operator } from "./auth.server.js";
import { mcpEnabled, type RateLimiter } from "./handler.server.js";
import {
  OAuthError,
  exchangeAuthCode,
  getClient,
  isValidCodeChallenge,
  issueAuthCode,
  refreshTokens,
  registerClient,
  revokeOAuthToken,
  type OAuthClient,
} from "./oauth.server.js";
import { visibleShops } from "./shops.server.js";
import { checkRateLimit, getClientIp } from "../rate-limit.server.js";

export type OAuthDeps = {
  db: Db;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  rateLimit?: RateLimiter;
};

const defaultRateLimit: RateLimiter = (key, limit) => checkRateLimit(key, { limit, windowMs: 60_000, onRedisUnavailable: "memory" });

const BASE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };
const MAX_BODY_BYTES = 8192;
const CSRF_COOKIE = "mcp_csrf";

export function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: BASE_HEADERS });
}

/** The public origin of this deployment. MCP_PUBLIC_URL pins it; otherwise the request URL (Vercel sets the real host). */
export function publicOrigin(request: Request, env: NodeJS.ProcessEnv): string {
  const configured = env["MCP_PUBLIC_URL"];
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.origin;
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(request.url).origin;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

function json(status: number, body: unknown, extra: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...extra } });
}

function oauthJsonError(error: OAuthError): Response {
  return json(error.status, { error: error.error, error_description: error.description });
}

type Guard = { ok: true; env: NodeJS.ProcessEnv; now: Date } | { ok: false; response: Response };

/** 404 unless MCP_ENABLED, 503 without a pepper (no DB work), then the per-IP limit (anti PAT brute force). */
async function guard(request: Request, deps: OAuthDeps, bucket: string, limit: number): Promise<Guard> {
  const env = deps.env ?? process.env;
  if (!mcpEnabled(env)) return { ok: false, response: notFound() };
  if ((env["MCP_TOKEN_PEPPER"]?.length ?? 0) < 16) {
    return { ok: false, response: json(503, { error: "temporarily_unavailable", error_description: "MCP not configured" }) };
  }
  const result = await (deps.rateLimit ?? defaultRateLimit)(`mcp:oauth:${bucket}:${getClientIp(request)}`, limit);
  if (!result.ok) {
    return {
      ok: false,
      response: json(429, { error: "rate_limited", error_description: "Too many requests." }, { "Retry-After": String(result.retryAfterSeconds) }),
    };
  }
  return { ok: true, env, now: (deps.now ?? (() => new Date()))() };
}

async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new OAuthError("invalid_request", "Request body too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new OAuthError("invalid_request", "Request body too large.");
  return text;
}

async function readForm(request: Request): Promise<URLSearchParams> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new OAuthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded.");
  }
  return new URLSearchParams(await readBody(request));
}

const methodNotAllowed = (allow: string) => json(405, { error: "invalid_request", error_description: "Method not allowed." }, { Allow: allow });

// ---- metadata (RFC 9728, RFC 8414) ----

const METADATA_HEADERS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" };

export function handleProtectedResourceMetadata(request: Request, deps: Pick<OAuthDeps, "env"> = {}): Response {
  const env = deps.env ?? process.env;
  if (!mcpEnabled(env)) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const origin = publicOrigin(request, env);
  return Response.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
      resource_name: "Promo Engine MCP",
    },
    { headers: METADATA_HEADERS },
  );
}

export function handleAuthorizationServerMetadata(request: Request, deps: Pick<OAuthDeps, "env"> = {}): Response {
  const env = deps.env ?? process.env;
  if (!mcpEnabled(env)) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const origin = publicOrigin(request, env);
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/mcp/authorize`,
      token_endpoint: `${origin}/api/mcp/oauth/token`,
      registration_endpoint: `${origin}/api/mcp/oauth/register`,
      revocation_endpoint: `${origin}/api/mcp/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    },
    { headers: METADATA_HEADERS },
  );
}

// ---- dynamic client registration (RFC 7591) ----

export async function handleRegister(request: Request, deps: OAuthDeps): Promise<Response> {
  const g = await guard(request, deps, "register", 10);
  if (!g.ok) return g.response;
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError("invalid_client_metadata", "Body must be a JSON object.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "Body must be a JSON object.");
    const meta = body as Record<string, unknown>;
    const subsetOf = (value: unknown, allowed: string[]) =>
      value === undefined || (Array.isArray(value) && value.every((v) => typeof v === "string" && allowed.includes(v)));
    if (meta["token_endpoint_auth_method"] !== undefined && meta["token_endpoint_auth_method"] !== "none") {
      throw new OAuthError("invalid_client_metadata", 'Only token_endpoint_auth_method "none" (public client with PKCE) is supported.');
    }
    if (!subsetOf(meta["grant_types"], ["authorization_code", "refresh_token"]) || !subsetOf(meta["response_types"], ["code"])) {
      throw new OAuthError("invalid_client_metadata", "Unsupported grant_types or response_types.");
    }
    const client = await registerClient(deps.db, { redirectUris: meta["redirect_uris"], name: meta["client_name"] });
    return json(201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(g.now.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  } catch (error) {
    if (error instanceof OAuthError) return oauthJsonError(error);
    throw error;
  }
}

// ---- token + revocation ----

export async function handleToken(request: Request, deps: OAuthDeps): Promise<Response> {
  const g = await guard(request, deps, "token", 60);
  if (!g.ok) return g.response;
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    const form = await readForm(request);
    const clientId = form.get("client_id") ?? "";
    if (!(await getClient(deps.db, clientId))) throw new OAuthError("invalid_client", "Unknown client_id.", 401);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const codeVerifier = form.get("code_verifier") ?? "";
      if (!code || !redirectUri || !codeVerifier) throw new OAuthError("invalid_request", "code, redirect_uri and code_verifier are required.");
      return json(200, await exchangeAuthCode(deps.db, g.env, { code, clientId, redirectUri, codeVerifier }, g.now));
    }
    if (grant === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required.");
      return json(200, await refreshTokens(deps.db, g.env, { refreshToken, clientId }, g.now));
    }
    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  } catch (error) {
    if (error instanceof OAuthError) return oauthJsonError(error);
    throw error;
  }
}

export async function handleRevoke(request: Request, deps: OAuthDeps): Promise<Response> {
  const g = await guard(request, deps, "revoke", 30);
  if (!g.ok) return g.response;
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    const form = await readForm(request);
    const token = form.get("token") ?? "";
    const clientId = form.get("client_id") ?? "";
    if (!token || !clientId) throw new OAuthError("invalid_request", "token and client_id are required.");
    await revokeOAuthToken(deps.db, g.env, { token, clientId }, g.now);
    return new Response(null, { status: 200, headers: BASE_HEADERS });
  } catch (error) {
    if (error instanceof OAuthError) return oauthJsonError(error);
    throw error;
  }
}

// ---- /mcp/authorize ----

const PAGE_HEADERS = {
  ...BASE_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string, status = 200, extra: HeadersInit = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}input[type=password]{width:100%;padding:.5rem;box-sizing:border-box;font:inherit}button{padding:.5rem 1rem;font:inherit;margin-right:.5rem}.err{color:#b00020}code{background:#eee;padding:0 .25rem}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#333}}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...extra } });
}

type AuthRequest = { client: OAuthClient; redirectUri: string; state: string; codeChallenge: string };

function hiddenFields(a: AuthRequest, csrf: string): string {
  const field = (n: string, v: string) => `<input type="hidden" name="${n}" value="${escapeHtml(v)}">`;
  return [
    field("csrf", csrf),
    field("client_id", a.client.clientId),
    field("redirect_uri", a.redirectUri),
    field("state", a.state),
    field("code_challenge", a.codeChallenge),
    field("code_challenge_method", "S256"),
    field("response_type", "code"),
  ].join("");
}

function redirectTo(redirectUri: string, params: Record<string, string>): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== "") url.searchParams.set(k, v);
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: url.toString(), "Referrer-Policy": "no-referrer" } });
}

function errorPage(message: string): Response {
  return page("Cannot authorize", `<h1>Cannot authorize</h1><p class="err">${escapeHtml(message)}</p>`, 400);
}

/**
 * client_id and redirect_uri problems render a page and never redirect (an unregistered URI must not receive anything).
 * Every other problem is returned to the client by redirect, per RFC 6749 4.1.2.1.
 */
async function parseAuthRequest(db: Db, params: URLSearchParams): Promise<AuthRequest | Response> {
  const client = await getClient(db, params.get("client_id") ?? "");
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!client || !client.redirectUris.includes(redirectUri)) return errorPage("Unknown client or redirect URI.");
  const state = (params.get("state") ?? "").slice(0, 512);
  const fail = (error: string, description: string) => redirectTo(redirectUri, { error, error_description: description, state });
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !isValidCodeChallenge(codeChallenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  return { client, redirectUri, state, codeChallenge };
}

function readCookie(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

function csrfCookie(request: Request, token: string): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${CSRF_COOKIE}=${token}; Path=/mcp/authorize; HttpOnly; SameSite=Strict; Max-Age=900${secure}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function patForm(a: AuthRequest, csrf: string, error?: string): string {
  return `<h1>Connect ${escapeHtml(a.client.name)}</h1>
<p>This will let <strong>${escapeHtml(a.client.name)}</strong> (returning to <code>${escapeHtml(new URL(a.redirectUri).host)}</code>) use the Promo Engine MCP as you.</p>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/mcp/authorize" autocomplete="off">${hiddenFields(a, csrf)}<input type="hidden" name="intent" value="review">
<p><label for="pat">Your operator token (PAT, <code>pemcp_...</code>)</label><br><input id="pat" type="password" name="pat" required autocomplete="off" spellcheck="false"></p>
<p><button type="submit">Continue</button></p></form>`;
}

async function consentPage(db: Db, a: AuthRequest, operator: Operator, pat: string, csrf: string): Promise<string> {
  const shops = await visibleShops(db, operator);
  const shown = shops.slice(0, 50).map((s) => `<li>${escapeHtml(s.myshopifyDomain)}</li>`).join("");
  const more = shops.length > 50 ? `<li>and ${shops.length - 50} more</li>` : "";
  return `<h1>Allow ${escapeHtml(a.client.name)}?</h1>
<p>Signed in as <strong>${escapeHtml(operator.email)}</strong> with role <strong>${escapeHtml(operator.role)}</strong>.</p>
<p><strong>${escapeHtml(a.client.name)}</strong> (returning to <code>${escapeHtml(new URL(a.redirectUri).host)}</code>) will act with that role on ${shops.length} shop${shops.length === 1 ? "" : "s"}:</p>
<ul>${shown || "<li>no shops</li>"}${more}</ul>
<form method="post" action="/mcp/authorize">${hiddenFields(a, csrf)}<input type="hidden" name="pat" value="${escapeHtml(pat)}">
<button type="submit" name="intent" value="approve">Allow</button><button type="submit" name="intent" value="deny">Deny</button></form>`;
}

export async function handleAuthorize(request: Request, deps: OAuthDeps): Promise<Response> {
  const isPost = request.method === "POST";
  const g = await guard(request, deps, isPost ? "authorize-post" : "authorize", isPost ? 10 : 60);
  if (!g.ok) return g.response;
  if (request.method !== "GET" && !isPost) return methodNotAllowed("GET, POST");

  if (!isPost) {
    const parsed = await parseAuthRequest(deps.db, new URL(request.url).searchParams);
    if (parsed instanceof Response) return parsed;
    const csrf = randomBytes(24).toString("base64url");
    return page("Connect to Promo Engine", patForm(parsed, csrf), 200, { "Set-Cookie": csrfCookie(request, csrf) });
  }

  let form: URLSearchParams;
  try {
    form = await readForm(request);
  } catch {
    return errorPage("Invalid request.");
  }
  const origin = request.headers.get("origin");
  const cookie = readCookie(request, CSRF_COOKIE);
  if ((origin && origin !== publicOrigin(request, g.env)) || !safeEqual(cookie, form.get("csrf") ?? "")) {
    return errorPage("Your session expired. Go back to the app and start the connection again.");
  }
  const parsed = await parseAuthRequest(deps.db, form);
  if (parsed instanceof Response) return parsed;
  const csrf = cookie;
  const intent = form.get("intent");
  if (intent === "deny") return redirectTo(parsed.redirectUri, { error: "access_denied", state: parsed.state });
  if (intent !== "review" && intent !== "approve") return errorPage("Invalid request.");

  let operator: Operator;
  const pat = form.get("pat") ?? "";
  try {
    operator = await authenticatePat(deps.db, pat, g.env, g.now);
  } catch {
    return page("Connect to Promo Engine", patForm(parsed, csrf, "That token is invalid, expired or revoked."), 401);
  }
  if (intent === "review") return page("Allow access", await consentPage(deps.db, parsed, operator, pat, csrf));

  const code = await issueAuthCode(
    deps.db,
    g.env,
    { operatorId: operator.id, clientId: parsed.client.clientId, codeChallenge: parsed.codeChallenge, redirectUri: parsed.redirectUri },
    g.now,
  );
  return redirectTo(parsed.redirectUri, { code, state: parsed.state });
}

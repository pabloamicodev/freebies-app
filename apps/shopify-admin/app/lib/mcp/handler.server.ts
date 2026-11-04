import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Db } from "@promo/db";
import { authenticateBearer } from "./auth.server.js";
import { createMcpServer } from "./server.server.js";
import { ToolError } from "./result.server.js";
import { checkRateLimit, getClientIp } from "../rate-limit.server.js";
import { publicOrigin, resourceMetadataUrl } from "./oauth-http.server.js";

export type RateLimiter = (key: string, limit: number) => Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>;

export type McpHandlerDeps = {
  db: Db;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  rateLimit?: RateLimiter;
};

const defaultRateLimit: RateLimiter = (key, limit) =>
  checkRateLimit(key, { limit, windowMs: 60_000, onRedisUnavailable: "memory" });

export function mcpEnabled(env: NodeJS.ProcessEnv): boolean {
  return env["MCP_ENABLED"] === "true";
}

const JSON_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function jsonError(status: number, code: string, message: string, extra: HeadersInit = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers: { ...JSON_HEADERS, ...extra } });
}

function pepperConfigured(env: NodeJS.ProcessEnv): boolean {
  return (env["MCP_TOKEN_PEPPER"]?.length ?? 0) >= 16;
}

/** 404 unless MCP_ENABLED=true (set only on the HPN Vercel project); then Bearer auth (PAT or OAuth access token), then a stateless transport. */
export async function handleMcpRequest(request: Request, deps: McpHandlerDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  if (!mcpEnabled(env)) return new Response("Not Found", { status: 404, headers: JSON_HEADERS });
  // No DB call without a usable pepper: hashing would throw and every request would 500.

  if (!pepperConfigured(env)) return jsonError(503, "UPSTREAM_UNAVAILABLE", "MCP not configured");

  const now = deps.now ?? (() => new Date());
  const rateLimit = deps.rateLimit ?? defaultRateLimit;

  // Before any DB work, so PAT guessing is throttled per IP.
  const ipLimit = await rateLimit(`mcp:ip:${getClientIp(request)}`, 120);
  if (!ipLimit.ok) {
    return jsonError(429, "RATE_LIMITED", "Too many requests.", { "Retry-After": String(ipLimit.retryAfterSeconds) });
  }

  let operator;
  try {
    operator = await authenticateBearer(deps.db, request.headers.get("authorization"), env, now());
  } catch (error) {
    if (error instanceof ToolError && error.payload.code === "UNAUTHENTICATED") {
      return jsonError(401, "UNAUTHENTICATED", error.message, {
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl(publicOrigin(request, env))}"`,
      });
    }
    throw error;
  }

  const operatorLimit = await rateLimit(`mcp:op:${operator.id}`, 60);
  if (!operatorLimit.ok) {
    return jsonError(429, "RATE_LIMITED", "Too many requests.", { "Retry-After": String(operatorLimit.retryAfterSeconds) });
  }

  const server = createMcpServer({ db: deps.db, env, operator, now });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    // JSON responses are fully buffered, so the body is read before the transport closes.
    const body = await response.text();
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

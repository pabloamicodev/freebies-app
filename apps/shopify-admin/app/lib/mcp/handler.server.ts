import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Db } from "@promo/db";
import { authenticateBearer } from "./auth.server.js";
import { createMcpServer } from "./server.server.js";
import { ToolError } from "./result.server.js";
import { checkRateLimit } from "../rate-limit.server.js";

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

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** 404 unless MCP_ENABLED=true (set only on the HPN Vercel project); then Bearer PAT auth, then a stateless transport. */
export async function handleMcpRequest(request: Request, deps: McpHandlerDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  if (!mcpEnabled(env)) return new Response("Not Found", { status: 404, headers: JSON_HEADERS });

  const now = deps.now ?? (() => new Date());
  const rateLimit = deps.rateLimit ?? defaultRateLimit;

  // Before any DB work, so PAT guessing is throttled per IP.
  const ipLimit = await rateLimit(`mcp:ip:${clientIp(request)}`, 120);
  if (!ipLimit.ok) {
    return jsonError(429, "RATE_LIMITED", "Too many requests.", { "Retry-After": String(ipLimit.retryAfterSeconds) });
  }

  let operator;
  try {
    operator = await authenticateBearer(deps.db, request.headers.get("authorization"), env, now());
  } catch (error) {
    if (error instanceof ToolError && error.payload.code === "UNAUTHENTICATED") {
      return jsonError(401, "UNAUTHENTICATED", error.message, { "WWW-Authenticate": 'Bearer realm="promo-engine"' });
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
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

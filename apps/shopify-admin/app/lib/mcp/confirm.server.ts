import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ToolError } from "./result.server.js";

export const CONFIRM_TTL_MS = 5 * 60_000;
const MIN_SECRET_LENGTH = 32;
/** Control fields are not part of what the operator confirms: the dry run and the execute differ in them by design. */
const CONTROL_KEYS = new Set(["dryRun", "confirmToken", "idempotencyKey"]);

type Claims = { v: 1; tool: string; args: string; op: string; shop: string; upd: string | null; set?: string | null; exp: number; jti: string };

export type ConfirmBinding = { tool: string; args: Record<string, unknown>; operatorId: string; shopDomain: string };

function secret(env: NodeJS.ProcessEnv): string {
  const value = env["MCP_CONFIRM_SECRET"];
  if (!value || value.length < MIN_SECRET_LENGTH) {
    throw new ToolError("UPSTREAM_UNAVAILABLE", "Write tools are not configured on this server (MCP_CONFIRM_SECRET).");
  }
  return value;
}

export function assertConfirmConfigured(env: NodeJS.ProcessEnv): void {
  secret(env);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function stripControlArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_KEYS.has(key)));
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(stripControlArgs(args))).digest("hex");
}

function sign(payload: string, env: NodeJS.ProcessEnv): Buffer {
  return createHmac("sha256", secret(env)).update(payload).digest();
}

/** HMAC-SHA256 token over tool, args hash, operator, shop, offer updated_at, 5 min expiry and a single-use jti. */
export function issueConfirmToken(
  env: NodeJS.ProcessEnv,
  binding: ConfirmBinding,
  offerUpdatedAt: Date | null,
  now: Date,
  setHash: string | null = null,
): { token: string; expiresAt: Date; jti: string } {
  const expiresAt = new Date(now.getTime() + CONFIRM_TTL_MS);
  const jti = randomUUID();
  const claims: Claims = {
    v: 1,
    tool: binding.tool,
    args: hashArgs(binding.args),
    op: binding.operatorId,
    shop: binding.shopDomain.toLowerCase(),
    upd: offerUpdatedAt ? offerUpdatedAt.toISOString() : null,
    ...(setHash ? { set: setHash } : {}),
    exp: expiresAt.getTime(),
    jti,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return { token: `${payload}.${sign(payload, env).toString("base64url")}`, expiresAt, jti };
}

const invalid = () => new ToolError("CONFIRM_INVALID", "The confirmToken is not valid for this call. Run the dry run again with the same arguments.");

export function verifyConfirmToken(
  env: NodeJS.ProcessEnv,
  token: string,
  expected: ConfirmBinding,
  now: Date,
): { jti: string; offerUpdatedAt: Date | null; setHash: string | null } {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) throw invalid();
  const given = Buffer.from(signature, "base64url");
  const wanted = sign(payload, env);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw invalid();

  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
  } catch {
    throw invalid();
  }
  if (
    claims.v !== 1 ||
    claims.tool !== expected.tool ||
    claims.op !== expected.operatorId ||
    claims.shop !== expected.shopDomain.toLowerCase() ||
    claims.args !== hashArgs(expected.args) ||
    typeof claims.jti !== "string" ||
    typeof claims.exp !== "number"
  ) {
    throw invalid();
  }
  if (claims.exp <= now.getTime()) {
    throw new ToolError("CONFIRM_EXPIRED", "The confirmToken expired (5 minutes). Run the dry run again.");
  }
  return { jti: claims.jti, offerUpdatedAt: claims.upd ? new Date(claims.upd) : null, setHash: typeof claims.set === "string" ? claims.set : null };
}

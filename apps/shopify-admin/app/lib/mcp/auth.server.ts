import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { mcpCredentials, mcpOperators, type Db } from "@promo/db";
import { ToolError } from "./result.server.js";

export type McpRole = "viewer" | "editor" | "admin";
export const PAT_PREFIX = "pemcp_";
export const PAT_TTL_DAYS = 90;
export const ALL_SHOPS = "*";
const LAST_USED_THROTTLE_MS = 60_000;
const MYSHOPIFY_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Lowercases and trims; every entry must be a myshopify domain or the explicit "*" (all shops). Empty list = no shops. */
export function normalizeAllowList(entries: string[]): string[] {
  const normalized = entries.map((e) => e.trim().toLowerCase());
  for (const entry of normalized) {
    if (entry !== ALL_SHOPS && !MYSHOPIFY_PATTERN.test(entry)) {
      throw new Error(`Invalid shop "${entry}": use <store>.myshopify.com, or "*" for every shop.`);
    }
  }
  if (normalized.includes(ALL_SHOPS) && normalized.length > 1) throw new Error(`"*" cannot be combined with other shops.`);
  return [...new Set(normalized)];
}

export function canSeeShop(allowList: string[], myshopifyDomain: string): boolean {
  return allowList.includes(ALL_SHOPS) || allowList.includes(myshopifyDomain.toLowerCase());
}

const ROLE_RANK: Record<McpRole, number> = { viewer: 1, editor: 2, admin: 3 };

export type Operator = {
  id: string;
  email: string;
  name: string;
  role: McpRole;
  shopAllowList: string[];
};

export function roleAtLeast(role: McpRole, minimum: McpRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function requireRole(operator: Operator, minimum: McpRole): void {
  if (!roleAtLeast(operator.role, minimum)) {
    throw new ToolError("FORBIDDEN_ROLE", `This tool needs the ${minimum} role; your role is ${operator.role}.`);
  }
}

function pepper(env: NodeJS.ProcessEnv): string {
  const value = env["MCP_TOKEN_PEPPER"];
  if (!value || value.length < 16) throw new Error("MCP_TOKEN_PEPPER must be set (16+ chars)");
  return value;
}

export function hashToken(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return createHash("sha256").update(pepper(env)).update(token).digest("hex");
}

export function generatePat(): string {
  return PAT_PREFIX + randomBytes(32).toString("base64url");
}

export async function createOperatorWithPat(
  db: Db,
  input: { email: string; name: string; role: McpRole; shopAllowList: string[]; ttlDays?: number },
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<{ operatorId: string; pat: string; expiresAt: Date }> {
  const ttlDays = input.ttlDays ?? PAT_TTL_DAYS;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > PAT_TTL_DAYS) {
    throw new Error(`ttlDays must be an integer from 1 to ${PAT_TTL_DAYS}`);
  }
  const shopAllowList = normalizeAllowList(input.shopAllowList);
  const pat = generatePat();
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);
  const tokenHash = hashToken(pat, env);
  const operatorId = await db.transaction(async (tx) => {
    const [operator] = await tx
      .insert(mcpOperators)
      .values({
        email: input.email.trim().toLowerCase(),
        name: input.name,
        role: input.role,
        shopAllowList,
      })
      .returning({ id: mcpOperators.id });
    await tx.insert(mcpCredentials).values({
      operatorId: operator!.id,
      kind: "pat",
      tokenHash,
      prefix: pat.slice(0, 14),
      expiresAt,
    });
    return operator!.id;
  });
  return { operatorId, pat, expiresAt };
}

export async function revokeOperatorCredentials(db: Db, operatorId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(mcpCredentials)
    .set({ revokedAt: now })
    .where(and(eq(mcpCredentials.operatorId, operatorId), isNull(mcpCredentials.revokedAt)));
}

type CredentialKind = "pat" | "access" | "refresh";

/** True while this exact PAT is unrevoked and unexpired: OAuth grants never outlive the PAT that was pasted to create them. */
export async function patIsLive(db: Pick<Db, "select">, patCredentialId: string | null, operatorId: string, now: Date): Promise<boolean> {
  if (!patCredentialId) return false;
  const [row] = await db
    .select({ id: mcpCredentials.id })
    .from(mcpCredentials)
    .innerJoin(mcpOperators, eq(mcpOperators.id, mcpCredentials.operatorId))
    .where(
      and(
        eq(mcpCredentials.id, patCredentialId),
        eq(mcpCredentials.operatorId, operatorId),
        eq(mcpCredentials.kind, "pat"),
        isNull(mcpCredentials.revokedAt),
        gt(mcpCredentials.expiresAt, now),
        isNull(mcpOperators.disabledAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Raw token -> operator, restricted to the given credential kinds. Every failure is the same UNAUTHENTICATED error
 * so a caller cannot tell an unknown token from an expired, revoked or disabled one.
 */
async function authenticateToken(
  db: Db,
  token: string,
  kinds: CredentialKind[],
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<Operator & { credentialId: string }> {
  const fail = () => new ToolError("UNAUTHENTICATED", "Missing, invalid or expired token.");
  if (!token.startsWith(PAT_PREFIX)) throw fail();

  const [row] = await db
    .select({
      credentialId: mcpCredentials.id,
      kind: mcpCredentials.kind,
      patCredentialId: mcpCredentials.patCredentialId,
      expiresAt: mcpCredentials.expiresAt,
      lastUsedAt: mcpCredentials.lastUsedAt,
      revokedAt: mcpCredentials.revokedAt,
      operatorDisabledAt: mcpOperators.disabledAt,
      id: mcpOperators.id,
      email: mcpOperators.email,
      name: mcpOperators.name,
      role: mcpOperators.role,
      shopAllowList: mcpOperators.shopAllowList,
    })
    .from(mcpCredentials)
    .innerJoin(mcpOperators, eq(mcpOperators.id, mcpCredentials.operatorId))
    .where(eq(mcpCredentials.tokenHash, hashToken(token, env)))
    .limit(1);

  if (!row || !kinds.includes(row.kind) || row.revokedAt || row.operatorDisabledAt) throw fail();
  if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) throw fail();
  if (row.kind !== "pat" && !(await patIsLive(db, row.patCredentialId, row.id, now))) throw fail();

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    await db.update(mcpCredentials).set({ lastUsedAt: now }).where(eq(mcpCredentials.id, row.credentialId));
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role, shopAllowList: row.shopAllowList, credentialId: row.credentialId };
}

function bearerToken(authorization: string | null): string {
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

/** `Authorization: Bearer <PAT or OAuth access token>` -> operator. Refresh tokens are rejected. */
export async function authenticateBearer(
  db: Db,
  authorization: string | null,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<Operator> {
  const r = await authenticateToken(db, bearerToken(authorization), ["pat", "access"], env, now);
  return { id: r.id, email: r.email, name: r.name, role: r.role, shopAllowList: r.shopAllowList };
}

/** A bare PAT (pasted into the OAuth authorize page). Access and refresh tokens are not accepted there. */
export async function authenticatePat(
  db: Db,
  pat: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<Operator & { credentialId: string }> {
  return authenticateToken(db, pat.trim(), ["pat"], env, now);
}

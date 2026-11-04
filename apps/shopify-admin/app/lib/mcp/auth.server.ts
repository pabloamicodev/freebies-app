import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mcpCredentials, mcpOperators, type Db } from "@promo/db";
import { ToolError } from "./result.server.js";

export type McpRole = "viewer" | "editor" | "admin";
export const PAT_PREFIX = "pemcp_";
export const PAT_TTL_DAYS = 90;

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
  input: { email: string; name: string; role: McpRole; shopAllowList?: string[]; ttlDays?: number },
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<{ operatorId: string; pat: string; expiresAt: Date }> {
  const pat = generatePat();
  const expiresAt = new Date(now.getTime() + (input.ttlDays ?? PAT_TTL_DAYS) * 86_400_000);
  const tokenHash = hashToken(pat, env);
  const operatorId = await db.transaction(async (tx) => {
    const [operator] = await tx
      .insert(mcpOperators)
      .values({
        email: input.email.trim().toLowerCase(),
        name: input.name,
        role: input.role,
        shopAllowList: input.shopAllowList ?? [],
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
    .where(and(eq(mcpCredentials.operatorId, operatorId)));
}

/**
 * Bearer token -> operator. Every failure is the same UNAUTHENTICATED error so a caller
 * cannot tell an unknown token from an expired, revoked or disabled one.
 */
export async function authenticateBearer(
  db: Db,
  authorization: string | null,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<Operator> {
  const fail = () => new ToolError("UNAUTHENTICATED", "Missing, invalid or expired token.");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token.startsWith(PAT_PREFIX)) throw fail();

  const [row] = await db
    .select({
      credentialId: mcpCredentials.id,
      expiresAt: mcpCredentials.expiresAt,
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

  if (!row || row.revokedAt || row.operatorDisabledAt) throw fail();
  if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) throw fail();

  await db.update(mcpCredentials).set({ lastUsedAt: now }).where(eq(mcpCredentials.id, row.credentialId));
  return { id: row.id, email: row.email, name: row.name, role: row.role, shopAllowList: row.shopAllowList };
}

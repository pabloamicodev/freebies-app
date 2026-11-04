import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { mcpAuthCodes, mcpCredentials, mcpOauthClients, type Db } from "@promo/db";
import { hashToken, patIsLive } from "./auth.server.js";

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 86_400;
export const AUTH_CODE_TTL_SECONDS = 120;
/** A refresh token rotated this recently is a benign retry (lost response, parallel tabs), not theft. */
export const REFRESH_REUSE_GRACE_MS = 30_000;
export const ACCESS_PREFIX = "pemcp_at_";
export const REFRESH_PREFIX = "pemcp_rt_";
const CODE_PREFIX = "pemcp_ac_";
const MAX_REDIRECT_URIS = 5;

export class OAuthError extends Error {
  constructor(
    readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type" | "invalid_client_metadata" | "invalid_redirect_uri",
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

/** claude.ai / claude.com callbacks over https, and loopback http on any port (native clients such as Claude Code). */
export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > 512) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return (url.hostname === "claude.ai" || url.hostname === "claude.com") && url.port === "";
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export type OAuthClient = { clientId: string; redirectUris: string[]; name: string };

export async function registerClient(db: Db, input: { redirectUris: unknown; name: unknown }): Promise<OAuthClient> {
  const uris = input.redirectUris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every((u) => typeof u === "string")) {
    throw new OAuthError("invalid_redirect_uri", `redirect_uris must be 1 to ${MAX_REDIRECT_URIS} strings.`);
  }
  const bad = (uris as string[]).find((u) => !isAllowedRedirectUri(u));
  if (bad !== undefined) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri not allowed: use https://claude.ai or https://claude.com callbacks, or http://localhost / http://127.0.0.1.");
  }
  // Control characters out; the name is also HTML-escaped wherever it is rendered.
  const rawName = typeof input.name === "string" ? input.name : "";
  const name = rawName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) || "MCP client";
  const client: OAuthClient = { clientId: `mcpc_${randomBytes(18).toString("base64url")}`, redirectUris: [...new Set(uris as string[])], name };
  await db.insert(mcpOauthClients).values({ clientId: client.clientId, redirectUris: client.redirectUris, name: client.name });
  return client;
}

export async function getClient(db: Db, clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 128) return null;
  const [row] = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.clientId, clientId)).limit(1);
  return row ? { clientId: row.clientId, redirectUris: row.redirectUris, name: row.name } : null;
}

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE_PATTERN.test(challenge);
}

export function pkceChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier)) return false;
  const a = Buffer.from(pkceChallengeS256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function issueAuthCode(
  db: Db,
  env: NodeJS.ProcessEnv,
  input: { operatorId: string; patCredentialId: string; clientId: string; codeChallenge: string; redirectUri: string },
  now: Date = new Date(),
): Promise<string> {
  const code = CODE_PREFIX + randomBytes(32).toString("base64url");
  await db.insert(mcpAuthCodes).values({
    codeHash: hashToken(code, env),
    operatorId: input.operatorId,
    patCredentialId: input.patCredentialId,
    clientId: input.clientId,
    codeChallenge: input.codeChallenge,
    redirectUri: input.redirectUri,
    expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000),
  });
  return code;
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function mintTokens(tx: Tx, env: NodeJS.ProcessEnv, operatorId: string, patCredentialId: string, clientId: string, familyId: string, now: Date): Promise<TokenResponse> {
  const access = ACCESS_PREFIX + randomBytes(32).toString("base64url");
  const refresh = REFRESH_PREFIX + randomBytes(32).toString("base64url");
  await tx.insert(mcpCredentials).values([
    {
      operatorId,
      kind: "access",
      tokenHash: hashToken(access, env),
      prefix: access.slice(0, 14),
      familyId,
      clientId,
      patCredentialId,
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    },
    {
      operatorId,
      kind: "refresh",
      tokenHash: hashToken(refresh, env),
      prefix: refresh.slice(0, 14),
      familyId,
      clientId,
      patCredentialId,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: "mcp" };
}

async function revokeFamily(db: Db | Tx, familyId: string, now: Date): Promise<void> {
  await db
    .update(mcpCredentials)
    .set({ revokedAt: now })
    .where(and(eq(mcpCredentials.familyId, familyId), isNull(mcpCredentials.revokedAt)));
}

const invalidGrant = (description = "Invalid, expired or already used grant.") => new OAuthError("invalid_grant", description);

export async function exchangeAuthCode(
  db: Db,
  env: NodeJS.ProcessEnv,
  input: { code: string; clientId: string; redirectUri: string; codeVerifier: string },
  now: Date = new Date(),
): Promise<TokenResponse> {
  const codeHash = hashToken(input.code, env);
  // Failures inside the transaction must not roll back the code claim or the family revocation, so they are returned.
  const result = await db.transaction(async (tx): Promise<TokenResponse | OAuthError> => {
    const [row] = await tx.select().from(mcpAuthCodes).where(eq(mcpAuthCodes.codeHash, codeHash)).limit(1);
    if (!row) return invalidGrant();
    // Atomic single-use claim: of two concurrent redemptions only one gets a row back.
    const claimed = await tx
      .update(mcpAuthCodes)
      .set({ usedAt: now })
      .where(and(eq(mcpAuthCodes.codeHash, codeHash), isNull(mcpAuthCodes.usedAt)))
      .returning({ codeHash: mcpAuthCodes.codeHash });
    if (claimed.length === 0) {
      if (row.familyId) await revokeFamily(tx, row.familyId, now);
      return invalidGrant();
    }
    if (row.expiresAt.getTime() <= now.getTime()) return invalidGrant();
    if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) return invalidGrant();
    if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) return invalidGrant("PKCE verification failed.");
    if (!(await patIsLive(tx, row.patCredentialId, row.operatorId, now))) return invalidGrant();
    const familyId = randomUUID();
    await tx.update(mcpAuthCodes).set({ familyId }).where(eq(mcpAuthCodes.codeHash, codeHash));
    return mintTokens(tx, env, row.operatorId, row.patCredentialId!, row.clientId, familyId, now);
  });
  if (result instanceof OAuthError) throw result;
  return result;
}

export async function refreshTokens(
  db: Db,
  env: NodeJS.ProcessEnv,
  input: { refreshToken: string; clientId: string },
  now: Date = new Date(),
): Promise<TokenResponse> {
  const hash = hashToken(input.refreshToken, env);
  const result = await db.transaction(async (tx): Promise<TokenResponse | OAuthError> => {
    const [row] = await tx.select().from(mcpCredentials).where(eq(mcpCredentials.tokenHash, hash)).limit(1);
    if (!row || row.kind !== "refresh" || !row.familyId || row.clientId !== input.clientId) return invalidGrant();
    // A rotated (revoked) refresh token coming back means it leaked: kill the whole family, unless it was
    // rotated moments ago (a retry after a lost response), which is refused without punishing the grant.
    const reuse = async (revokedAt: Date | null) => {
      if (!revokedAt || now.getTime() - revokedAt.getTime() >= REFRESH_REUSE_GRACE_MS) await revokeFamily(tx, row.familyId!, now);
      return invalidGrant();
    };
    if (row.revokedAt) return reuse(row.revokedAt);
    if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) return invalidGrant();
    const claimed = await tx
      .update(mcpCredentials)
      .set({ revokedAt: now, lastUsedAt: now })
      .where(and(eq(mcpCredentials.id, row.id), isNull(mcpCredentials.revokedAt)))
      .returning({ id: mcpCredentials.id });
    if (claimed.length === 0) return reuse(now);
    if (!(await patIsLive(tx, row.patCredentialId, row.operatorId, now))) {
      await revokeFamily(tx, row.familyId, now);
      return invalidGrant();
    }
    return mintTokens(tx, env, row.operatorId, row.patCredentialId!, row.clientId!, row.familyId, now);
  });
  if (result instanceof OAuthError) throw result;
  return result;
}

/** RFC 7009: silent for unknown tokens. Revoking either token of a grant ends the whole family. */
export async function revokeOAuthToken(
  db: Db,
  env: NodeJS.ProcessEnv,
  input: { token: string; clientId: string },
  now: Date = new Date(),
): Promise<void> {
  const [row] = await db.select().from(mcpCredentials).where(eq(mcpCredentials.tokenHash, hashToken(input.token, env))).limit(1);
  if (!row || row.kind === "pat" || !row.familyId || row.clientId !== input.clientId) return;
  await revokeFamily(db, row.familyId, now);
}

// Verifies the Cognito ID token Skio's storefront login keeps in localStorage
// (CognitoIdentityServiceProvider.<client>.<user>.idToken) and returns the Skio
// storefrontUserId it was issued for. The pool and client are Skio's, shared by every
// Skio merchant: tenancy is enforced by looking the user up with the shop's own Skio key.

const ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_ky2hNEMAZ";
const CLIENT_ID = "26kili0dth6djs3e0a7digs3e2";
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Jwk = JsonWebKey & { kid?: string };
export type JwksFetcher = () => Promise<Jwk[]>;

const fetchCognitoJwks: JwksFetcher = async () => {
  const response = await fetch(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Cognito JWKS HTTP ${response.status}`);
  return ((await response.json()) as { keys: Jwk[] }).keys;
};

let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

async function findKey(kid: string, fetchJwks: JwksFetcher): Promise<Jwk | null> {
  const fresh = jwksCache && jwksCache.expiresAt > Date.now();
  let key = fresh ? jwksCache!.keys.find((k) => k.kid === kid) : undefined;
  if (!key) {
    jwksCache = { expiresAt: Date.now() + JWKS_TTL_MS, keys: await fetchJwks() };
    key = jwksCache.keys.find((k) => k.kid === kid);
  }
  return key ?? null;
}

function b64urlBytes(part: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(part, "base64url"));
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function resetSkioJwksCacheForTests() {
  jwksCache = null;
}

/** storefrontUserId of a valid, unexpired Skio ID token; null for anything else. */
export async function verifySkioIdToken(
  token: string,
  { fetchJwks = fetchCognitoJwks, now = Date.now() }: { fetchJwks?: JwksFetcher; now?: number } = {},
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) return null;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  try {
    const header = b64urlJson(rawHeader);
    const payload = b64urlJson(rawPayload);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    if (payload.iss !== ISSUER || payload.aud !== CLIENT_ID || payload.token_use !== "id") return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
    const storefrontUserId = payload["custom:storefrontUserId"];
    if (typeof storefrontUserId !== "string" || !UUID.test(storefrontUserId)) return null;

    const jwk = await findKey(header.kid, fetchJwks);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlBytes(rawSignature),
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    );
    return ok ? storefrontUserId : null;
  } catch {
    return null;
  }
}

export const SKIO_COGNITO = { ISSUER, CLIENT_ID };

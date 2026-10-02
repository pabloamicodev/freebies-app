import { createHmac, timingSafeEqual } from "node:crypto";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies a Shopify App Bridge session token (HS256 JWT signed with the app secret) without touching the
 * database or Shopify: signature, `exp`/`nbf` (10 s skew) and `aud` = the app's client id. Returns the shop
 * domain from `dest`, or null. Cheap enough for a route that must authenticate but not load a session.
 */
export function verifySessionToken(
  token: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null {
  const secret = env["SHOPIFY_API_SECRET"];
  const apiKey = env["SHOPIFY_API_KEY"];
  if (!token || !secret || !apiKey) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64urlDecode(parts[0]!).toString("utf8")) as { alg?: unknown };
    if (header.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    const actual = b64urlDecode(parts[2]!);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(b64urlDecode(parts[1]!).toString("utf8")) as { exp?: unknown; nbf?: unknown; aud?: unknown; dest?: unknown };
    if (typeof claims.exp !== "number" || claims.exp + 10 < nowSeconds) return null;
    if (typeof claims.nbf === "number" && claims.nbf - 10 > nowSeconds) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(apiKey)) return null;
    if (typeof claims.dest !== "string") return null;
    const host = new URL(claims.dest).hostname.toLowerCase();
    return SHOP_DOMAIN.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : null;
}

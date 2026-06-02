/**
 * HMAC validation utilities for Shopify webhooks and storefront requests.
 * Prevents spoofed requests from hitting our endpoints.
 */

const encoder = new TextEncoder();

/**
 * Validate a Shopify webhook HMAC signature.
 * Shopify signs webhook payloads with HMAC-SHA256 using the app secret.
 */
export async function validateWebhookHmac(
  rawBody: string,
  hmacHeader: string,
  secret: string,
): Promise<boolean> {
  if (!hmacHeader) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expectedHmac = btoa(String.fromCharCode(...new Uint8Array(signature)));

  // Timing-safe comparison
  return timingSafeEqual(expectedHmac, hmacHeader);
}

/**
 * Generate an HMAC hash for gift line properties.
 * Used to detect tampering of _promo_engine_* line properties.
 */
export async function generateLineHash(
  offerId: string,
  variantId: string,
  sessionId: string,
  secret: string,
): Promise<string> {
  const payload = `${offerId}:${variantId}:${sessionId}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Timing-safe string comparison — prevents timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Hono middleware factory for webhook HMAC validation.
 * Usage: app.use("/webhooks/*", webhookHmacMiddleware())
 */
export function createWebhookHmacMiddleware(secret: string) {
  return async (c: any, next: () => Promise<void>) => {
    const hmacHeader = c.req.header("X-Shopify-Hmac-Sha256") ?? "";
    const rawBody = await c.req.text();

    // Re-attach body for downstream handlers
    c.set("rawBody", rawBody);

    const isValid = await validateWebhookHmac(rawBody, hmacHeader, secret);
    if (!isValid) {
      return c.json({ error: "Invalid HMAC" }, 401);
    }

    await next();
  };
}

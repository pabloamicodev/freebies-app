/**
 * AES-256-GCM token encryption/decryption for Shopify access tokens.
 *
 * Key: TOKEN_ENCRYPTION_KEY env var — 64 hex chars (32 bytes).
 * Format: "<iv_hex>:<ciphertext_with_authtag_hex>"
 *
 * Legacy plaintext tokens (pre-encryption migration) are handled transparently:
 * - Reads: if decryption fails or format has no separator, the raw value is returned
 * - Writes: always produce encrypted output
 *
 * Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const ALGORITHM = "AES-GCM";

async function getKey(): Promise<CryptoKey | null> {
  const raw = process.env["TOKEN_ENCRYPTION_KEY"];
  if (!raw) return null;
  const bytes = Buffer.from(raw, "hex");
  if (bytes.byteLength !== 32) {
    console.error("[token-crypto] TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars) — skipping encryption");
    return null;
  }
  return crypto.subtle.importKey("raw", bytes, { name: ALGORITHM }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt a Shopify access token.
 * Throws in production if TOKEN_ENCRYPTION_KEY is not set — storing tokens
 * in plaintext in production is a security violation.
 */
export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("[token-crypto] TOKEN_ENCRYPTION_KEY must be set in production. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    }
    console.warn("[token-crypto] TOKEN_ENCRYPTION_KEY not set — storing access token without encryption. This will throw in production.");
    return plaintext;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);
  return `${Buffer.from(iv).toString("hex")}:${Buffer.from(ciphertext).toString("hex")}`;
}

/**
 * Decrypt a Shopify access token.
 * Falls back to returning the raw value for legacy plaintext tokens or when encryption key is absent.
 */
export async function decryptToken(stored: string): Promise<string> {
  // Plaintext legacy token (no ":" separator in our format, but real tokens start with "shpat_" etc.)
  const separatorIndex = stored.indexOf(":");
  if (separatorIndex === -1) return stored; // Legacy plaintext

  const key = await getKey();
  if (!key) return stored; // No key configured — return as stored (handles dev/migration)

  try {
    const iv = Buffer.from(stored.slice(0, separatorIndex), "hex");
    const ciphertext = Buffer.from(stored.slice(separatorIndex + 1), "hex");
    const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    // Decryption failed — may be a legacy plaintext token containing a colon (e.g. URL format)
    return stored;
  }
}

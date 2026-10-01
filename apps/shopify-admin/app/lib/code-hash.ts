/**
 * Compact code fingerprint shared with the code Function (backend B): FNV-1a 64
 * over the ASCII-uppercased, trimmed code, first 12 hex chars. Matching the
 * Rust side exactly matters; vectors are pinned in both test suites.
 */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function codeHash(code: string): string {
  let hash = FNV_OFFSET;
  for (const char of code.trim()) {
    const byte = char.charCodeAt(0);
    // ASCII-only uppercase, same as the Function (no Unicode case folding).
    const upper = byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
    hash = ((hash ^ BigInt(upper & 0xff)) * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0").slice(0, 12);
}

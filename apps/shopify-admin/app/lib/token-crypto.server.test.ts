/**
 * Integration tests for token-crypto.server.ts
 * No DB required — tests AES-256-GCM encrypt/decrypt in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encryptToken, decryptToken } from "./token-crypto.server.js";

const TEST_KEY = "a".repeat(64); // 32 bytes as hex

function withKey(key: string | undefined, fn: () => Promise<void>) {
  return async () => {
    const orig = process.env["TOKEN_ENCRYPTION_KEY"];
    if (key === undefined) {
      delete process.env["TOKEN_ENCRYPTION_KEY"];
    } else {
      process.env["TOKEN_ENCRYPTION_KEY"] = key;
    }
    try {
      await fn();
    } finally {
      if (orig === undefined) delete process.env["TOKEN_ENCRYPTION_KEY"];
      else process.env["TOKEN_ENCRYPTION_KEY"] = orig;
    }
  };
}

describe("encryptToken", () => {
  it("produces iv:ciphertext format", withKey(TEST_KEY, async () => {
    const result = await encryptToken("shpat_test_token_123");
    expect(result).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  }));

  it("produces different ciphertext on each call (random IV)", withKey(TEST_KEY, async () => {
    const a = await encryptToken("same-token");
    const b = await encryptToken("same-token");
    expect(a).not.toBe(b); // Different IVs
  }));

  it("returns plaintext without key in non-production env", withKey(undefined, async () => {
    const orig = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
    try {
      const result = await encryptToken("shpat_test");
      expect(result).toBe("shpat_test");
    } finally {
      process.env["NODE_ENV"] = orig;
    }
  }));

  it("throws in production without key", withKey(undefined, async () => {
    const orig = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await expect(encryptToken("shpat_test")).rejects.toThrow("TOKEN_ENCRYPTION_KEY must be set in production");
    } finally {
      process.env["NODE_ENV"] = orig;
    }
  }));
});

describe("decryptToken", () => {
  it("round-trips encrypt → decrypt", withKey(TEST_KEY, async () => {
    const original = "shpat_real_access_token_abc123";
    const encrypted = await encryptToken(original);
    const decrypted = await decryptToken(encrypted);
    expect(decrypted).toBe(original);
  }));

  it("returns legacy plaintext tokens unchanged (no separator)", withKey(TEST_KEY, async () => {
    const legacy = "shpat_legacy_no_separator";
    const result = await decryptToken(legacy);
    expect(result).toBe(legacy);
  }));

  it("throws in production when ciphertext is tampered", withKey(TEST_KEY, async () => {
    const encrypted = await encryptToken("shpat_real_token");
    const tampered = encrypted.replace(/.$/, "0"); // flip last hex char
    const orig = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await expect(decryptToken(tampered)).rejects.toThrow("decryption failed");
    } finally {
      process.env["NODE_ENV"] = orig;
    }
  }));

  it("falls back to raw value in dev when ciphertext is tampered", withKey(TEST_KEY, async () => {
    const encrypted = await encryptToken("shpat_token");
    const tampered = encrypted.slice(0, -2) + "ff";
    const orig = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
    try {
      // Dev falls back — does not throw
      const result = await decryptToken(tampered);
      expect(typeof result).toBe("string");
    } finally {
      process.env["NODE_ENV"] = orig;
    }
  }));

  it("returns raw value when no key is configured", withKey(undefined, async () => {
    const stored = "ab12:cd34ef";
    const result = await decryptToken(stored);
    expect(result).toBe(stored);
  }));

  it("rejects a 16-byte (short) key", withKey("a".repeat(32) /* 16 bytes hex */, async () => {
    const orig = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
    try {
      const result = await encryptToken("token");
      expect(result).toBe("token"); // key skipped → plaintext fallback
    } finally {
      process.env["NODE_ENV"] = orig;
    }
  }));
});

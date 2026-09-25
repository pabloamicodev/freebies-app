import { Session } from "@shopify/shopify-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  databaseRowToSession,
  sessionToDatabaseRow,
  sessionToStoredRow,
  storedRowToSession,
} from "./postgres-session-storage.server.js";
import { isEncryptedToken } from "./token-crypto.server.js";

type Row = Parameters<typeof storedRowToSession>[0];

describe("PostgresSessionStorage serialization", () => {
  it("round-trips offline sessions without losing expiry precision required by Shopify", () => {
    const session = new Session({
      id: "offline_store.myshopify.com",
      shop: "store.myshopify.com",
      state: "state",
      isOnline: false,
      scope: "read_products,write_discounts",
      accessToken: "token",
      expires: new Date("2026-09-24T21:00:00.789Z"),
      refreshToken: "refresh",
      refreshTokenExpires: new Date("2026-10-24T21:00:00.789Z"),
    });

    const row = sessionToDatabaseRow(session);
    const expectedExpiry = Math.floor(Date.parse("2026-09-24T21:00:00.789Z") / 1_000) * 1_000;
    const expectedRefreshExpiry = Date.parse("2026-10-24T21:00:00.789Z");
    expect(row.expires).toBe(expectedExpiry / 1_000);
    const restored = databaseRowToSession(row as Parameters<typeof databaseRowToSession>[0]);

    expect(Object.fromEntries(restored.toPropertyArray(true))).toEqual({
      id: "offline_store.myshopify.com",
      shop: "store.myshopify.com",
      state: "state",
      isOnline: false,
      scope: "read_products,write_discounts",
      accessToken: "token",
      expires: expectedExpiry,
      refreshToken: "refresh",
      refreshTokenExpires: expectedRefreshExpiry,
    });
  });

  it("round-trips online user fields", () => {
    const session = new Session({
      id: "online_store_123",
      shop: "store.myshopify.com",
      state: "state",
      isOnline: true,
      onlineAccessInfo: {
        expires_in: 3600,
        associated_user_scope: "read_products",
        associated_user: {
          id: 123,
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
          account_owner: true,
          locale: "en",
          collaborator: false,
          email_verified: true,
        },
      },
    });

    const row = sessionToDatabaseRow(session);
    const restored = databaseRowToSession(row as Parameters<typeof databaseRowToSession>[0]);

    expect(restored.onlineAccessInfo?.associated_user).toMatchObject({
      id: 123,
      first_name: "Ada",
      last_name: "Lovelace",
      account_owner: true,
      collaborator: false,
      email_verified: true,
    });
  });
});

describe("PostgresSessionStorage access token encryption", () => {
  const originalKey = process.env["TOKEN_ENCRYPTION_KEY"];
  const token = `shpat_${"a".repeat(32)}`;
  const session = () => new Session({
    id: "offline_store.myshopify.com",
    shop: "store.myshopify.com",
    state: "state",
    isOnline: false,
    accessToken: token,
  });

  beforeEach(() => {
    process.env["TOKEN_ENCRYPTION_KEY"] = "ab".repeat(32);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env["TOKEN_ENCRYPTION_KEY"];
    else process.env["TOKEN_ENCRYPTION_KEY"] = originalKey;
  });

  it("encrypts the access token at rest within the varchar(255) column", async () => {
    const row = await sessionToStoredRow(session());
    expect(row.accessToken).not.toContain(token);
    expect(isEncryptedToken(row.accessToken!)).toBe(true);
    expect(row.accessToken!.length).toBeLessThanOrEqual(255);

    const restored = await storedRowToSession(row as Row);
    expect(restored.accessToken).toBe(token);
  });

  it("loads legacy plaintext rows unchanged", async () => {
    const row = sessionToDatabaseRow(session());
    expect(row.accessToken).toBe(token);
    const restored = await storedRowToSession(row as Row);
    expect(restored.accessToken).toBe(token);
  });

  it("keeps sessions without an access token empty", async () => {
    const row = await sessionToStoredRow(new Session({
      id: "online_store_1",
      shop: "store.myshopify.com",
      state: "state",
      isOnline: true,
    }));
    expect(row.accessToken).toBeNull();
    expect((await storedRowToSession(row as Row)).accessToken).toBeUndefined();
  });
});

import { Session } from "@shopify/shopify-api";
import { describe, expect, it } from "vitest";
import {
  databaseRowToSession,
  sessionToDatabaseRow,
} from "./postgres-session-storage.server.js";

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

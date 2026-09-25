import { Session } from "@shopify/shopify-api";
import {
  getDb,
  shopifySessions,
  type NewShopifySessionRow,
  type ShopifySessionRow,
} from "@promo/db";
import { eq, inArray } from "drizzle-orm";
import { decryptToken, encryptToken } from "./token-crypto.server.js";

export function sessionToDatabaseRow(session: Session): NewShopifySessionRow {
  const user = session.onlineAccessInfo?.associated_user;
  return {
    id: session.id,
    shop: session.shop,
    state: session.state,
    isOnline: session.isOnline,
    scope: session.scope ?? null,
    expires: session.expires ? Math.floor(session.expires.getTime() / 1_000) : null,
    accessToken: session.accessToken ?? null,
    refreshToken: session.refreshToken ?? null,
    refreshTokenExpires: session.refreshTokenExpires?.getTime() ?? null,
    userId: user?.id ?? null,
    firstName: user?.first_name ?? null,
    lastName: user?.last_name ?? null,
    email: user?.email ?? null,
    accountOwner: user?.account_owner ?? null,
    locale: user?.locale ?? null,
    collaborator: user?.collaborator ?? null,
    emailVerified: user?.email_verified ?? null,
  };
}

export function databaseRowToSession(row: ShopifySessionRow): Session {
  const values = {
    ...row,
    expires: row.expires === null ? null : row.expires * 1_000,
  };
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string | number | boolean] =>
      entry[1] !== null && entry[1] !== undefined,
  );
  return Session.fromPropertyArray(entries, true);
}

// Legacy plaintext rows still load (decryptToken passes non-encrypted values
// through) and are re-encrypted the next time Shopify stores the session.
export async function sessionToStoredRow(session: Session): Promise<NewShopifySessionRow> {
  const row = sessionToDatabaseRow(session);
  return { ...row, accessToken: row.accessToken ? await encryptToken(row.accessToken) : null };
}

export async function storedRowToSession(row: ShopifySessionRow): Promise<Session> {
  return databaseRowToSession({
    ...row,
    accessToken: row.accessToken ? await decryptToken(row.accessToken) : null,
  });
}

export class PostgresSessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    const values = await sessionToStoredRow(session);
    await getDb()
      .insert(shopifySessions)
      .values(values)
      .onConflictDoUpdate({
        target: shopifySessions.id,
        set: {
          shop: values.shop,
          state: values.state,
          isOnline: values.isOnline,
          scope: values.scope,
          expires: values.expires,
          accessToken: values.accessToken,
          refreshToken: values.refreshToken,
          refreshTokenExpires: values.refreshTokenExpires,
          userId: values.userId,
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          accountOwner: values.accountOwner,
          locale: values.locale,
          collaborator: values.collaborator,
          emailVerified: values.emailVerified,
        },
      });
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const [row] = await getDb()
      .select()
      .from(shopifySessions)
      .where(eq(shopifySessions.id, id))
      .limit(1);
    return row ? storedRowToSession(row) : undefined;
  }

  async deleteSession(id: string): Promise<boolean> {
    await getDb().delete(shopifySessions).where(eq(shopifySessions.id, id));
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length > 0) {
      await getDb().delete(shopifySessions).where(inArray(shopifySessions.id, ids));
    }
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const rows = await getDb()
      .select()
      .from(shopifySessions)
      .where(eq(shopifySessions.shop, shop));
    return Promise.all(rows.map(storedRowToSession));
  }
}

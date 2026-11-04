import { eq } from "drizzle-orm";
import { analyticsEvents, shops, type Db } from "@promo/db";
import type { Operator } from "../auth.server.js";
import { visibleShops, type VisibleShop } from "../shops.server.js";
import { seedShop } from "../../test-support/pglite-db.js";

export const NOW = new Date("2026-11-01T12:00:00.000Z");
export const now = () => NOW;

export const SECRET_VALUES = {
  customer: "gid://shopify/Customer/777000111",
  session: "sess-secret-abc123",
  cart: "cart-token-secret-xyz",
  order: "gid://shopify/Order/9000123",
} as const;

export const operatorAll: Operator = { id: "op-all", email: "owner@example.com", name: "Owner", role: "viewer", shopAllowList: ["*"] };

/** alpha (USD, UTC), beta (EUR, Madrid), gone (uninstalled). Returns ids and the visible list for an operator. */
export async function seedWorld(db: Db) {
  const alpha = await seedShop(db, "alpha.myshopify.com");
  const beta = await seedShop(db, "beta.myshopify.com");
  const gone = await seedShop(db, "gone.myshopify.com");
  await db.update(shops).set({ currencyCode: "EUR", timezone: "Europe/Madrid" }).where(eq(shops.id, beta));
  await db.update(shops).set({ uninstalledAt: new Date() }).where(eq(shops.id, gone));
  const visible = async (operator: Operator = operatorAll): Promise<VisibleShop[]> => visibleShops(db, operator);
  return { alpha, beta, gone, visible };
}

export type EventSpec = {
  shopId: string;
  offerId: string | null;
  name: string;
  at: string;
  orderId?: string;
  properties?: Record<string, unknown>;
  n?: number;
};

/** Inserts `n` identical events carrying every identifier the tools must never output. */
export async function insertEvents(db: Db, spec: EventSpec): Promise<void> {
  const rows = Array.from({ length: spec.n ?? 1 }, () => ({
    shopId: spec.shopId,
    eventName: spec.name,
    offerId: spec.offerId,
    orderId: spec.orderId ?? null,
    customerId: SECRET_VALUES.customer,
    sessionId: SECRET_VALUES.session,
    cartToken: SECRET_VALUES.cart,
    properties: spec.properties ?? {},
    occurredAt: new Date(spec.at),
  }));
  await db.insert(analyticsEvents).values(rows);
}

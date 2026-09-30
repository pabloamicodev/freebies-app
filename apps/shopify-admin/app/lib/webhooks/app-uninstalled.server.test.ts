import { describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";
import { handleAppUninstalled, type SessionStorageLike } from "./app-uninstalled.server.js";

function fakeSessionStorage(sessions: Array<{ id: string }> = []): SessionStorageLike & {
  deleteSessions: ReturnType<typeof vi.fn>;
} {
  return {
    findSessionsByShop: vi.fn().mockResolvedValue(sessions),
    deleteSessions: vi.fn().mockResolvedValue(true),
  };
}

function fakeDb(opts: { installedAt: Date | null; shopId?: string }) {
  const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(opts.installedAt ? [{ installedAt: opts.installedAt }] : []),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        // Distinguish the `shops` update (has `.returning`) from the `offers`
        // archive update (no `.returning` call in the source).
        const isShopsUpdate = "isActive" in values;
        updateCalls.push({ table: isShopsUpdate ? "shops" : "offers", values });
        return {
          where: () => ({
            returning: () => Promise.resolve(isShopsUpdate && opts.shopId ? [{ id: opts.shopId }] : []),
          }),
        };
      },
    }),
  };
  return { db: db as unknown as Db, updateCalls };
}

describe("handleAppUninstalled", () => {
  it("archives the shop and its active offers, then purges sessions, when there is no reinstall race", async () => {
    const { db, updateCalls } = fakeDb({ installedAt: null, shopId: "shop-1" });
    const sessionStorage = fakeSessionStorage([{ id: "sess-1" }, { id: "sess-2" }]);

    await handleAppUninstalled(db, sessionStorage, "shop.myshopify.com", null);

    expect(updateCalls.map((c) => c.table)).toEqual(["shops", "offers"]);
    expect(updateCalls[0]!.values).toMatchObject({ isActive: false, discountId: null, deliveryDiscountId: null });
    expect(sessionStorage.deleteSessions).toHaveBeenCalledWith(["sess-1", "sess-2"]);
  });

  it("does not purge sessions when the shop has none", async () => {
    const { db } = fakeDb({ installedAt: null, shopId: "shop-1" });
    const sessionStorage = fakeSessionStorage([]);

    await handleAppUninstalled(db, sessionStorage, "shop.myshopify.com", null);

    expect(sessionStorage.deleteSessions).not.toHaveBeenCalled();
  });

  // The reinstall-race guard: Shopify can deliver/retry APP_UNINSTALLED after a
  // faster reinstall already bumped installedAt. Current behavior (preserved
  // as-is, not redesigned): if the shop's installedAt is strictly AFTER the
  // webhook's triggered_at timestamp, the handler bails out before touching
  // any row at all — it does not distinguish "reinstalled" from any other
  // reason installedAt might be newer than triggeredAt.
  it("skips all processing when the shop was reinstalled after the webhook was triggered", async () => {
    const triggeredAt = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const reinstalledAt = new Date("2026-01-01T00:05:00.000Z"); // after triggeredAt
    const { db, updateCalls } = fakeDb({ installedAt: reinstalledAt, shopId: "shop-1" });
    const sessionStorage = fakeSessionStorage([{ id: "sess-1" }]);

    await handleAppUninstalled(db, sessionStorage, "shop.myshopify.com", triggeredAt);

    expect(updateCalls).toHaveLength(0);
    expect(sessionStorage.findSessionsByShop).not.toHaveBeenCalled();
    expect(sessionStorage.deleteSessions).not.toHaveBeenCalled();
  });

  it("still processes when installedAt is before (or equal to) triggeredAt — no race", async () => {
    const triggeredAt = new Date("2026-01-01T00:05:00.000Z").toISOString();
    const installedAt = new Date("2026-01-01T00:00:00.000Z"); // before triggeredAt
    const { db, updateCalls } = fakeDb({ installedAt, shopId: "shop-1" });
    const sessionStorage = fakeSessionStorage([]);

    await handleAppUninstalled(db, sessionStorage, "shop.myshopify.com", triggeredAt);

    expect(updateCalls.map((c) => c.table)).toEqual(["shops", "offers"]);
  });

  it("still processes (fail-open) when triggeredAt is an unparsable date", async () => {
    const { db, updateCalls } = fakeDb({ installedAt: new Date(), shopId: "shop-1" });
    const sessionStorage = fakeSessionStorage([]);

    await handleAppUninstalled(db, sessionStorage, "shop.myshopify.com", "not-a-date");

    expect(updateCalls.map((c) => c.table)).toEqual(["shops", "offers"]);
  });

  it("does not touch offers when the shops update finds no matching row", async () => {
    const { db, updateCalls } = fakeDb({ installedAt: null, shopId: undefined });
    const sessionStorage = fakeSessionStorage([]);

    await handleAppUninstalled(db, sessionStorage, "shop.myshopify.com", null);

    expect(updateCalls.map((c) => c.table)).toEqual(["shops"]);
  });
});

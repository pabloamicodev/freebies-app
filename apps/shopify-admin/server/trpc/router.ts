/**
 * tRPC router — type-safe RPC between admin React UI and React Router backend.
 * All procedures require an authenticated Shopify session.
 *
 * Integration boundary:
 * - Server side: this router is intended to be mounted at /trpc via a Hono or
 *   React Router resource route (not yet wired — see server/trpc/handler.ts when ready).
 * - Client side: import AppRouter as the type arg for createTRPCReact() in the
 *   frontend; do NOT import runtime values from this file into client bundles.
 * - Export only appRouter (handler) and AppRouter (type) from this file. All
 *   internal sub-routers stay unexported.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb, offers, offerConditions, offerRewards, offerCombinationPolicies, shops, appSettings, analyticsEvents, cartMutationLogs } from "@promo/db";
import { eq, and, count, desc, gte, sql } from "drizzle-orm";

// ── Context ───────────────────────────────────────────────────────────────────

export interface TRPCContext {
  shopId: string;
  shopDomain: string;
}

const t = initTRPC.context<TRPCContext>().create();

const router = t.router;
const shopProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.shopId) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx });
});

// ── Offer procedures ──────────────────────────────────────────────────────────

const offersRouter = router({
  list: shopProcedure
    .input(z.object({
      type: z.enum(["gift","bundle","upsell","discount","booster"]).optional(),
      status: z.enum(["draft","active","paused","scheduled","expired","archived"]).optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const conditions = [eq(offers.shopId, ctx.shopId)];
      if (input.type) conditions.push(eq(offers.type, input.type));
      if (input.status) conditions.push(eq(offers.status, input.status));

      const rows = await db.select().from(offers)
        .where(and(...conditions))
        .orderBy(offers.priority, desc(offers.updatedAt))
        .limit(input.limit)
        .offset(input.offset);

      return rows;
    }),

  get: shopProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [offer] = await db.select().from(offers)
        .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, input.id)))
        .limit(1);
      if (!offer) throw new TRPCError({ code: "NOT_FOUND" });
      return offer;
    }),

  create: shopProcedure
    .input(z.object({
      internalName: z.string().min(1).max(100),
      publicTitle: z.string().min(1).max(100),
      type: z.enum(["gift","bundle","upsell","discount","booster"]),
      priority: z.number().int().min(1).max(9999).default(100),
      discountTags: z.array(z.string()).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [newOffer] = await db.insert(offers).values({
        shopId: ctx.shopId,
        ...input,
        status: "draft",
      }).returning();
      if (!newOffer) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.insert(offerCombinationPolicies).values({
        shopId: ctx.shopId,
        offerId: newOffer.id,
        combinesWithOrderDiscounts: true,
        combinesWithProductDiscounts: true,
        combinesWithShippingDiscounts: true,
        combinesWithOtherAppOffers: true,
        stopLowerPriority: false,
        giftValueCountsForOtherOffers: false,
      });
      return newOffer;
    }),

  update: shopProcedure
    .input(z.object({
      id: z.string().uuid(),
      internalName: z.string().min(1).max(100).optional(),
      publicTitle: z.string().min(1).max(100).optional(),
      priority: z.number().int().min(1).max(9999).optional(),
      discountTags: z.array(z.string()).optional(),
      startsAt: z.string().datetime().nullable().optional(),
      endsAt: z.string().datetime().nullable().optional(),
      timezone: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, startsAt, endsAt, ...rest } = input;
      await db.update(offers).set({
        ...rest,
        ...(startsAt !== undefined ? { startsAt: startsAt ? new Date(startsAt) : null } : {}),
        ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}),
        updatedAt: new Date(),
      }).where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, id)));
      return { success: true };
    }),

  publish: shopProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.update(offers)
        .set({ status: "active", updatedAt: new Date() })
        .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, input.id)));
      return { success: true };
    }),

  pause: shopProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.update(offers)
        .set({ status: "paused", updatedAt: new Date() })
        .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, input.id)));
      return { success: true };
    }),

  archive: shopProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.update(offers)
        .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, input.id)));
      return { success: true };
    }),

  duplicate: shopProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [original] = await db.select().from(offers)
        .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, input.id)))
        .limit(1);
      if (!original) throw new TRPCError({ code: "NOT_FOUND" });

      const { id: _, createdAt: __, updatedAt: ___, ...rest } = original;
      const [newOffer] = await db.insert(offers).values({
        ...rest,
        internalName: `${rest.internalName}-copy`,
        status: "draft",
        compiledConfig: null,
        functionMetafieldGid: null,
      }).returning({ id: offers.id });

      return { id: newOffer?.id };
    }),

  bulkAction: shopProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      action: z.enum(["activate","pause","archive"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const statusMap = { activate: "active", pause: "paused", archive: "archived" } as const;
      for (const id of input.ids) {
        await db.update(offers)
          .set({ status: statusMap[input.action], updatedAt: new Date() })
          .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, id)));
      }
      return { updated: input.ids.length };
    }),
});

// ── Settings procedures ───────────────────────────────────────────────────────

const settingsRouter = router({
  get: shopProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db.select({ value: appSettings.value })
        .from(appSettings)
        .where(and(eq(appSettings.shopId, ctx.shopId), eq(appSettings.key, input.key)))
        .limit(1);
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return row.value; }
    }),

  set: shopProcedure
    .input(z.object({ key: z.string(), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.insert(appSettings)
        .values({ shopId: ctx.shopId, key: input.key, value: JSON.stringify(input.value) })
        .onConflictDoUpdate({
          target: [appSettings.shopId, appSettings.key],
          set: { value: JSON.stringify(input.value), updatedAt: new Date() },
        });
      return { success: true };
    }),

  getAll: shopProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db.select().from(appSettings)
      .where(eq(appSettings.shopId, ctx.shopId));
    return Object.fromEntries(
      rows.map((r) => {
        try { return [r.key, JSON.parse(r.value)]; }
        catch { return [r.key, r.value]; }
      })
    );
  }),
});

// ── Analytics procedures ──────────────────────────────────────────────────────

const analyticsRouter = router({
  summary: shopProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const since = new Date(Date.now() - input.days * 86400000);

      const [impressions, giftAdds, checkouts, orders, errors] = await Promise.all([
        db.select({ count: count() }).from(analyticsEvents)
          .where(and(eq(analyticsEvents.shopId, ctx.shopId), eq(analyticsEvents.eventName, "promo_engine:widget_viewed"), gte(analyticsEvents.occurredAt, since))),
        db.select({ count: count() }).from(analyticsEvents)
          .where(and(eq(analyticsEvents.shopId, ctx.shopId), eq(analyticsEvents.eventName, "promo_engine:gift_auto_added"), gte(analyticsEvents.occurredAt, since))),
        db.select({ count: count() }).from(analyticsEvents)
          .where(and(eq(analyticsEvents.shopId, ctx.shopId), eq(analyticsEvents.eventName, "checkout_started"), gte(analyticsEvents.occurredAt, since))),
        db.select({ count: count() }).from(analyticsEvents)
          .where(and(eq(analyticsEvents.shopId, ctx.shopId), eq(analyticsEvents.eventName, "order_placed_attributed"), gte(analyticsEvents.occurredAt, since))),
        db.select({ count: count() }).from(analyticsEvents)
          .where(and(eq(analyticsEvents.shopId, ctx.shopId), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"), gte(analyticsEvents.occurredAt, since))),
      ]);

      return {
        impressions: impressions[0]?.count ?? 0,
        giftAdds: giftAdds[0]?.count ?? 0,
        checkouts: checkouts[0]?.count ?? 0,
        orders: orders[0]?.count ?? 0,
        errors: errors[0]?.count ?? 0,
        addRate: impressions[0]?.count ? ((giftAdds[0]?.count ?? 0) / impressions[0].count * 100).toFixed(1) : "0",
        conversionRate: checkouts[0]?.count ? ((orders[0]?.count ?? 0) / checkouts[0].count * 100).toFixed(1) : "0",
      };
    }),

  byOfferType: shopProcedure
    .input(z.object({ days: z.number().int().default(30) }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const since = new Date(Date.now() - input.days * 86400000);
      // Campaign breakdown by offer type
      const rows = await db.select({
        type: offers.type,
        adds: count(),
      })
        .from(analyticsEvents)
        .leftJoin(offers, eq(analyticsEvents.offerId, offers.id))
        .where(and(
          eq(analyticsEvents.shopId, ctx.shopId),
          eq(analyticsEvents.eventName, "promo_engine:gift_auto_added"),
          gte(analyticsEvents.occurredAt, since),
        ))
        .groupBy(offers.type);

      return rows;
    }),

  mutationHealth: shopProcedure
    .input(z.object({ hours: z.number().int().default(1) }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const since = new Date(Date.now() - input.hours * 3600000);

      const [total, errors] = await Promise.all([
        db.select({ count: count() }).from(cartMutationLogs)
          .where(and(eq(cartMutationLogs.shopId, ctx.shopId), gte(cartMutationLogs.createdAt, since))),
        db.select({ count: count() }).from(cartMutationLogs)
          .where(and(eq(cartMutationLogs.shopId, ctx.shopId), eq(cartMutationLogs.status, "error"), gte(cartMutationLogs.createdAt, since))),
      ]);

      const totalCount = total[0]?.count ?? 0;
      const errorCount = errors[0]?.count ?? 0;
      return {
        total: totalCount,
        errors: errorCount,
        successRate: totalCount > 0 ? (((totalCount - errorCount) / totalCount) * 100).toFixed(1) : "100",
        errorRate: totalCount > 0 ? ((errorCount / totalCount) * 100).toFixed(1) : "0",
      };
    }),
});

// ── Sync procedures ───────────────────────────────────────────────────────────

const syncRouter = router({
  triggerProductSync: shopProcedure.mutation(async ({ ctx }) => {
    const { productSyncQueue } = await import("../../../workers/product-sync/src/queues.js");
    const db = getDb();
    const [shop] = await db.select({ accessTokenEncrypted: shops.accessTokenEncrypted, myshopifyDomain: shops.myshopifyDomain })
      .from(shops).where(eq(shops.id, ctx.shopId)).limit(1);
    if (!shop) throw new TRPCError({ code: "NOT_FOUND" });

    const { decryptToken } = await import("../../app/lib/token-crypto.server.js");
    await productSyncQueue.add("manual-full-sync", {
      shopId: ctx.shopId,
      shopDomain: shop.myshopifyDomain,
      accessToken: await decryptToken(shop.accessTokenEncrypted),
      mode: "full",
    });
    return { queued: true };
  }),
});

// ── Root router ───────────────────────────────────────────────────────────────

export const appRouter = router({
  offers: offersRouter,
  settings: settingsRouter,
  analytics: analyticsRouter,
  sync: syncRouter,
});

export type AppRouter = typeof appRouter;

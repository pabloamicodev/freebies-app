import { offers, shops, type Db } from "@promo/db";
import { and, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import {
  publishShopConfig,
  validateOffersPublishable,
  type PublishValidationResult,
} from "./offer-publish-flow.server.js";

export type OfferStatus = "draft" | "active" | "paused" | "scheduled" | "expired" | "archived";

export type DueOffer = {
  id: string;
  shopId: string;
  shopDomain: string;
  status: "active" | "scheduled";
  startsAt: Date | null;
  endsAt: Date | null;
};

export type OfferScheduleTransition = DueOffer & {
  from: "active" | "scheduled";
  to: "active" | "expired";
};

export type OfferScheduleFailure = {
  shopId: string;
  shopDomain: string;
  stage: "validation" | "apply" | "publish" | "rollback" | "restore";
  error: string;
};

export type OfferScheduleDependencies = {
  loadDueOffers(now: Date): Promise<DueOffer[]>;
  applyTransitions(transitions: OfferScheduleTransition[], now: Date): Promise<void>;
  rollbackTransitions(transitions: OfferScheduleTransition[], now: Date): Promise<void>;
  validateOffers(shopId: string, offerIds: string[]): Promise<PublishValidationResult>;
  publishShop(shopId: string, shopDomain: string): Promise<string | null>;
};

export function statusForSubmit(intent: string, startsAt: Date | null, now = new Date()): "draft" | "active" | "scheduled" {
  if (intent !== "publish") return "draft";
  return startsAt && startsAt > now ? "scheduled" : "active";
}

export function statusForScheduleSave(currentStatus: OfferStatus, startsAt: Date | null, endsAt: Date | null, now = new Date()): OfferStatus {
  if (currentStatus === "archived" || currentStatus === "draft") return currentStatus;
  if (endsAt && endsAt <= now) return "expired";
  if (startsAt && startsAt > now) return "scheduled";
  if (currentStatus === "scheduled" || currentStatus === "expired") return "active";
  return currentStatus;
}

export function planOfferScheduleTransitions(
  rows: DueOffer[],
  now: Date,
): OfferScheduleTransition[] {
  const transitions: OfferScheduleTransition[] = [];
  for (const row of rows) {
    if (row.endsAt && row.endsAt <= now) {
      transitions.push({ ...row, from: row.status, to: "expired" });
    } else if (row.status === "scheduled" && row.startsAt && row.startsAt <= now) {
      transitions.push({ ...row, from: row.status, to: "active" });
    }
  }
  return transitions;
}

export async function executeOfferSchedule(
  dependencies: OfferScheduleDependencies,
  now = new Date(),
): Promise<{ activated: number; expired: number; failures: OfferScheduleFailure[] }> {
  const transitions = planOfferScheduleTransitions(await dependencies.loadDueOffers(now), now);
  const groups = new Map<string, OfferScheduleTransition[]>();
  for (const transition of transitions) {
    const group = groups.get(transition.shopId) ?? [];
    group.push(transition);
    groups.set(transition.shopId, group);
  }
  let activated = 0;
  let expired = 0;
  const failures: OfferScheduleFailure[] = [];

  for (const [shopId, shopTransitions] of groups) {
    const shopDomain = shopTransitions[0]!.shopDomain;
    const activationIds = shopTransitions
      .filter((transition) => transition.to === "active")
      .map((transition) => transition.id);
    let applicable = shopTransitions;

    if (activationIds.length > 0) {
      const validation = await dependencies.validateOffers(shopId, activationIds);
      if (!validation.ok) {
        failures.push({
          shopId,
          shopDomain,
          stage: "validation",
          error: validation.error ?? "Offer is not publishable",
        });
        applicable = applicable.filter((transition) => transition.to !== "active");
      }
    }
    if (applicable.length === 0) continue;

    try {
      await dependencies.applyTransitions(applicable, now);
    } catch (error) {
      failures.push({ shopId, shopDomain, stage: "apply", error: errorMessage(error) });
      continue;
    }

    const publishError = await publisherError(dependencies, shopId, shopDomain);
    if (!publishError) {
      activated += applicable.filter((transition) => transition.to === "active").length;
      expired += applicable.filter((transition) => transition.to === "expired").length;
      continue;
    }

    failures.push({ shopId, shopDomain, stage: "publish", error: publishError });
    try {
      await dependencies.rollbackTransitions(applicable, now);
    } catch (error) {
      failures.push({ shopId, shopDomain, stage: "rollback", error: errorMessage(error) });
      continue;
    }

    const restoreError = await publisherError(dependencies, shopId, shopDomain);
    if (restoreError) {
      failures.push({ shopId, shopDomain, stage: "restore", error: restoreError });
    }
  }

  return { activated, expired, failures };
}

export async function runOfferScheduler(db: Db, now = new Date()) {
  const dependencies: OfferScheduleDependencies = {
    async loadDueOffers(at) {
      const rows = await db
        .select({
          id: offers.id,
          shopId: offers.shopId,
          shopDomain: shops.myshopifyDomain,
          status: offers.status,
          startsAt: offers.startsAt,
          endsAt: offers.endsAt,
        })
        .from(offers)
        .innerJoin(shops, and(eq(shops.id, offers.shopId), eq(shops.isActive, true)))
        .where(or(
          and(eq(offers.status, "scheduled"), isNotNull(offers.startsAt), lte(offers.startsAt, at)),
          and(inArray(offers.status, ["active", "scheduled"]), isNotNull(offers.endsAt), lte(offers.endsAt, at)),
        ));
      return rows.filter(
        (row): row is DueOffer => row.status === "active" || row.status === "scheduled",
      );
    },
    async applyTransitions(rows, at) {
      await db.transaction(async (tx) => {
        for (const transition of rows) {
          const updated = await tx
            .update(offers)
            .set({ status: transition.to, updatedAt: at })
            .where(and(eq(offers.id, transition.id), eq(offers.status, transition.from)))
            .returning({ id: offers.id });
          if (updated.length !== 1) {
            throw new Error(`Offer ${transition.id} changed while the scheduler was running`);
          }
        }
      });
    },
    async rollbackTransitions(rows, at) {
      await db.transaction(async (tx) => {
        for (const transition of rows) {
          const restored = await tx
            .update(offers)
            .set({ status: transition.from, updatedAt: new Date() })
            .where(and(
              eq(offers.id, transition.id),
              eq(offers.status, transition.to),
              eq(offers.updatedAt, at),
            ))
            .returning({ id: offers.id });
          if (restored.length !== 1) {
            throw new Error(`Offer ${transition.id} could not be rolled back safely`);
          }
        }
      });
    },
    validateOffers: (shopId, offerIds) => validateOffersPublishable(db, shopId, offerIds),
    publishShop: publishShopConfig,
  };

  return executeOfferSchedule(dependencies, now);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function publisherError(
  dependencies: OfferScheduleDependencies,
  shopId: string,
  shopDomain: string,
): Promise<string | null> {
  try {
    return await dependencies.publishShop(shopId, shopDomain);
  } catch (error) {
    return errorMessage(error);
  }
}

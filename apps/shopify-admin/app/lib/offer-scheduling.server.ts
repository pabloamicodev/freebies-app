import { offers, type Db } from "@promo/db";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";

export type OfferStatus = "draft" | "active" | "paused" | "scheduled" | "expired" | "archived";

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

export async function runOfferScheduler(db: Db, now = new Date()) {
  const activated = await db
    .update(offers)
    .set({ status: "active", updatedAt: now })
    .where(and(eq(offers.status, "scheduled"), isNotNull(offers.startsAt), lte(offers.startsAt, now)))
    .returning({ id: offers.id });

  const expired = await db
    .update(offers)
    .set({ status: "expired", updatedAt: now })
    .where(and(inArray(offers.status, ["active", "scheduled"]), isNotNull(offers.endsAt), lte(offers.endsAt, now)))
    .returning({ id: offers.id });

  return {
    activated: activated.length,
    expired: expired.length,
  };
}

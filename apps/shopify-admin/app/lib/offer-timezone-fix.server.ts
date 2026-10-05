import { parseLocalDateTimeInZone, toZonedLocalInput } from "./offer-validation.server.js";
import { statusForScheduleSave, type OfferStatus } from "./offer-scheduling.server.js";

export type TzFixInput = { status: OfferStatus; startsAt: Date | null; endsAt: Date | null };
export type TzFixPlan = { status: OfferStatus; startsAt: Date | null; endsAt: Date | null; changed: boolean };

const FIXABLE: OfferStatus[] = ["draft", "scheduled", "active", "paused"];

/** Stored instants were the merchant's wall-clock read as UTC; re-read the same wall-clock in the shop zone. */
export function reinterpretInZone(date: Date | null, shopTz: string): Date | null {
  if (!date) return null;
  return parseLocalDateTimeInZone(toZonedLocalInput(date, "UTC"), shopTz);
}

export function planTimezoneFix(offer: TzFixInput, shopTz: string, now = new Date()): TzFixPlan | null {
  if (!FIXABLE.includes(offer.status)) return null;
  const startsAt = reinterpretInZone(offer.startsAt, shopTz);
  const endsAt = reinterpretInZone(offer.endsAt, shopTz);
  const status = offer.status === "paused" ? "paused" : statusForScheduleSave(offer.status, startsAt, endsAt, now);
  const changed = startsAt?.getTime() !== offer.startsAt?.getTime() || endsAt?.getTime() !== offer.endsAt?.getTime() || status !== offer.status;
  return { status, startsAt, endsAt, changed };
}

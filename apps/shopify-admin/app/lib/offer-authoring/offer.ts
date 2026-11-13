import { z } from "zod";
import { resolveCartLabels } from "../cart-labels.js";
import { resolveDiscountMessage } from "../discount-message.js";
import { parseLocalDateTimeInZone } from "../offer-validation.server.js";
import { statusForSubmit } from "../offer-scheduling.server.js";
import type { AuthoringResult } from "./types.js";

/** Offer-level authoring fields shared by promo_create and promo_update (the wizards' details step). */

export const OFFER_TYPES = ["discount", "gift", "bundle", "upsell", "shipping", "booster"] as const;

const dateInput = z.string().trim().max(40);

export const AuthoringOfferFields = {
  internalName: z.string().trim().min(1).max(120).describe("Internal name, unique per shop (a suffix is added when it is taken)."),
  publicTitle: z.string().trim().max(120).optional().describe("Discount message shown in cart and checkout, max 60 characters. Defaults to the internal name."),
  cartLabels: z.array(z.string().trim().min(1)).max(3).optional().describe("Up to 3 short labels (40 characters each) appended to the discount name in cart and checkout."),
  description: z.string().trim().max(2000).nullable().optional().describe("Free-text description; null clears it on update."),
  priority: z.number().int().min(1).max(10000).optional().describe("Lower number wins when offers compete. Default 100."),
  startsAt: dateInput.nullable().optional().describe("Shop-local 'YYYY-MM-DDTHH:mm' (or an ISO instant). A future start schedules the offer."),
  endsAt: dateInput.nullable().optional().describe("Shop-local 'YYYY-MM-DDTHH:mm' (or an ISO instant); needs startsAt."),
  tierMode: z.enum(["cumulative", "highest"]).nullable().optional().describe("Gift offers only: cumulative gives every reached tier, highest only the top one."),
};

export type OfferDates = { startsAt: Date | null; endsAt: Date | null };

/** Same rules as parseDateRange (the wizards): invalid dates, end before start, end without start. */
export function parseOfferDates(raw: { startsAt?: string | null; endsAt?: string | null }, timezone: string): AuthoringResult<OfferDates> {
  const startsAt = raw.startsAt ? parseLocalDateTimeInZone(raw.startsAt, timezone) : null;
  const endsAt = raw.endsAt ? parseLocalDateTimeInZone(raw.endsAt, timezone) : null;
  if (raw.startsAt && (!startsAt || Number.isNaN(startsAt.getTime()))) return { ok: false, error: "Start date is invalid.", path: "startsAt" };
  if (raw.endsAt && (!endsAt || Number.isNaN(endsAt.getTime()))) return { ok: false, error: "End date is invalid.", path: "endsAt" };
  if (startsAt && endsAt && endsAt <= startsAt) return { ok: false, error: "End date must be after start date.", path: "endsAt" };
  if (endsAt && !startsAt) return { ok: false, error: "Set a start date before setting an end date.", path: "endsAt" };
  return { ok: true, value: { startsAt, endsAt } };
}

export function resolveOfferText(raw: { internalName: string; publicTitle?: string; cartLabels?: string[] }): AuthoringResult<{ publicTitle: string; cartLabels: string[] }> {
  const title = resolveDiscountMessage(raw.publicTitle, raw.internalName);
  if (!title.ok) return { ok: false, error: title.error, path: "publicTitle" };
  const labels = resolveCartLabels(raw.cartLabels);
  if (!labels.ok) return { ok: false, error: labels.error, path: "cartLabels" };
  return { ok: true, value: { publicTitle: title.value, cartLabels: labels.labels } };
}

/** draft stays draft; active becomes scheduled for a future start, as the wizards' publish intent does. */
export function statusFor(requested: "draft" | "active", startsAt: Date | null, now = new Date()): "draft" | "active" | "scheduled" {
  return statusForSubmit(requested === "active" ? "publish" : "draft", startsAt, now);
}

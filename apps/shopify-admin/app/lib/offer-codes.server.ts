/**
 * Typed service behind the offer Codes tab (routes/app.offers.$id.codes.tsx) and the MCP code tools.
 * Every intent the tab posts lives here once: add a code, generate a batch, (de)activate, discount
 * message, redemption mode, retry the original code, delete. The route is a FormData adapter, the MCP
 * tools are zod adapters; validation messages, publish and rollback behaviour are the route's.
 */

import { and, asc, eq } from "drizzle-orm";
import { discountCodes, offerConditions, offers, type Db, type DiscountCode } from "@promo/db";
import type { AuthoringDeps, WriteServiceOptions } from "./offer-authoring/types.js";
import { republishIfActive, type CapacityDetails } from "./offer-publish-flow.server.js";
import {
  createDiscountCode,
  createDiscountCodeBatch,
  deleteDiscountCodes,
  setDiscountCodesStatus,
  validateBatchEntropy,
  codeFilter,
  normalizeTypedCode,
  validateCodeSettings,
  type CodeListQuery,
  type CodeSettings,
} from "./discount-codes.server.js";
import { discountCodesToCsv, validateBatchSpec, type BatchSpec } from "./discount-code-generation.js";
import { resolveDiscountMessage } from "./discount-message.js";
import type { CodeRedemptionMode } from "./code-redemption.js";
import { preflightCapacity } from "./capacity-preflight.server.js";
import { retryOriginalCode } from "./code-retry.server.js";
import { insertCodeOffer, type CodeOfferDraft } from "./code-offer-wizard.server.js";
import { activateDraftOffer, type OfferLifecycleFailure, type OfferStatus } from "./offer-lifecycle.server.js";

// Above this many new codes, publishing inline could outlive the request; the
// publish continues in the background and the cron retries anything unsynced.
export const INLINE_PUBLISH_LIMIT = 500;

export type OfferCodesCommand =
  | { intent: "add_code"; code: unknown; settings: CodeSettings }
  | { intent: "generate_batch"; spec: BatchSpec; settings: CodeSettings }
  | { intent: "set_status"; status: "active" | "disabled"; target: { ids?: string[]; batchId?: string; all?: boolean } }
  | { intent: "set_discount_message"; message: unknown }
  | { intent: "set_redemption_mode"; mode: CodeRedemptionMode }
  | { intent: "retry_original"; codeId: string }
  | { intent: "delete"; ids: string[] };

export type OfferCodesOptions = WriteServiceOptions & {
  /** The admin route continues big publishes in the background; other callers always publish inline. */
  allowDeferredPublish?: boolean;
};

export type OfferCodesSuccess = {
  ok: true;
  /** The sentence the admin tab shows (already carries the "goes live when published" suffix when it applies). */
  message: string;
  warning?: string;
  /** The caller must run publishShopConfig in the background (only when allowDeferredPublish was set). */
  deferredPublish?: boolean;
  wasActive: boolean;
  created?: number;
  batchId?: string;
  code?: DiscountCode;
  changed?: number;
  deleted?: number;
  dryRun?: boolean;
};

export type OfferCodesFailure = {
  ok: false;
  kind: "not_found" | "validation" | "publish_failed";
  error: string;
  capacity?: CapacityDetails;
};

export type OfferCodesResult = OfferCodesSuccess | OfferCodesFailure;

const invalid = (error: string, capacity?: CapacityDetails): OfferCodesFailure => ({
  ok: false,
  kind: "validation",
  error,
  ...(capacity ? { capacity } : {}),
});

const plural = (n: number, noun: string) => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;

export async function runOfferCodesCommand(
  deps: AuthoringDeps,
  offerId: string,
  command: OfferCodesCommand,
  opts: OfferCodesOptions,
): Promise<OfferCodesResult> {
  const { db, shopId, shopDomain } = deps;
  const [offer] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)))
    .limit(1);
  if (!offer) return { ok: false, kind: "not_found", error: "Offer not found." };
  const wasActive = offer.status === "active";
  const dryRun = opts.dryRun === true;
  let publishLarge = false;
  let message = "";
  let warning = "";
  const extra: Partial<OfferCodesSuccess> = {};

  switch (command.intent) {
    case "add_code": {
      if (dryRun) {
        const normalized = normalizeTypedCode(command.code);
        if (!normalized.ok) return invalid(normalized.error);
        const settingsError = validateCodeSettings(command.settings);
        if (settingsError) return invalid(settingsError);
        return { ok: true, wasActive, dryRun: true, message: `Code ${normalized.code} would be created.` };
      }
      const result = await createDiscountCode(db, { shopId, offerId, code: command.code, ...command.settings });
      if (!result.ok) return invalid(result.error);
      message = `Code ${result.code.code} created.`;
      warning = result.warning ?? "";
      extra.code = result.code;
      extra.created = 1;
      break;
    }
    case "generate_batch": {
      if (dryRun) {
        const specError = validateBatchSpec(command.spec) ?? validateBatchEntropy(command.spec);
        if (specError) return invalid(specError);
        const settingsError = validateCodeSettings(command.settings);
        if (settingsError) return invalid(settingsError);
        return { ok: true, wasActive, dryRun: true, message: `${command.spec.count.toLocaleString("en-US")} codes would be generated.` };
      }
      const result = await createDiscountCodeBatch(db, { shopId, offerId, spec: command.spec, ...command.settings });
      if (!result.ok) return invalid(result.error);
      publishLarge = result.created > INLINE_PUBLISH_LIMIT;
      message = `${result.created.toLocaleString("en-US")} codes generated.`;
      extra.created = result.created;
      extra.batchId = result.batchId;
      break;
    }
    case "set_status": {
      const { ids, batchId, all } = command.target;
      if (!ids?.length && !batchId && !all) return invalid("Select at least one code.");
      if (dryRun) return { ok: true, wasActive, dryRun: true, message: `Codes would be ${command.status === "active" ? "activated" : "deactivated"}.` };
      const changed = await setDiscountCodesStatus(db, shopId, offerId, { ids: ids?.length ? ids : undefined, batchId: batchId || undefined, all }, command.status);
      publishLarge = changed > INLINE_PUBLISH_LIMIT;
      message = `${plural(changed, "code")} ${command.status === "active" ? "activated" : "deactivated"}.`;
      extra.changed = changed;
      break;
    }
    case "set_discount_message": {
      const result = resolveDiscountMessage(command.message, offer.internalName);
      if (!result.ok) return invalid(result.error);
      if (dryRun) return { ok: true, wasActive, dryRun: true, message: `Discount message would be "${result.value}".` };
      await db
        .update(offers)
        .set({ publicTitle: result.value, updatedAt: new Date() })
        .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      message = "Discount message saved.";
      break;
    }
    case "set_redemption_mode": {
      const mode = command.mode;
      if (mode !== "checkout_code" && mode !== "automatic") return invalid("Unknown redemption mode.");
      if (mode === offer.codeRedemption) return { ok: true, wasActive, message: "Already set.", ...(dryRun ? { dryRun: true } : {}) };
      if (mode === "automatic") {
        // Without a code the conditions are the only gate: an offer with none would apply to every cart.
        const [mainCondition] = await db
          .select({ id: offerConditions.id })
          .from(offerConditions)
          .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.scope, "main"), eq(offerConditions.isEnabled, true)))
          .limit(1);
        if (!mainCondition) return invalid("Add at least one enabled condition first; without a code it would apply to every cart.");
        const capacity = await preflightCapacity(db, shopId, [offerId], { forceInclude: true });
        if (!capacity.ok) return invalid(capacity.message, { code: capacity.code, offerIds: capacity.offerIds, numbers: capacity.numbers });
      }
      const text = mode === "automatic" ? "Offer now applies automatically. Its codes are paused." : "Customers now enter a code at checkout again.";
      if (dryRun) return { ok: true, wasActive, dryRun: true, message: text };
      await db
        .update(offers)
        .set({ codeRedemption: mode, updatedAt: new Date() })
        .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      message = text;
      break;
    }
    case "retry_original": {
      if (dryRun) return { ok: true, wasActive, dryRun: true, message: "The original code would be restored." };
      const result = await retryOriginalCode(db, shopId, shopDomain, command.codeId);
      if (!result.ok) return invalid(result.error);
      message = `Switched back to ${result.code}.`;
      break;
    }
    case "delete": {
      const ids = command.ids;
      if (dryRun) return { ok: true, wasActive, dryRun: true, message: `${plural(ids.length, "code")} would be deleted.` };
      const deleted = await deleteDiscountCodes(db, shopId, offerId, ids);
      if (deleted < ids.length) {
        return invalid(
          deleted === 0
            ? "Deactivate a code first; it can be deleted once it has been removed from Shopify."
            : `Deleted ${deleted} of ${ids.length}. The rest are still on Shopify; deactivate them first.`,
        );
      }
      return { ok: true, wasActive, deleted, message: `${plural(deleted, "code")} deleted.` };
    }
  }

  if (dryRun) return { ok: true, wasActive, dryRun: true, message };
  if (publishLarge && wasActive && opts.allowDeferredPublish) {
    return {
      ok: true,
      wasActive,
      deferredPublish: true,
      message: `${message} They are being added to Shopify and will work in a few minutes.`,
      ...(warning ? { warning } : {}),
      ...extra,
    };
  }
  const publishError = await republishIfActive(db, shopId, shopDomain, offerId, wasActive, opts.publish);
  if (publishError) return { ok: false, kind: "publish_failed", error: publishError };
  return {
    ok: true,
    wasActive,
    message: wasActive ? message : `${message} They go live when the offer is published.`,
    ...(warning ? { warning } : {}),
    ...extra,
  };
}

export const EXPORT_DEFAULT_LIMIT = 500;
export const EXPORT_MAX_LIMIT = 2000;

/**
 * One bounded page of an offer's codes as CSV (unmasked, same columns and order as
 * GET /api/offers/:id/codes/export, which streams the whole set). `offset` pages through the rest.
 */
export async function exportOfferCodesPage(
  db: Db,
  shopId: string,
  offerId: string,
  query: CodeListQuery & { limit?: number; offset?: number } = {},
): Promise<{ csv: string; rows: DiscountCode[]; total: number; offset: number; limit: number; nextOffset: number | null }> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? EXPORT_DEFAULT_LIMIT), 1), EXPORT_MAX_LIMIT);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const where = codeFilter(shopId, offerId, query);
  const [rows, total] = await Promise.all([
    db.select().from(discountCodes).where(where).orderBy(asc(discountCodes.createdAt), asc(discountCodes.code)).limit(limit).offset(offset),
    db.$count(discountCodes, where),
  ]);
  const end = offset + rows.length;
  return { csv: discountCodesToCsv(rows), rows, total, offset, limit, nextOffset: end < total ? end : null };
}

export type CreateCodeOfferResult =
  | { ok: false; error: string }
  | {
      ok: true;
      dryRun: boolean;
      /** Empty on a dry run. */
      offerId: string;
      codesCreated: number;
      status: OfferStatus;
      warnings?: string[];
      /** Set when the offer and its codes exist but going live failed; the offer stays a draft. */
      activationFailure?: OfferLifecycleFailure;
    };

/**
 * Creates a code offer exactly like the Discount Codes wizard (one transaction: offer, codes, conditions, reward,
 * combination policy), then, when the draft asks for `active`/`scheduled`, goes live through the same
 * draft-activation flow as the Publish button: capacity preflight, publish, status put back if it fails.
 * A failed activation leaves a complete draft (the wizard does the same), so resubmitting is never needed.
 */
export async function createCodeOffer(deps: AuthoringDeps, draft: CodeOfferDraft, opts: WriteServiceOptions): Promise<CreateCodeOfferResult> {
  const { db, shopId, shopDomain, timezone } = deps;
  const created = await insertCodeOffer(db, shopId, timezone, { ...draft, status: "draft" }, undefined, { dryRun: opts.dryRun });
  if (!created.ok) return created;
  const { offerId, codesCreated } = created.data;
  if (opts.dryRun) return { ok: true, dryRun: true, offerId, codesCreated, status: draft.status };
  if (draft.status === "draft") return { ok: true, dryRun: false, offerId, codesCreated, status: "draft" };
  const activation = await activateDraftOffer(db, { shopId, shopDomain, offerId }, { performedBy: opts.performedBy, auditExtra: opts.auditExtra, publish: opts.publish });
  if (!activation.ok) return { ok: true, dryRun: false, offerId, codesCreated, status: "draft", activationFailure: activation };
  return {
    ok: true,
    dryRun: false,
    offerId,
    codesCreated,
    status: activation.statusAfter,
    ...(activation.warnings?.length ? { warnings: activation.warnings } : {}),
  };
}

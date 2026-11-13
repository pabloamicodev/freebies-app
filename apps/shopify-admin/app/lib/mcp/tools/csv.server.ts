import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_CSV_BYTES, MAX_CSV_ROWS } from "../../csv.js";
import { exportOffersCsv, OFFER_CSV_HEADERS } from "../../offer-csv-export.server.js";
import { importOffersCsv, type CsvImportReport } from "../../offer-csv-import.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, buildResult, promoRef, shopHandle, type Warning } from "../result.server.js";
import { runTool, toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type CallInfo } from "../write-runner.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";

const MAX_REFS = 200;

export const offersExportCsvInput = {
  shop: z.string().max(200).describe("Shop domain or handle to export from."),
  refs: z
    .array(z.string().max(200))
    .max(MAX_REFS)
    .optional()
    .describe(`Only these offers: promo:<shopHandle>:<offerId> refs or bare offer ids of that shop (max ${MAX_REFS}). Omitted = every offer of the shop, every status.`),
};

export const offersImportCsvInput = {
  shop: z.string().max(200).describe("Shop domain or handle that receives the offers."),
  csv: z
    .string()
    .min(1)
    .max(MAX_CSV_BYTES)
    .describe(
      `The CSV text, header row first (same format as the admin Import page and offers_export_csv; max ${MAX_CSV_BYTES.toLocaleString()} bytes, ${MAX_CSV_ROWS.toLocaleString()} rows, 50 columns). Required columns: internal_name, type (gift|bundle|upsell|discount|booster). Optional: public_title, priority, condition_type + condition_value_threshold_cents (cart_value|cart_quantity), reward_type + discount_type + reward_value, gift_variant_gids (pipe-separated), gift_quantity, is_auto_add, track_mode, discount_tags, requires_code, code_redemption; gift tiers use one row per tier (gift_min_cart_subtotal_cents, gift_tier_mode, gift_fallback_variant_gids) sharing offer_id or internal_name.`,
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("Default false. true parses and validates every row and returns the per-row report without writing anything."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};

type ExportArgs = { shop: string; refs?: string[] };
type ImportArgs = { shop: string; csv: string; dryRun?: boolean; idempotencyKey?: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Exports one shop's offers (all or the given refs) as the same CSV the admin export route serves. */
export function offersExportCsv(ctx: McpContext, args: ExportArgs): Promise<CallToolResult> {
  return runTool(async () => {
    const visible = await visibleShops(ctx.db, ctx.operator);
    const [shop] = selectShops(visible, [args.shop]);
    let offerIds: string[] | undefined;
    if (args.refs) {
      offerIds = [...new Set(args.refs.map((r) => {
        const resolved = resolvePromoRef(visible, { ref: r, shop: args.shop });
        if (resolved.shop.id !== shop!.id) throw new ToolError("VALIDATION", `Ref "${r}" belongs to another shop; export one shop per call.`);
        return resolved.offerId;
      }))];
    }
    const out = await exportOffersCsv(ctx.db, { shopId: shop!.id, shopCurrency: shop!.currencyCode ?? "USD" }, { offerIds, maxBytes: MAX_CSV_BYTES });

    const warnings: Warning[] = [];
    if (out.truncated) {
      warnings.push({
        code: "CSV_TRUNCATED",
        severity: "warn",
        message: `The CSV is capped at ${MAX_CSV_BYTES.toLocaleString()} bytes: ${out.offerCount} of ${out.matchedOffers} offers were written. Pass refs to export the rest in batches.`,
      });
    }
    if (offerIds && out.matchedOffers < offerIds.length) {
      warnings.push({ code: "OFFERS_NOT_FOUND", severity: "warn", message: `${offerIds.length - out.matchedOffers} of ${offerIds.length} requested offers were not found in this shop.` });
    }
    return buildResult(
      {
        summary: `Exported ${plural(out.offerCount, "offer")} (${plural(out.rowCount, "row")}) from ${shop!.myshopifyDomain} as CSV.`,
        data: { csv: out.csv, offerCount: out.offerCount, rowCount: out.rowCount, truncated: out.truncated, columns: [...OFFER_CSV_HEADERS] },
        links: [adminLink(shopHandle(shop!.myshopifyDomain))],
        warnings,
        nextActions: [{ mcp: "promo-engine", tool: "offers_import_csv", args: { shop: shop!.myshopifyDomain, dryRun: true }, why: "Re-import (into this or another shop) after a dry run; pass the csv text.", risk: "write" }],
      },
      ctx.now,
    );
  });
}

function reportBody(shop: VisibleShop, report: CsvImportReport) {
  const { offers, errors } = report;
  const offerLine = report.dryRun
    ? `${plural(offers.length, "offer")} valid and ready to import as drafts`
    : `${plural(report.created.length, "offer")} created as drafts`;
  const summary = `${offerLine}${errors.length ? `, ${plural(errors.length, "row")} failed` : ""} (${shop.myshopifyDomain}).`;
  return {
    summary,
    data: {
      dryRun: report.dryRun,
      created: report.created.length,
      valid: offers.length,
      failed: errors.length,
      offers: offers.map((o) => ({ row: o.row, internalName: o.internalName, type: o.type, offerId: o.offerId, promoRef: o.offerId ? promoRef(shop.myshopifyDomain, o.offerId) : null })),
      errors,
    },
    warnings: errors.length ? [{ code: "ROWS_FAILED", severity: "warn" as const, message: `${plural(errors.length, "row")} did not import; see data.errors (row numbers count the header as row 1).` }] : [],
    links: [adminLink(shopHandle(shop.myshopifyDomain))],
  };
}

/** Imports offers from CSV text as drafts, exactly like the admin Import page; dryRun returns only the validation report. */
export async function offersImportCsv(ctx: McpContext, call: CallInfo, args: ImportArgs): Promise<CallToolResult> {
  const started = performance.now();
  let shop: VisibleShop;
  try {
    [shop] = selectShops(await visibleShops(ctx.db, ctx.operator), [args.shop]) as [VisibleShop];
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool: "offers_import_csv", shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
  const deps = { db: ctx.db, shopId: shop.id, shopCurrency: shop.currencyCode ?? "USD", timezone: shop.timezone ?? "UTC" };
  const run = async (dryRun: boolean, extra: { performedBy?: string; auditExtra?: Record<string, unknown> } = {}) => {
    const report = await importOffersCsv(deps, args.csv, { dryRun, ...extra });
    if (report.error) throw new ToolError("VALIDATION", report.error);
    return report;
  };
  return runWrite(ctx, call, {
    tool: "offers_import_csv",
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: [shop],
    preview: async () => ({ ...reportBody(shop, await run(true)), offerUpdatedAt: null }),
    apply: async (a) => {
      const body = reportBody(shop, await run(false, { performedBy: a.performedBy, auditExtra: a.auditExtra }));
      return {
        ...body,
        nextActions: [{ mcp: "promo-engine", tool: "promos_active", args: { shops: [shop.myshopifyDomain], status: ["draft"] }, why: "Review the imported drafts before activating them.", risk: "read" as const }],
      };
    },
  });
}

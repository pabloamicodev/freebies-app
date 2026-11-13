import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { capacityActions, capacityIncidents, type CapacityIncident, type Db } from "@promo/db";
import { discountOps, UNDO_WINDOW_MS, type ApplyDeps } from "../../capacity-apply.server.js";
import { runIncidentIntent } from "../../capacity-incident-actions.server.js";
import { listOpenIncidents, listRecentlyResolved, recentActions } from "../../capacity-incidents.server.js";
import { loadOfferRows } from "../../capacity-transforms.server.js";
import { proposeForIncident } from "../../capacity-workarounds.server.js";
import { WORKAROUND_KINDS, type IncidentProposals, type WorkaroundProposal, type WorkaroundResult } from "../../capacity-workarounds.js";
import { workaroundCopy } from "../../capacity-workaround-copy.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, buildResult, capacityToolError, shopHandle, type ToolResult, type Warning } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, ref } from "./catalog-shared.server.js";

const MAX_INCIDENTS = 10;
const STATUSES = ["open", "snoozed", "dismissed", "resolved"] as const;

const shopField = z.string().max(200).describe("Shop domain, handle or id (one shop per call).");
const controls = {
  dryRun: z.boolean().optional().describe("Optional, default false. true previews what the call would change without writing anything."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};

export const capacityIncidentsListInput = {
  shop: shopField,
  status: z
    .enum(STATUSES)
    .optional()
    .describe("open (default: not snoozed), snoozed (open but reminders paused for 24 h), dismissed, resolved (last 7 days)."),
  incidentId: z.string().uuid().optional().describe("Only this incident."),
  includeDiscountCandidates: z
    .boolean()
    .optional()
    .describe("Default false. true also reads the store's active automatic discounts from Shopify (one Admin API call) so the deactivate_discounts workaround lists the native ones you may pick; other apps' discounts are listed as not selectable."),
};
export const capacityIncidentApplyInput = {
  shop: shopField,
  incidentId: z.string().uuid().describe("From capacity_incidents_list."),
  workaround: z.enum(WORKAROUND_KINDS).describe("The proposal's workaroundId from capacity_incidents_list (use_whole_products, require_any, reduce_gift_options, split_offer, sync_products, pause_offers, deactivate_discounts, allow_combine)."),
  selected: z
    .array(z.string().max(300))
    .max(50)
    .optional()
    .describe("Explicit picks, exactly as the admin dialog checkboxes. pause_offers: offer ids to pause (from the proposal's selection options). deactivate_discounts: Shopify discount node ids of NATIVE automatic discounts (never another app's; the call is refused otherwise). Not used by the other workarounds (reduce_gift_options keeps the number the proposal states)."),
  confirm: z.boolean().optional().describe("Required (true) when the proposal's requiresConfirm is true: you confirm you understand what changes for customers."),
  expectedVersions: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional offerVersions map from capacity_incidents_list. Omitted = the current versions are used. Pass it to refuse if any offer changed since you looked (STATE_CONFLICT)."),
  ...controls,
};
export const capacityIncidentUndoInput = {
  shop: shopField,
  actionId: z.string().uuid().describe("The actionId returned by capacity_incident_apply, or listed under the incident's recentActions."),
  ...controls,
};
export const capacityIncidentDismissInput = {
  shop: shopField,
  incidentId: z.string().uuid().describe("An open incident from capacity_incidents_list."),
  ...controls,
};
export const capacityIncidentSnoozeInput = { shop: shopField, ...controls };

export type CapacityToolDeps = Pick<ApplyDeps, "capacity" | "discounts" | "syncProducts" | "isPending">;

const shopRef = (shop: VisibleShop) => ({ id: shop.id, domain: shop.myshopifyDomain });
const depsOf = (ctx: McpContext, extra: CapacityToolDeps, publish?: ApplyDeps["publish"]): ApplyDeps => ({
  env: ctx.env,
  now: ctx.now,
  ...extra,
  ...(publish ? { publish } : {}),
});

type ListedProposal = {
  workaroundId: string;
  title: string;
  summary: string;
  /** The "What changes for customers" line of the dialog. */
  whatChangesForCustomers: string;
  requiresConfirm: boolean;
  offerVersions: Record<string, string>;
  params: Record<string, unknown>;
  selection?: { label: string; minSelected: number; items: { id: string; label: string; checked: boolean }[]; notSelectable?: { id: string; label: string; reason: string }[]; lazy?: boolean };
  note?: string;
};

function listProposal(proposal: WorkaroundProposal): ListedProposal {
  return {
    workaroundId: proposal.kind,
    title: proposal.title,
    summary: proposal.summary,
    whatChangesForCustomers: proposal.customerChange,
    requiresConfirm: proposal.semanticChange,
    offerVersions: proposal.offerVersions,
    params: proposal.params,
    ...(proposal.options
      ? { selection: { label: proposal.options.label, minSelected: proposal.options.minSelected, items: proposal.options.items, ...(proposal.options.lazy ? { lazy: true } : {}) } }
      : {}),
    ...(proposal.note ? { note: proposal.note } : {}),
  };
}

async function discountSelection(db: Db, shop: VisibleShop, proposal: ListedProposal, deps: CapacityToolDeps): Promise<ListedProposal> {
  if (proposal.workaroundId !== "deactivate_discounts" || !proposal.selection) return proposal;
  const ops = deps.discounts ?? (await discountOps(db));
  const all = await ops.list(shopRef(shop));
  return {
    ...proposal,
    selection: {
      ...proposal.selection,
      items: all.filter((candidate) => candidate.native).map((candidate) => ({ id: candidate.id, label: `${candidate.title} (${candidate.type})`, checked: false })),
      notSelectable: all.filter((candidate) => !candidate.native).map((candidate) => ({ id: candidate.id, label: candidate.title, reason: `Owned by ${candidate.appTitle ?? "another app"}; only native Shopify discounts can be switched off and back on.` })),
    },
  };
}

const incidentStatus = (row: CapacityIncident, now: Date): (typeof STATUSES)[number] =>
  row.status === "resolved" ? "resolved" : row.status === "dismissed" ? "dismissed" : row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime() ? "snoozed" : "open";

type ActionRow = Awaited<ReturnType<typeof recentActions>>[number];
const actionView = (action: ActionRow, now: Date) => ({
  actionId: action.id,
  workaroundId: action.kind,
  status: action.status,
  appliedAt: action.appliedAt,
  undoUntil: action.undoUntil,
  undoable: action.status === "applied" && action.kind !== "sync_products" && action.undoUntil !== null && Date.parse(action.undoUntil) >= now.getTime(),
  error: action.error,
});

export async function capacityIncidentsList(
  ctx: McpContext,
  visible: VisibleShop[],
  args: { shop: string; status?: (typeof STATUSES)[number]; incidentId?: string; includeDiscountCandidates?: boolean },
  deps: CapacityToolDeps = {},
): Promise<ToolResult<Record<string, unknown>>> {
  const [shop] = selectShops(visible, [args.shop]);
  const now = ctx.now();
  const wanted = args.status ?? "open";
  const [live, resolved, actions] = await Promise.all([
    wanted === "resolved" ? Promise.resolve([]) : listOpenIncidents(ctx.db, shop!.id),
    wanted === "resolved" ? listRecentlyResolved(ctx.db, shop!.id) : Promise.resolve([]),
    recentActions(ctx.db, shop!.id, 50),
  ]);
  const rows = [...live, ...resolved].filter((row) => incidentStatus(row, now) === wanted && (!args.incidentId || row.id === args.incidentId)).slice(0, MAX_INCIDENTS);
  const offerRows = await loadOfferRows(ctx.db, shop!.id, [...new Set(rows.flatMap((row) => row.offerIds))]);

  const incidents = [];
  let anyProposals = false;
  for (const row of rows) {
    const status = incidentStatus(row, now);
    const base = {
      incidentId: row.id,
      status,
      code: row.code,
      reason: row.reason,
      numbers: row.numbers,
      occurrences: row.occurrences,
      source: row.source,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
      resolution: row.resolution ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      affectedOffers: row.offerIds.map((id) => ({ ref: ref(shop!, id), id, name: offerRows.get(id)?.offer.internalName ?? id, status: offerRows.get(id)?.offer.status ?? "deleted" })),
      recentActions: actions.filter((action) => action.incidentId === row.id).map((action) => actionView(action, now)),
    };
    if (status === "resolved") {
      incidents.push(base);
      continue;
    }
    const proposed: IncidentProposals = await proposeForIncident(ctx.db, row, { ...(deps.capacity ? { capacity: deps.capacity } : {}), env: ctx.env });
    let proposals = proposed.proposals.map(listProposal);
    if (args.includeDiscountCandidates) proposals = await Promise.all(proposals.map((proposal) => discountSelection(ctx.db, shop!, proposal, deps)));
    if (proposals.length > 0) anyProposals = true;
    incidents.push({
      ...base,
      shopifyLimit: { title: proposed.title, limit: proposed.limit, whatHappened: proposed.body, howToFix: proposed.fix },
      proposals,
      guidance: proposed.guidance,
      manualActions: proposed.actions,
    });
  }

  const undoable = actions.map((action) => actionView(action, now)).filter((action) => action.undoable);
  return buildResult(
    {
      summary: incidents.length
        ? `${incidents.length} ${wanted} capacity incident(s) on ${shop!.myshopifyDomain}. Apply a proposal with capacity_incident_apply (incidentId + workaround).`
        : `No ${wanted} capacity incidents on ${shop!.myshopifyDomain}.`,
      data: { shopDomain: shop!.myshopifyDomain, status: wanted, incidents, undoableActions: undoable },
      links: [adminLink(shopHandle(shop!.myshopifyDomain))],
      nextActions: anyProposals
        ? [{ mcp: "promo-engine", tool: "capacity_incident_apply", args: { shop: shop!.myshopifyDomain, dryRun: true }, why: "Preview a proposed fix.", risk: "write" }]
        : [],
    },
    ctx.now,
  );
}

// ── writes ──────────────────────────────────────────────────

type Controls = { dryRun?: boolean; idempotencyKey?: string };
type Built = { shop: VisibleShop; preview: () => Promise<WritePreview>; apply: (apply: ApplyContext) => Promise<WriteBody> };

/** Resolves the shop (a failure is logged and returned as a tool error), then hands the spec to runWrite. */
async function guarded(ctx: McpContext, call: CallInfo, tool: string, args: Controls & { shop: string } & Record<string, unknown>, build: (shop: VisibleShop) => Built): Promise<CallToolResult> {
  const started = performance.now();
  let built: Built;
  try {
    built = build(selectShops(await visibleShops(ctx.db, ctx.operator), [args.shop])[0]!);
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool, shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
  return runWrite(ctx, call, {
    tool,
    args,
    dryRun: args.dryRun === true,
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    shops: [built.shop],
    preview: built.preview,
    apply: built.apply,
  });
}

/** Maps a failed WorkaroundResult to the tool error the admin dialog's wording corresponds to. */
function resultError(result: WorkaroundResult, incident: Pick<CapacityIncident, "code" | "offerIds" | "numbers"> | null): ToolError {
  switch (result.code) {
    case "not_found":
      return new ToolError("NOT_FOUND", result.message);
    case "stale":
    case "busy":
      return new ToolError("STATE_CONFLICT", result.message, { suggestedAction: { mcp: "promo-engine", tool: "capacity_incidents_list", args: {}, why: "Reload the incident and its proposals, then retry." } });
    case "refused":
      return new ToolError("VALIDATION", result.message);
    case "still_blocked":
      return capacityToolError({ code: incident?.code ?? "UNKNOWN", offerIds: incident?.offerIds ?? [], numbers: incident?.numbers ?? {} }, result.message);
    case "rolled_back":
      return new ToolError("PUBLISH_FAILED", `${result.message} Nothing was changed: the fix was rolled back.`);
    case "undo_failed":
      return new ToolError("UPSTREAM_UNAVAILABLE", result.message);
    default:
      return new ToolError("INVALID_STATE", result.message);
  }
}

const offerNames = (offerIds: string[], names: Map<string, { offer: { internalName: string } }>) => offerIds.map((id) => names.get(id)?.offer.internalName ?? id);

async function incidentOf(db: Db, shopId: string, incidentId: string): Promise<CapacityIncident> {
  const [row] = await db.select().from(capacityIncidents).where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.id, incidentId)));
  if (!row) throw new ToolError("NOT_FOUND", "Capacity incident not found in that shop.", { suggestedAction: { mcp: "promo-engine", tool: "capacity_incidents_list", args: { status: "open" }, why: "List the shop's incidents." } });
  return row;
}

type ApplyArgs = Controls & { shop: string; incidentId: string; workaround: (typeof WORKAROUND_KINDS)[number]; selected?: string[]; confirm?: boolean; expectedVersions?: Record<string, string> };

export function capacityIncidentApplyTool(ctx: McpContext, call: CallInfo, args: ApplyArgs, deps: CapacityToolDeps = {}): Promise<CallToolResult> {
  return guarded(ctx, call, "capacity_incident_apply", args, (shop) => {
    const proposalFor = async (): Promise<{ incident: CapacityIncident; proposal: WorkaroundProposal }> => {
      const incident = await incidentOf(ctx.db, shop.id, args.incidentId);
      if (incident.status === "resolved") throw new ToolError("INVALID_STATE", "This incident is already resolved.");
      const proposal = (await proposeForIncident(ctx.db, incident, { ...(deps.capacity ? { capacity: deps.capacity } : {}), env: ctx.env })).proposals.find((p) => p.kind === args.workaround);
      if (!proposal) throw new ToolError("STATE_CONFLICT", workaroundCopy.stale, { suggestedAction: { mcp: "promo-engine", tool: "capacity_incidents_list", args: { shop: shop.myshopifyDomain, incidentId: args.incidentId }, why: "The proposal is not offered any more; reload it." } });
      return { incident, proposal };
    };
    return {
      shop,
      preview: async (): Promise<WritePreview> => {
        const { incident, proposal } = await proposalFor();
        const warnings: Warning[] = [];
        if (proposal.semanticChange && !args.confirm) warnings.push({ code: "CONFIRM_REQUIRED", severity: "warn", message: "Customers will see a difference: the apply needs confirm:true." });
        const selected = [...new Set(args.selected ?? [])];
        const allowed = new Set(proposal.options?.items.map((item) => item.id));
        if (proposal.kind === "pause_offers" && (selected.length === 0 || selected.some((id) => !allowed.has(id)))) {
          warnings.push({ code: "SELECTION_INVALID", severity: "block", message: "pause_offers needs `selected` to be offer ids from the proposal's selection options." });
        }
        if (proposal.kind === "deactivate_discounts") {
          const needed = Number(proposal.params["needed"] ?? 1);
          if (selected.length < needed) warnings.push({ code: "SELECTION_INVALID", severity: "block", message: `Select at least ${needed} native automatic discount id(s) (capacity_incidents_list with includeDiscountCandidates).` });
        }
        const names = await loadOfferRows(ctx.db, shop.id, Object.keys(proposal.offerVersions));
        return {
          summary: `${proposal.title}: ${proposal.summary} What changes for customers: ${proposal.customerChange}`,
          data: {
            incidentId: incident.id,
            workaroundId: proposal.kind,
            offersTouched: Object.keys(proposal.offerVersions).map((id) => ({ ref: ref(shop, id), name: names.get(id)?.offer.internalName ?? id })),
            selected,
            requiresConfirm: proposal.semanticChange,
            whatChangesForCustomers: proposal.customerChange,
            note: proposal.note ?? null,
            undo: `Reversible with capacity_incident_undo for ${UNDO_WINDOW_MS / 3_600_000} hours while the touched offers stay unchanged.`,
          },
          warnings,
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: null,
        };
      },
      apply: async (a): Promise<WriteBody> => {
        const { incident, proposal } = await proposalFor();
        const result = await runIncidentIntent(
          ctx.db,
          shopRef(shop),
          { intent: "apply", incidentId: incident.id, kind: args.workaround, ...(args.selected ? { selected: args.selected } : {}), confirm: args.confirm === true, expectedVersions: args.expectedVersions ?? proposal.offerVersions },
          a.performedBy,
          depsOf(ctx, deps, a.publish),
        );
        if (!result.ok) throw resultError(result, incident);
        const [after] = await ctx.db.select({ status: capacityIncidents.status }).from(capacityIncidents).where(eq(capacityIncidents.id, incident.id));
        return {
          summary: `${result.message} (${proposal.title}).`,
          data: { ...result, incidentId: incident.id, incidentStatus: after?.status ?? null, undoUntil: new Date(ctx.now().getTime() + UNDO_WINDOW_MS).toISOString() },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          nextActions: result.actionId ? [{ mcp: "promo-engine", tool: "capacity_incident_undo", args: { shop: shop.myshopifyDomain, actionId: result.actionId }, why: "Undo this fix (24 h window).", risk: "write" }] : [],
        };
      },
    };
  });
}

type UndoArgs = Controls & { shop: string; actionId: string };

export function capacityIncidentUndoTool(ctx: McpContext, call: CallInfo, args: UndoArgs, deps: CapacityToolDeps = {}): Promise<CallToolResult> {
  return guarded(ctx, call, "capacity_incident_undo", args, (shop) => ({
    shop,
    preview: async (): Promise<WritePreview> => {
      const [action] = await ctx.db.select().from(capacityActions).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, args.actionId)));
      if (!action) throw new ToolError("NOT_FOUND", workaroundCopy.notFound);
      const warnings: Warning[] = [];
      const expired = !action.undoUntil || action.undoUntil.getTime() < ctx.now().getTime();
      if (action.status !== "applied" || action.kind === "sync_products") warnings.push({ code: "UNDO_REFUSED", severity: "block", message: workaroundCopy.undoChangedSince });
      else if (expired) warnings.push({ code: "UNDO_EXPIRED", severity: "block", message: workaroundCopy.undoExpired });
      const touched = Object.keys((action.snapshot as { offerUpdatedAfter?: Record<string, string> }).offerUpdatedAfter ?? {});
      const names = await loadOfferRows(ctx.db, shop.id, touched);
      return {
        summary: `Undo ${action.kind} (${action.status}): restores the offers it changed${warnings.length ? `, but ${warnings[0]!.message}` : ""}. The undo window is 24 h and is refused if any touched offer changed since.`,
        data: { actionId: action.id, workaroundId: action.kind, status: action.status, undoUntil: action.undoUntil?.toISOString() ?? null, offersTouched: offerNames(touched, names) },
        warnings,
        links: [adminLink(shopHandle(shop.myshopifyDomain))],
        offerUpdatedAt: null,
      };
    },
    apply: async (a): Promise<WriteBody> => {
      const result = await runIncidentIntent(ctx.db, shopRef(shop), { intent: "undo", actionId: args.actionId }, a.performedBy, depsOf(ctx, deps, a.publish));
      if (!result.ok) throw resultError(result, null);
      return {
        summary: result.message,
        data: { ...result },
        links: [adminLink(shopHandle(shop.myshopifyDomain))],
        nextActions: [{ mcp: "promo-engine", tool: "capacity_incidents_list", args: { shop: shop.myshopifyDomain }, why: "The incident may be open again; see its proposals.", risk: "read" }],
      };
    },
  }));
}

type IncidentArgs = Controls & { shop: string; incidentId: string };

export function capacityIncidentDismissTool(ctx: McpContext, call: CallInfo, args: IncidentArgs): Promise<CallToolResult> {
  return guarded(ctx, call, "capacity_incident_dismiss", args, (shop) => ({
    shop,
    preview: async (): Promise<WritePreview> => {
      const incident = await incidentOf(ctx.db, shop.id, args.incidentId);
      const warnings: Warning[] = incident.status === "open" ? [] : [{ code: "NOT_OPEN", severity: "block", message: "This incident is no longer open, so dismiss would be refused." }];
      return {
        summary: `Dismiss incident ${incident.code} (${incident.offerIds.length} offer(s)): it leaves the open list; no offer changes. A new block of the same shape reopens it.`,
        data: { incidentId: incident.id, code: incident.code, status: incident.status },
        warnings,
        offerUpdatedAt: null,
      };
    },
    apply: async (a): Promise<WriteBody> => {
      const result = await runIncidentIntent(ctx.db, shopRef(shop), { intent: "dismiss", incidentId: args.incidentId }, a.performedBy, depsOf(ctx, {}));
      if (!result.ok) throw resultError(result, null);
      return { summary: `Incident dismissed on ${shop.myshopifyDomain}.`, data: { incidentId: args.incidentId, ...result } };
    },
  }));
}

export function capacityIncidentSnoozeTool(ctx: McpContext, call: CallInfo, args: Controls & { shop: string }): Promise<CallToolResult> {
  return guarded(ctx, call, "capacity_incident_snooze", args, (shop) => ({
    shop,
    preview: async (): Promise<WritePreview> => {
      const open = (await listOpenIncidents(ctx.db, shop.id)).filter((row) => row.status === "open");
      return {
        summary: `Snooze ${open.length} open incident(s) of ${shop.myshopifyDomain} for 24 hours (the same shared snooze as the admin banner); nothing else changes.`,
        data: { openIncidents: open.length, incidentIds: open.map((row) => row.id) },
        offerUpdatedAt: null,
      };
    },
    apply: async (a): Promise<WriteBody> => {
      const result = await runIncidentIntent(ctx.db, shopRef(shop), { intent: "snooze" }, a.performedBy, depsOf(ctx, {}));
      return { summary: `Snoozed the open capacity incidents of ${shop.myshopifyDomain} for 24 hours.`, data: { ...result } };
    },
  }));
}

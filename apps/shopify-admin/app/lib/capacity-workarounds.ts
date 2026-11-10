/** Client-safe types shared by the workaround proposals, the apply engine and the dialogs. No server imports. */

export const WORKAROUND_KINDS = [
  "use_whole_products",
  "require_any",
  "reduce_gift_options",
  "split_offer",
  "sync_products",
  "pause_offers",
  "deactivate_discounts",
  "enable_combination_groups",
  "allow_combine",
  "enable_shards",
] as const;

export type WorkaroundKind = (typeof WORKAROUND_KINDS)[number];

export interface WorkaroundOption {
  id: string;
  label: string;
  checked: boolean;
}

export interface WorkaroundProposal {
  kind: WorkaroundKind;
  title: string;
  /** What Apply does, in one sentence. */
  summary: string;
  /** The "What changes for customers" line. */
  customerChange: string;
  /** True when customers see a difference: Apply then needs the explicit confirm checkbox. */
  semanticChange: boolean;
  /** Offers the workaround touches, with the updated_at the proposal was computed from (stale guard). */
  offerVersions: Record<string, string>;
  /** Kind-specific parameters the client sends back to Apply (validated again server-side). */
  params: Record<string, unknown>;
  /** A set the merchant picks from (offers to pause, Shopify discounts to deactivate). */
  options?: { label: string; items: WorkaroundOption[]; minSelected: number; lazy?: boolean };
  /** Extra note shown under the proposal (what Undo does, what stays as it is). */
  note?: string;
}

export interface IncidentProposals {
  incidentId: string;
  code: string;
  reason: string | null;
  status: "open" | "dismissed";
  occurrences: number;
  lastSeenAt: string;
  source: string;
  offers: Array<{ id: string; name: string; status: string }>;
  /** Plain-language copy of the Shopify limit (describeCapacityModal). */
  title: string;
  limit: string;
  body: string;
  fix: string;
  proposals: WorkaroundProposal[];
  /** Manual guidance when nothing can be applied automatically. */
  guidance: string | null;
  actions: Array<{ label: string; href?: string; to?: string }>;
}

export type ApplyIntent = "apply" | "undo" | "snooze" | "dismiss";

export type WorkaroundResultCode =
  | "applied"
  | "undone"
  | "still_blocked"
  | "stale"
  | "rolled_back"
  | "undo_failed"
  | "undo_refused"
  | "refused"
  | "busy"
  | "not_found";

export interface WorkaroundResult {
  ok: boolean;
  code: WorkaroundResultCode;
  message: string;
  actionId?: string;
  /** Offers the workaround left draft or paused: the merchant activates them. */
  offersToActivate?: Array<{ id: string; name: string }>;
}

export interface RecentAction {
  id: string;
  incidentId: string;
  kind: string;
  status: string;
  appliedAt: string | null;
  undoUntil: string | null;
  error: string | null;
}

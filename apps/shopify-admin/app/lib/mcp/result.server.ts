/** Result contract shared with the Experiment Engine MCP (Brain: Shared/experiment-engines-sync). */
import { describeCapacityModal, isCapacityModalCode, tooLargeReason } from "../capacity-modal-copy.js";
import { workaroundCopy } from "../capacity-workaround-copy.js";
import type { WorkaroundKind } from "../capacity-workarounds.js";

export const MCP_NAME = "promo-engine" as const;
export type McpName = "promo-engine" | "experiment-engine";

export type Money = { amount: string; currency: string };

export type Link = { label: string; url: string };
export type Warning = { code: string; severity: "info" | "warn" | "block"; message: string };
export const publishAdvisories = (messages: string[] | undefined): Warning[] =>
  (messages ?? []).map((message) => ({ code: "PUBLISH_ADVISORY", severity: "warn", message }));
export type NextAction = {
  mcp: McpName;
  tool: string;
  args: Record<string, unknown>;
  why: string;
  risk: "read" | "write" | "destructive";
};

export type PerShop = {
  shopDomain: string;
  shopHandle: string;
  shopTimezone: string;
  currency: string;
  status: "ok" | "error" | "skipped";
  reason?: string;
};

export type ResultMeta = {
  generatedAt: string;
  shopTimezone?: string;
  dataFreshness?: string;
  window?: { start: string; end: string };
  page?: { cursor?: string; hasMore: boolean };
  dryRun?: boolean;
  confirmToken?: string;
  confirmExpiresAt?: string;
  auditIds?: string[];
};

export type ToolResult<T> = {
  summary: string;
  data: T;
  perShop?: PerShop[];
  links: Link[];
  warnings: Warning[];
  nextActions: NextAction[];
  meta: ResultMeta;
};

export const EXPERIMENT_TYPES = [
  "PRICE_TEST",
  "DISCOUNT_TEST",
  "SHIPPING_TEST",
  "OFFER_TEST",
  "COMBINATION_TEST",
  "CONTENT_TEST",
  "SPLIT_URL_TEST",
  "TEMPLATE_TEST",
  "THEME_TEST",
  "CHECKOUT_TEST",
  "PERSONALIZATION_TEST",
  "JAVASCRIPT_API_TEST",
] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];

/** Shape of the candidates `suggest_promo_tests` returns (phase 1); defined now so both MCPs agree. */
export type TestIdea = {
  title: string;
  hypothesis: string;
  suggestedExperimentType: ExperimentType;
  arms: { key: string; description: string; promoRef?: string }[];
  primaryMetric: string;
  shopRefs: string[];
  evidence: { source: string; ref: string; note: string }[];
  risks: string[];
};

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "SHOP_NOT_FOUND",
  "SHOP_FORBIDDEN",
  "SHOP_READ_ONLY",
  "CONFIRM_REQUIRED",
  "CONFIRM_INVALID",
  "CONFIRM_EXPIRED",
  "NOT_FOUND",
  "INVALID_STATE",
  "STATE_CONFLICT",
  "PUBLISH_FAILED",
  "CAPACITY_LIMIT",
  "VALIDATION",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type SuggestedAction = { mcp: McpName; tool: string; args: Record<string, unknown>; why: string };

export type ToolErrorPayload = {
  code: ErrorCode;
  message: string;
  suggestedAction: SuggestedAction | null;
  mcp: typeof MCP_NAME;
  retryable: boolean;
  retryAfterSeconds?: number;
  confirmToken?: string;
  /** Shared with the EE: FORBIDDEN carries reason "ROLE" (insufficient operator role). */
  details?: {
    reason?: string;
    capacity?: { code: string; offerIds: string[]; numbers: Record<string, number> };
    /** CAPACITY_LIMIT: the Shopify cap that was hit, in the admin capacity modal's words. */
    limit?: string;
    /** CAPACITY_LIMIT: fixes the merchant can apply (admin: Diagnostics > capacity incidents). */
    workarounds?: CapacityWorkaround[];
  };
};

export type CapacityWorkaround = { kind: WorkaroundKind; title: string; summary: string };
export type CapacityLike = { code: string; offerIds: string[]; numbers: Record<string, number>; offerNames?: Record<string, string> };

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"]);

export class ToolError extends Error {
  readonly payload: ToolErrorPayload;
  constructor(
    code: ErrorCode,
    message: string,
    opts: { suggestedAction?: SuggestedAction; retryAfterSeconds?: number; confirmToken?: string; details?: ToolErrorPayload["details"] } = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.payload = {
      code,
      message,
      suggestedAction: opts.suggestedAction ?? null,
      mcp: MCP_NAME,
      retryable: RETRYABLE.has(code),
      ...(opts.retryAfterSeconds !== undefined ? { retryAfterSeconds: opts.retryAfterSeconds } : {}),
      ...(opts.confirmToken ? { confirmToken: opts.confirmToken } : {}),
      ...(opts.details ? { details: opts.details } : {}),
    };
  }
}

/** Never leaks stack, SQL or upstream text: anything that is not a ToolError becomes INTERNAL. */
export function toToolErrorPayload(error: unknown): ToolErrorPayload {
  if (error instanceof ToolError) return error.payload;
  return new ToolError("INTERNAL", "Unexpected error. Retry; if it persists check the app logs.").payload;
}

export function shopHandle(myshopifyDomain: string): string {
  return myshopifyDomain.replace(/\.myshopify\.com$/i, "");
}

export function promoRef(myshopifyDomain: string, offerId: string): string {
  return `promo:${shopHandle(myshopifyDomain)}:${offerId}`;
}

export function parsePromoRef(ref: string): { shopHandle: string; offerId: string } | null {
  const match = /^promo:([a-z0-9][a-z0-9-]*):([0-9a-f-]{36})$/i.exec(ref);
  return match ? { shopHandle: match[1]!, offerId: match[2]! } : null;
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "XPF", "PYG", "RWF", "DJF", "GNF", "KMF", "VUV"]);
const THREE_DECIMAL = new Set(["KWD", "BHD", "OMR", "JOD", "TND", "LYD", "IQD"]);

/**
 * The app stores money as Math.round(amount * 100) for every currency (order-paid webhook,
 * thresholds), so `stored` is amount x 100 even for JPY or KWD. Formatted with the currency's own decimals.
 */
export function moneyFromMinor(stored: number, currency: string): Money {
  const code = currency.toUpperCase();
  const decimals = ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
  const sign = stored < 0 ? "-" : "";
  const scale = 10 ** decimals;
  const units = Math.round((Math.abs(stored) * scale) / 100);
  if (decimals === 0) return { amount: `${sign}${units}`, currency: code };
  const whole = Math.floor(units / scale);
  return { amount: `${sign}${whole}.${String(units % scale).padStart(decimals, "0")}`, currency: code };
}

export function buildResult<T>(
  input: {
    summary: string;
    data: T;
    perShop?: PerShop[];
    links?: Link[];
    warnings?: Warning[];
    nextActions?: NextAction[];
    meta?: Partial<ResultMeta>;
  },
  now: () => Date = () => new Date(),
): ToolResult<T> {
  return {
    summary: input.summary,
    data: input.data,
    ...(input.perShop ? { perShop: input.perShop } : {}),
    links: input.links ?? [],
    warnings: input.warnings ?? [],
    nextActions: input.nextActions ?? [],
    meta: { generatedAt: now().toISOString(), ...input.meta },
  };
}

const WORKAROUND_TEXT: Record<WorkaroundKind, { title: string; summary: string }> = {
  use_whole_products: workaroundCopy.useWholeProducts,
  require_any: { title: workaroundCopy.requireAny.title, summary: "Changes an 'all of these items in the cart' condition to 'any one of them'." },
  reduce_gift_options: { title: workaroundCopy.reduceGiftOptions.title, summary: "Keeps fewer gift options, the most available first." },
  split_offer: { title: workaroundCopy.splitOffer.title, summary: "Splits the offer into several smaller offers, each in its own Shopify discount." },
  sync_products: workaroundCopy.syncProducts,
  pause_offers: { title: workaroundCopy.pauseOffers.title, summary: "Pauses the lowest-priority offers so the rest fit." },
  deactivate_discounts: workaroundCopy.deactivateDiscounts,
  allow_combine: workaroundCopy.allowCombine,
};

function workaroundKinds(capacity: CapacityLike): WorkaroundKind[] {
  switch (capacity.code) {
    case "AUTOMATIC_DISCOUNT_LIMIT":
      return ["deactivate_discounts"];
    case "OFFER_TOO_LARGE":
    case "GROUP_TOO_LARGE": {
      const reason = tooLargeReason(capacity.numbers);
      if (reason === "lists") return ["require_any", "reduce_gift_options", "use_whole_products"];
      if (reason === "keys" || reason === "tags") return [];
      if (reason === "offers") return ["pause_offers"];
      return ["use_whole_products", "sync_products", "split_offer", "reduce_gift_options"];
    }
    case "SLOT0_GROUP_TOO_LARGE":
    case "SLOT_FULL":
      return ["pause_offers"];
    case "COMBINATION_SINGLE_SHARD":
      return ["allow_combine", "pause_offers"];
    default:
      return [];
  }
}

/** Same copy as the admin capacity modal (FIX-cap-08): which Shopify cap was hit, why, and the fixes on offer. */
export function capacityToolError(capacity: CapacityLike, message: string, opts: { suggestedAction?: SuggestedAction } = {}): ToolError {
  const workarounds = workaroundKinds(capacity).map((kind) => ({ kind, ...WORKAROUND_TEXT[kind] }));
  let limit = "A Shopify limit was reached.";
  let fix = "";
  if (isCapacityModalCode(capacity.code)) {
    const copy = describeCapacityModal({
      code: capacity.code,
      numbers: capacity.numbers,
      offers: capacity.offerIds.map((id) => ({ id, name: capacity.offerNames?.[id] ?? id })),
    });
    limit = copy.limit;
    fix = copy.fix;
  }
  const full = fix ? `${message} Limit: ${limit} ${fix}` : message;
  return new ToolError("CAPACITY_LIMIT", full, {
    ...opts,
    details: { capacity: { code: capacity.code, offerIds: capacity.offerIds, numbers: capacity.numbers }, limit, workarounds },
  });
}

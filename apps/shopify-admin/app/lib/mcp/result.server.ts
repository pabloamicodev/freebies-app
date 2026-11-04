/** Result contract shared with the Experiment Engine MCP (Brain: Shared/experiment-engines-sync). */

export const MCP_NAME = "promo-engine" as const;
export type McpName = "promo-engine" | "experiment-engine";

export type Money = { amount: string; currency: string };

export type Link = { label: string; url: string };
export type Warning = { code: string; severity: "info" | "warn" | "block"; message: string };
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
  "FORBIDDEN_ROLE",
  "SHOP_NOT_FOUND",
  "SHOP_FORBIDDEN",
  "SHOP_READ_ONLY",
  "CONFIRM_REQUIRED",
  "CONFIRM_INVALID",
  "CONFIRM_EXPIRED",
  "NOT_FOUND",
  "INVALID_STATE",
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
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"]);

export class ToolError extends Error {
  readonly payload: ToolErrorPayload;
  constructor(
    code: ErrorCode,
    message: string,
    opts: { suggestedAction?: SuggestedAction; retryAfterSeconds?: number; confirmToken?: string } = {},
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

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "XPF"]);

/** Cents (integer minor units) to the contract's decimal string. */
export function moneyFromMinor(minor: number, currency: string): Money {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return { amount: String(Math.round(minor)), currency: code };
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  return { amount: `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`, currency: code };
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

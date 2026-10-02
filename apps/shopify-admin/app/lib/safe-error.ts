export type ErrorAllow = string | RegExp;

/**
 * Only validation messages we wrote ourselves may reach the merchant. Anything else
 * (DB, network, Shopify internals, JSON.parse SyntaxErrors) collapses to `fallback`
 * and is logged server-side.
 */
export function safeErrorMessage(error: unknown, fallback: string, allow: readonly ErrorAllow[] = []): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message && allow.some((rule) => (typeof rule === "string" ? rule === message : rule.test(message)))) return message;
  console.error("[safe-error] suppressed:", error);
  return fallback;
}

export const WEBHOOK_URL_ERRORS: readonly ErrorAllow[] = [
  /^Webhook URL (is invalid|must use HTTPS|must not contain credentials|must use the default HTTPS port|must use a public hostname|resolves to a private or reserved address)$/,
  "Webhook destination did not resolve to a supported IP address",
];

export const CSV_PARSE_ERRORS: readonly ErrorAllow[] = [
  /^CSV field exceeds [\d,.\s]+ characters$/,
  "CSV contains an unterminated quoted field",
];

export const SIMULATOR_INPUT_ERRORS: readonly ErrorAllow[] = [
  /^(Line properties|Cart attributes)( values)? (must be a JSON object|must all be strings)\.$/,
];

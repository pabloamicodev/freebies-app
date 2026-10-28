/**
 * URL handling shared by the rule engine, the config compiler and (by contract)
 * the Rust Functions' page_match.rs. Decision D3 of docs/PRODUCTION-READINESS-PLAN.md:
 * scheme and host are stripped only for `http://`, `https://` and `//` values,
 * query keys/values are percent-decoded with `+` as a space, and `utm_*`
 * comparisons are ASCII case-insensitive.
 */

export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** Path (+ query), without scheme/host/fragment. Anything that is not an absolute
 * or protocol-relative URL is already a path and is kept as-is, so a `://` inside
 * a query string is never mistaken for a scheme. */
export function pagePathAndQuery(url: string): string {
  const lower = asciiLower(url.slice(0, 8));
  const skip = lower === "https://" ? 8 : lower.startsWith("http://") ? 7 : url.startsWith("//") ? 2 : 0;
  if (skip === 0) return url.split("#")[0] ?? "";
  const rest = url.slice(skip);
  const index = rest.search(/[/?#]/);
  return (index === -1 ? "" : rest.slice(index)).split("#")[0] ?? "";
}

export function splitPageUrl(url: string): { path: string; query: string } {
  const pathAndQuery = pagePathAndQuery(url);
  const index = pathAndQuery.indexOf("?");
  const path = index === -1 ? pathAndQuery : pathAndQuery.slice(0, index);
  return { path: path === "" ? "/" : path, query: index === -1 ? "" : pathAndQuery.slice(index + 1) };
}

/** Lossy UTF-8 percent-decoding (invalid escapes stay literal), like the Function. */
export function percentDecode(input: string, plusAsSpace: boolean): string {
  if (!input.includes("%") && !(plusAsSpace && input.includes("+"))) return input;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (char === "%" && /^[0-9a-fA-F]{2}$/.test(input.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(input.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (plusAsSpace && char === "+") {
      bytes.push(0x20);
    } else {
      bytes.push(...encoder.encode(String.fromCodePoint(input.codePointAt(index)!)));
      if (input.codePointAt(index)! > 0xffff) index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function isUtmParam(name: string): boolean {
  return asciiLower(name.slice(0, 4)) === "utm_";
}

/** Decoded value of the first query parameter called `name` (null when absent). `utm_*`
 * names and values compare ASCII case-insensitively, everything else exactly. */
export function readQueryParam(query: string, name: string): string | null {
  const insensitive = isUtmParam(name);
  const same = (left: string, right: string) =>
    insensitive ? asciiLower(left) === asciiLower(right) : left === right;
  for (const pair of query.split("&")) {
    const index = pair.indexOf("=");
    const key = percentDecode(index === -1 ? pair : pair.slice(0, index), true);
    if (same(key, name)) return percentDecode(index === -1 ? "" : pair.slice(index + 1), true);
  }
  return null;
}

/** Whether a decoded query value equals the configured one (case rules as above). */
export function queryValueMatches(name: string, actual: string, expected: string): boolean {
  return isUtmParam(name) ? asciiLower(actual) === asciiLower(expected) : actual === expected;
}

/**
 * Canonical form of a "Store pages" URL entry: path only (scheme, host, query and fragment dropped),
 * ASCII-lowercased, one leading slash, no trailing slash. Empty and home ("/") entries yield null.
 */
export function normalizeStorePageUrl(raw: string): string | null {
  const { path } = splitPageUrl(raw.trim());
  const trimmed = asciiLower(path).replace(/\/+$/, "");
  if (trimmed === "") return null;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function normalizeStorePageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const entry of raw) {
    const normalized = typeof entry === "string" ? normalizeStorePageUrl(entry) : null;
    if (normalized) out.add(normalized);
  }
  return [...out];
}

/**
 * Canonical form of an "Exclude these pages" entry: like `normalizeStorePageUrl`, but percent-decoded
 * so `/products/one-sol%E2%84%A2-x` (what `location.pathname` stamps) and `/products/one-sol™-x` (what
 * an admin pastes) compare equal. The Function decodes the stamped path the same way.
 */
export function normalizeExcludedPageUrl(raw: string): string | null {
  const { path } = splitPageUrl(raw.trim());
  const trimmed = asciiLower(percentDecode(path, false)).replace(/\/+$/, "");
  if (trimmed === "") return null;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function normalizeExcludedPageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const entry of raw) {
    const normalized = typeof entry === "string" ? normalizeExcludedPageUrl(entry) : null;
    if (normalized) out.add(normalized);
  }
  return [...out];
}

/** Path a specific-link condition requires, exactly as the compiler stores it. */
export function specificLinkRequiredPath(requiredUrl: string): string {
  const trimmed = requiredUrl.trim();
  const absolute = /^(https?:)?\/\//i.test(trimmed);
  if (absolute) {
    try {
      return new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed).pathname;
    } catch {
      // fall through to the plain split below
    }
  }
  return trimmed.split("?")[0] ?? "";
}

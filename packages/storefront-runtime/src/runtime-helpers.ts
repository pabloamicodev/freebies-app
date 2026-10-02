import { OWN_REQUEST_HEADER } from "./cart-adapter.js";

/** Retry-After as seconds or an HTTP date, clamped to 1-30 s; null when absent/garbage. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(ms) ? Math.min(30_000, Math.max(1_000, ms)) : null;
}

export function hasOwnMarker(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  if (!headers) return false;
  const name = OWN_REQUEST_HEADER.toLowerCase();
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.has(name);
  if (Array.isArray(headers)) return headers.some(([k]) => String(k).toLowerCase() === name);
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

export interface GiftOutcome {
  added: Set<string>;
  removed: Set<string>;
}

/** Gift keys to expect next cycle: those in the cart, plus adds that SUCCEEDED, minus removals that succeeded. A declined/failed add never becomes "expected". */
export function expectedGiftKeys(cartGiftKeys: Iterable<string>, outcome: GiftOutcome): Set<string> {
  const known = new Set(cartGiftKeys);
  for (const key of outcome.added) known.add(key);
  for (const key of outcome.removed) known.delete(key);
  return known;
}

/** +-30% so many tabs hitting the same 429 don't retry in lockstep. */
export function withJitter(ms: number, random = Math.random): number {
  return Math.round(ms * (0.7 + random() * 0.6));
}

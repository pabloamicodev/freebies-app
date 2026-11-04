import { ToolError, moneyFromMinor, type Money } from "../result.server.js";

export const DAY_MS = 86_400_000;
export const MAX_WINDOW_DAYS = 90;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
  } catch {
    /* falls through */
  }
  throw new ToolError("VALIDATION", "Invalid cursor. Start again without one.");
}

export function offsetFromCursor(cursor: string | undefined): number {
  const decoded = decodeCursor<{ o?: unknown }>(cursor);
  const offset = decoded?.o;
  if (decoded && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)) {
    throw new ToolError("VALIDATION", "Invalid cursor. Start again without one.");
  }
  return typeof offset === "number" ? offset : 0;
}

export type Window = { start: Date; end: Date };

/** `start`/`end` ISO or `lastDays`; never longer than 90 days. Defaults to the last `defaultDays`. */
export function resolveWindow(
  args: { start?: string; end?: string; lastDays?: number },
  now: Date,
  defaultDays = 30,
): Window {
  const parse = (value: string, field: string): Date => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new ToolError("VALIDATION", `${field} must be an ISO 8601 date-time.`);
    return date;
  };
  let end = args.end ? parse(args.end, "end") : now;
  let start: Date;
  if (args.start) start = parse(args.start, "start");
  else start = new Date(end.getTime() - (args.lastDays ?? defaultDays) * DAY_MS);
  if (!args.end && args.start && start > now) end = start;
  if (start >= end) throw new ToolError("VALIDATION", "start must be before end.");
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new ToolError("VALIDATION", `The window cannot exceed ${MAX_WINDOW_DAYS} days.`);
  }
  return { start, end };
}

/** Ratio in [0, +inf) rounded to 4 decimals; null when the denominator is 0 (never invent a rate). */
export function rate(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/** Cents per currency; never converted between currencies. */
export class MoneyBag {
  private readonly cents = new Map<string, number>();
  add(currency: string, minor: number): void {
    const code = currency.toUpperCase();
    this.cents.set(code, (this.cents.get(code) ?? 0) + minor);
  }
  get(currency: string): number {
    return this.cents.get(currency.toUpperCase()) ?? 0;
  }
  currencies(): string[] {
    return [...this.cents.keys()].sort();
  }
  toMoney(): Money[] {
    return this.currencies().map((c) => moneyFromMinor(this.cents.get(c)!, c));
  }
}

export function formatMoneyList(list: Money[]): string {
  return list.length ? list.map((m) => `${m.amount} ${m.currency}`).join(" + ") : "0";
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

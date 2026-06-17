export interface ValidationResult<T> {
  data: T | null;
  error: string | null;
}

export function fail<T>(error: string): ValidationResult<T> {
  return { data: null, error };
}

export function ok<T>(data: T): ValidationResult<T> {
  return { data, error: null };
}

export function requiredText(formData: FormData, name: string, label: string): ValidationResult<string> {
  const value = (formData.get(name) as string | null)?.trim() ?? "";
  return value ? ok(value) : fail(`${label} is required.`);
}

export function optionalText(formData: FormData, name: string): string | null {
  const value = (formData.get(name) as string | null)?.trim() ?? "";
  return value || null;
}

export function parseInteger(
  formData: FormData,
  name: string,
  fallback: number,
  options: { min?: number; max?: number; label?: string } = {},
): ValidationResult<number> {
  const raw = (formData.get(name) as string | null) ?? "";
  if (!raw.trim()) return ok(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) return fail(`${options.label ?? name} must be a valid number.`);
  if (options.min !== undefined && value < options.min) return fail(`${options.label ?? name} must be at least ${options.min}.`);
  if (options.max !== undefined && value > options.max) return fail(`${options.label ?? name} must be at most ${options.max}.`);
  return ok(value);
}

export function parseMoneyAmount(
  formData: FormData,
  name: string,
  fallback: number,
  options: { min?: number; max?: number; label?: string } = {},
): ValidationResult<number> {
  const raw = (formData.get(name) as string | null) ?? "";
  if (!raw.trim()) return ok(fallback);
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fail(`${options.label ?? name} must be a valid amount.`);
  if (options.min !== undefined && value < options.min) return fail(`${options.label ?? name} must be at least ${options.min}.`);
  if (options.max !== undefined && value > options.max) return fail(`${options.label ?? name} must be at most ${options.max}.`);
  return ok(value);
}

export function parseJsonStringArray(formData: FormData, name: string): ValidationResult<string[]> {
  const raw = (formData.get(name) as string | null) || "[]";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      return fail(`${name} must be a list of IDs.`);
    }
    return ok(parsed);
  } catch {
    return fail(`${name} contains invalid JSON.`);
  }
}

export function parseJsonArray(formData: FormData, name: string): ValidationResult<unknown[]> {
  const raw = (formData.get(name) as string | null) || "[]";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fail(`${name} must be a JSON array.`);
    return ok(parsed);
  } catch {
    return fail(`${name} contains invalid JSON.`);
  }
}

export function parseJsonRecord(formData: FormData, name: string, fallback: Record<string, unknown> = {}): ValidationResult<Record<string, unknown>> {
  const raw = (formData.get(name) as string | null) || JSON.stringify(fallback);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail(`${name} must be a JSON object.`);
    }
    return ok(parsed as Record<string, unknown>);
  } catch {
    return fail(`${name} contains invalid JSON.`);
  }
}

export function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return asUtc - date.getTime();
}

function parseLocalDateTimeInZone(raw: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw);
  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, year, month, day, hour, minute] = match;
  const utcGuess = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  ));
  const offset = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

export function parseDateRange(formData: FormData, timeZone = "UTC"): ValidationResult<{ startsAt: Date | null; endsAt: Date | null }> {
  const startsAtRaw = (formData.get("startsAt") as string | null) ?? "";
  const endsAtRaw = (formData.get("endsAt") as string | null) ?? "";
  const startsAt = startsAtRaw ? parseLocalDateTimeInZone(startsAtRaw, timeZone) : null;
  const endsAt = endsAtRaw ? parseLocalDateTimeInZone(endsAtRaw, timeZone) : null;

  if (startsAtRaw && (!startsAt || Number.isNaN(startsAt.getTime()))) return fail("Start date is invalid.");
  if (endsAtRaw && (!endsAt || Number.isNaN(endsAt.getTime()))) return fail("End date is invalid.");
  if (startsAt && endsAt && endsAt <= startsAt) return fail("End date must be after start date.");
  if (endsAt && !startsAt) return fail("Set a start date before setting an end date.");

  return ok({ startsAt, endsAt });
}

export function ensureOneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
  label: string,
): ValidationResult<T> {
  if (!value) return ok(fallback);
  return (allowed as readonly string[]).includes(value)
    ? ok(value as T)
    : fail(`${label} is invalid.`);
}

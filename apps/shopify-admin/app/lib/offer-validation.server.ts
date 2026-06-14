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

export function parseDateRange(formData: FormData): ValidationResult<{ startsAt: Date | null; endsAt: Date | null }> {
  const startsAtRaw = (formData.get("startsAt") as string | null) ?? "";
  const endsAtRaw = (formData.get("endsAt") as string | null) ?? "";
  const startsAt = startsAtRaw ? new Date(startsAtRaw) : null;
  const endsAt = endsAtRaw ? new Date(endsAtRaw) : null;

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

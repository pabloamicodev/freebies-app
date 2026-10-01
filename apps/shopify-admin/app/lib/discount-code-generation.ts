// Web Crypto, not node:crypto: this module is also bundled into the Codes tab client.
function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max; // rejection sampling avoids modulo bias
  const buf = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % max;
}

export const CODE_CHARSETS = {
  // No 0/O/1/I so codes survive being read aloud or typed from a printout.
  unambiguous: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  alphanumeric: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numbers: "0123456789",
} as const;
export type CodeCharset = keyof typeof CODE_CHARSETS;

export const MAX_BATCH_SIZE = 5000;
export const MAX_CODE_LENGTH = 255;

export interface BatchSpec {
  prefix: string;
  length: number;
  charset: CodeCharset;
  count: number;
}

export function normalizePrefix(prefix: string): string {
  return prefix.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").replace(/^[-_]+/, "");
}

export function validateBatchSpec(spec: BatchSpec): string | null {
  if (!(spec.charset in CODE_CHARSETS)) return "Choose a valid character set.";
  if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > MAX_BATCH_SIZE) {
    return `Generate between 1 and ${MAX_BATCH_SIZE.toLocaleString("en-US")} codes at a time.`;
  }
  if (!Number.isInteger(spec.length) || spec.length < 4 || spec.length > 32) {
    return "Code length must be between 4 and 32 characters.";
  }
  if (normalizePrefix(spec.prefix).length + spec.length > MAX_CODE_LENGTH) {
    return "Prefix plus code length is too long.";
  }
  // Keep headroom so collision retries terminate: need the space to be well above the batch.
  const space = CODE_CHARSETS[spec.charset].length ** spec.length;
  if (space < spec.count * 4) {
    return "That length and character set can't produce enough unique codes. Increase the length.";
  }
  return null;
}

export function randomCode(spec: Pick<BatchSpec, "prefix" | "length" | "charset">): string {
  const alphabet = CODE_CHARSETS[spec.charset];
  let body = "";
  for (let i = 0; i < spec.length; i += 1) body += alphabet[randomInt(alphabet.length)];
  return normalizePrefix(spec.prefix) + body;
}

/** Up to `count` unique codes, skipping anything in `taken` (mutated with the new codes). */
export function generateUniqueCodes(spec: BatchSpec, taken: Set<string> = new Set()): string[] {
  const out: string[] = [];
  let attempts = 0;
  const maxAttempts = spec.count * 20 + 100;
  while (out.length < spec.count && attempts < maxAttempts) {
    attempts += 1;
    const code = randomCode(spec);
    if (taken.has(code)) continue;
    taken.add(code);
    out.push(code);
  }
  return out;
}

export interface RedeemableState {
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usageCount: number;
}

/** Whether a code should currently be usable at checkout. */
export function isCodeRedeemable(code: RedeemableState, now: Date = new Date()): boolean {
  if (code.status !== "active") return false;
  if (code.startsAt && code.startsAt > now) return false;
  if (code.endsAt && code.endsAt <= now) return false;
  if (code.usageLimit !== null && code.usageCount >= code.usageLimit) return false;
  return true;
}

function csvCell(value: string | number | boolean | Date | null): string {
  const text = value instanceof Date ? value.toISOString() : String(value ?? "");
  // Leading = + - @ would execute as a formula when the CSV is opened in a spreadsheet.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function discountCodesToCsv(
  rows: Array<RedeemableState & { code: string; oncePerCustomer: boolean }>,
): string {
  const header = "code,status,starts_at,ends_at,usage_limit,once_per_customer,usage_count";
  const lines = rows.map((row) =>
    [row.code, row.status, row.startsAt, row.endsAt, row.usageLimit, row.oncePerCustomer, row.usageCount]
      .map(csvCell)
      .join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

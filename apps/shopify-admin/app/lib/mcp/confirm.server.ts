import { createHash } from "node:crypto";

/** Control fields are not part of what an idempotency key binds: previews and executes differ in them by design. */
const CONTROL_KEYS = new Set(["dryRun", "confirmToken", "idempotencyKey", "expectedUpdatedAt", "expectedDiffHash"]);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function stripControlArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_KEYS.has(key)));
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(stripControlArgs(args))).digest("hex");
}

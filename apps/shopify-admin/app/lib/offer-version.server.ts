const VOLATILE_KEYS = new Set([
  "shopId",
  "createdAt",
  "updatedAt",
  "updatedBy",
  "compiledConfig",
  "functionMetafieldGid",
]);

/**
 * Produces the same positive revision from the same persisted offer rules,
 * independently of database row order or derived publication metadata.
 */
export function computeOfferVersion(
  offer: object,
  conditions: object[],
  rewards: object[],
  policy: object | null,
): number {
  const source = stableStringify({
    offer: normalize(offer),
    conditions: conditions.map(normalize).sort(compareSerialized),
    rewards: rewards.map(normalize).sort(compareSerialized),
    policy: policy ? normalize(policy) : null,
  });

  // FNV-1a, constrained to a positive signed 32-bit integer for portable
  // serialization across TypeScript and Rust.
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & 0x7fffffff || 1;
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function compareSerialized(left: unknown, right: unknown): number {
  return stableStringify(left).localeCompare(stableStringify(right));
}

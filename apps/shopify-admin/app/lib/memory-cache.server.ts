// Per-instance L1 in front of Redis for read-mostly values. Other instances are not notified of
// invalidations, so cross-instance staleness is bounded by the TTL.
const MAX_ENTRIES = 1_000;
const caches = new Set<Map<string, unknown>>();

export interface MemoryCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
}

export function createMemoryCache<T>(ttlMs = 10_000): MemoryCache<T> {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  caches.add(entries);
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      if (entries.size >= MAX_ENTRIES) {
        const now = Date.now();
        for (const [name, entry] of entries) if (entry.expiresAt <= now) entries.delete(name);
        if (entries.size >= MAX_ENTRIES) entries.clear();
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

export function resetMemoryCaches(): void {
  for (const entries of caches) entries.clear();
}

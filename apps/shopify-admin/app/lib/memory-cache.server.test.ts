import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCache, resetMemoryCaches } from "./memory-cache.server.js";

afterEach(() => {
  vi.useRealTimers();
  resetMemoryCaches();
});

describe("createMemoryCache", () => {
  it("serves a value until its TTL elapses", () => {
    vi.useFakeTimers();
    const cache = createMemoryCache<string>(10_000);
    cache.set("a", "1");
    expect(cache.get("a")).toBe("1");
    vi.advanceTimersByTime(10_001);
    expect(cache.get("a")).toBeUndefined();
  });

  it("deletes entries", () => {
    const cache = createMemoryCache<string>();
    cache.set("a", "1");
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
  });

  it("stays bounded", () => {
    const cache = createMemoryCache<number>();
    for (let i = 0; i < 1_500; i++) cache.set(`k${i}`, i);
    expect(cache.get("k0")).toBeUndefined();
    expect(cache.get("k1499")).toBe(1499);
  });
});

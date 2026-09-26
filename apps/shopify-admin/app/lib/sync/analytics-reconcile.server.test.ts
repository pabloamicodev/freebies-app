import { describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";
import type * as DrizzleOrm from "drizzle-orm";
import { cleanupOldAnalyticsEvents } from "./analytics-reconcile.server.js";

function fakeDb(batches: Array<Array<{ id: string }>>) {
  const remaining = [...batches];
  const deleteCalls: string[][] = [];

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(remaining.shift() ?? []),
        }),
      }),
    }),
    delete: () => ({
      where: (idsCondition: unknown) => {
        // drizzle's inArray(...) builds an opaque SQL node — recover the ids
        // vitest passed in via the mock instead of parsing SQL.
        deleteCalls.push((idsCondition as { __ids: string[] }).__ids);
        return Promise.resolve(undefined);
      },
    }),
  };
  return { db: db as unknown as Db, deleteCalls };
}

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    inArray: (_column: unknown, ids: string[]) => ({ __ids: ids }),
  };
});

describe("cleanupOldAnalyticsEvents", () => {
  it("deletes in batches of up to 5000 instead of one unbounded delete", async () => {
    const fullBatch = Array.from({ length: 5_000 }, (_, i) => ({ id: `id-${i}` }));
    const lastBatch = [{ id: "id-last" }];
    const { db, deleteCalls } = fakeDb([fullBatch, lastBatch]);

    const count = await cleanupOldAnalyticsEvents(90, db);

    expect(count).toBe(5_001);
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0]).toHaveLength(5_000);
    expect(deleteCalls[1]).toEqual(["id-last"]);
  });

  it("does nothing when there's nothing past the retention window", async () => {
    const { db, deleteCalls } = fakeDb([[]]);
    const count = await cleanupOldAnalyticsEvents(90, db);
    expect(count).toBe(0);
    expect(deleteCalls).toHaveLength(0);
  });
});

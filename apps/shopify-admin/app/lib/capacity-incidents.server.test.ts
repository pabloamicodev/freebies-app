import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { capacityIncidents, type Db } from "@promo/db";
import * as Sentry from "@sentry/node";
import {
  countOpenIncidents,
  dismissIncident,
  incidentDedupeKey,
  listOpenIncidents,
  recordCapacityIncident,
  resolveCapacityIncidents,
  snoozeIncidents,
} from "./capacity-incidents.server.js";
import { currentCapacityCaller, runWithCapacitySource } from "./capacity-source.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let otherShopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, "inc-a.myshopify.com");
  otherShopId = await seedShop(db, "inc-b.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  vi.mocked(Sentry.captureMessage).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  await db.delete(capacityIncidents);
});

const unattended = { source: "cron", attended: false } as const;
const tooLarge = (offerId: string, extra: Partial<{ splitRefusal: string; numbers: Record<string, number> }> = {}) => ({
  shopId,
  code: "OFFER_TOO_LARGE",
  offerIds: [offerId],
  numbers: { bytes: 20_000, ...extra.numbers },
  ...(extra.splitRefusal ? { splitRefusal: extra.splitRefusal } : {}),
});
const rows = (id = shopId) => db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, id));

describe("dedupe keys", () => {
  it("uses the code for shop-wide blocks, code:reason:offer for oversize offers and the sorted group otherwise", () => {
    expect(incidentDedupeKey({ code: "SLOT_FULL", offerIds: ["a"], numbers: {} })).toBe("SLOT_FULL");
    expect(incidentDedupeKey({ code: "OFFER_TOO_LARGE", offerIds: ["a"], numbers: { listKind: 1 } })).toBe("OFFER_TOO_LARGE:lists:a");
    expect(incidentDedupeKey({ code: "OFFER_TOO_LARGE", offerIds: ["a"], numbers: {}, splitRefusal: "GIFT_PICKER" })).toBe("OFFER_TOO_LARGE:GIFT_PICKER:a");
    expect(incidentDedupeKey({ code: "GROUP_TOO_LARGE", offerIds: ["b", "a"], numbers: {} })).toBe("GROUP_TOO_LARGE:a,b");
  });
});

describe("recordCapacityIncident", () => {
  it("dedupes two parallel records into one row with occurrences 2", async () => {
    const block = tooLarge("o1");
    await Promise.all([recordCapacityIncident(db, block, unattended), recordCapacityIncident(db, block, unattended)]);
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]?.occurrences).toBe(2);
    expect(found[0]).toMatchObject({ code: "OFFER_TOO_LARGE", reason: "bytes", source: "cron", attended: false, status: "open" });
  });

  it("merges held offers by id on a repeat block, the latest entry per offer winning", async () => {
    const entry = (id: string, status: string, updatedAt: string) => ({ id, status, updatedAt });
    await recordCapacityIncident(db, { shopId, code: "SLOT_FULL", offerIds: ["a"], numbers: {}, held: [entry("a", "draft", "2026-01-01T00:00:00.000Z")] }, unattended);
    await recordCapacityIncident(db, { shopId, code: "SLOT_FULL", offerIds: ["a", "b"], numbers: {}, held: [entry("b", "paused", "2026-01-02T00:00:00.000Z"), entry("a", "paused", "2026-01-03T00:00:00.000Z")] }, unattended);
    await recordCapacityIncident(db, { shopId, code: "SLOT_FULL", offerIds: ["a", "b"], numbers: {} }, unattended);
    const [row] = await rows();
    expect([...row!.held].sort((x, y) => x.id.localeCompare(y.id))).toEqual([entry("a", "paused", "2026-01-03T00:00:00.000Z"), entry("b", "paused", "2026-01-02T00:00:00.000Z")]);
  });

  it("keeps the latest numbers and offer ids on a repeat", async () => {
    await recordCapacityIncident(db, { shopId, code: "SLOT_FULL", offerIds: ["a"], numbers: { neededBytes: 1 } }, unattended);
    await recordCapacityIncident(db, { shopId, code: "SLOT_FULL", offerIds: ["a", "b"], numbers: { neededBytes: 2 } }, unattended);
    const [row] = await rows();
    expect(row?.numbers).toEqual({ neededBytes: 2 });
    expect(row?.offerIds).toEqual(["a", "b"]);
  });

  it("does not record codes the modal does not know", async () => {
    await recordCapacityIncident(db, { shopId, code: "COMPILE_ERROR", offerIds: ["a"], numbers: {} }, unattended);
    expect(await rows()).toHaveLength(0);
  });

  it("alerts Sentry once per 6 hours for unattended blocks and never for attended ones", async () => {
    const block = tooLarge("o1");
    await recordCapacityIncident(db, block, unattended);
    await recordCapacityIncident(db, block, unattended);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureMessage).mock.calls[0]).toEqual(["Capacity block while unattended", expect.anything()]);
    await db.update(capacityIncidents).set({ lastAlertedAt: sql`now() - interval '7 hours'` });
    await recordCapacityIncident(db, block, unattended);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);

    vi.mocked(Sentry.captureMessage).mockClear();
    await recordCapacityIncident(db, tooLarge("o2"), { source: "admin", attended: true });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("takes source and attendance from the ambient scope, defaulting to unattended background", async () => {
    expect(currentCapacityCaller()).toEqual({ source: "background", attended: false });
    await runWithCapacitySource("webhook", false, () => recordCapacityIncident(db, tooLarge("o1")));
    expect((await rows())[0]?.source).toBe("webhook");
  });

  it("keeps a dismissed incident dismissed and counts the repeat", async () => {
    await recordCapacityIncident(db, tooLarge("o1"), unattended);
    const [row] = await rows();
    expect(await dismissIncident(db, shopId, row!.id)).toBe(true);
    await recordCapacityIncident(db, tooLarge("o1"), unattended);
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: "dismissed", occurrences: 2 });
  });

  it("opens a fresh incident after the old one resolved", async () => {
    await recordCapacityIncident(db, tooLarge("o1"), unattended);
    await db.update(capacityIncidents).set({ status: "resolved", resolution: "published" });
    await recordCapacityIncident(db, tooLarge("o1"), unattended);
    expect(await rows()).toHaveLength(2);
  });

  it("never throws into the publish path", async () => {
    const broken = { insert: () => { throw new Error("db down"); } } as unknown as Db;
    await expect(recordCapacityIncident(broken, tooLarge("o1"), unattended)).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCapacityIncidents", () => {
  it("resolves as published when every offer is active, and when the incident has no offers", async () => {
    const a = await seedOffer(db, shopId, { status: "active" });
    await recordCapacityIncident(db, tooLarge(a), unattended);
    await recordCapacityIncident(db, { shopId, code: "AUTOMATIC_DISCOUNT_LIMIT", offerIds: [], numbers: { needed: 1 } }, unattended);
    expect(await resolveCapacityIncidents(db, shopId)).toBe(2);
    const found = await rows();
    expect(found.every((row) => row.status === "resolved" && row.resolution === "published" && row.resolvedAt)).toBe(true);
  });

  it("resolves as moot once the offers are archived or deleted", async () => {
    const archived = await seedOffer(db, shopId, { status: "archived" });
    await recordCapacityIncident(db, tooLarge(archived), unattended);
    await recordCapacityIncident(db, tooLarge("00000000-0000-0000-0000-000000000009"), unattended);
    expect(await resolveCapacityIncidents(db, shopId)).toBe(2);
    expect((await rows()).map((row) => row.resolution)).toEqual(["moot", "moot"]);
  });

  it("keeps the incident open while an offer is still draft or paused, and resolves dismissed ones", async () => {
    const draft = await seedOffer(db, shopId, { status: "draft" });
    const paused = await seedOffer(db, shopId, { status: "paused" });
    const ok = await seedOffer(db, shopId, { status: "active" });
    await recordCapacityIncident(db, tooLarge(draft), unattended);
    await recordCapacityIncident(db, tooLarge(paused), unattended);
    await recordCapacityIncident(db, tooLarge(ok), unattended);
    const [okRow] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.dedupeKey, `OFFER_TOO_LARGE:bytes:${ok}`));
    await dismissIncident(db, shopId, okRow!.id);
    expect(await resolveCapacityIncidents(db, shopId)).toBe(1);
    const open = await listOpenIncidents(db, shopId);
    expect(open.map((row) => row.offerIds[0]).sort()).toEqual([draft, paused].sort());
  });

  it("never touches another shop's incidents", async () => {
    const a = await seedOffer(db, shopId, { status: "active" });
    await recordCapacityIncident(db, { ...tooLarge(a), shopId: otherShopId }, unattended);
    expect(await resolveCapacityIncidents(db, shopId)).toBe(0);
    expect((await rows(otherShopId))[0]?.status).toBe("open");
  });
});

describe("counts, snooze and dismiss", () => {
  it("counts open incidents and the unsnoozed ones, scoped by shop", async () => {
    await recordCapacityIncident(db, tooLarge("o1"), unattended);
    await recordCapacityIncident(db, tooLarge("o2"), unattended);
    await recordCapacityIncident(db, { ...tooLarge("o3"), shopId: otherShopId }, unattended);
    expect(await countOpenIncidents(db, shopId)).toEqual({ open: 2, unsnoozed: 2 });
    await snoozeIncidents(db, shopId);
    expect(await countOpenIncidents(db, shopId)).toEqual({ open: 2, unsnoozed: 0 });
    expect(await countOpenIncidents(db, otherShopId)).toEqual({ open: 1, unsnoozed: 1 });
    await db.update(capacityIncidents).set({ snoozedUntil: sql`now() - interval '1 minute'` }).where(and(eq(capacityIncidents.shopId, shopId)));
    expect((await countOpenIncidents(db, shopId)).unsnoozed).toBe(2);
  });

  it("refuses to dismiss an incident of another shop", async () => {
    await recordCapacityIncident(db, { ...tooLarge("o1"), shopId: otherShopId }, unattended);
    const [row] = await rows(otherShopId);
    expect(await dismissIncident(db, shopId, row!.id)).toBe(false);
  });
});

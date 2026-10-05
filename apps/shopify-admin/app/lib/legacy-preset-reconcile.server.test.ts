import { describe, expect, it } from "vitest";
import { offerConditions, offerRewards, offerVersions, offers } from "@promo/db";
import {
  LEGACY_RECONCILER,
  planReconcile,
  reconcileLegacyPreset,
  type ExistingOffer,
} from "./legacy-preset-reconcile.server.js";
import {
  LEGACY_IMPORTER,
  getLegacyStorePreset,
  presetConditionRows,
  presetRewardRows,
  type LegacyOfferPreset,
  type LegacyStorePreset,
} from "./legacy-store-presets.server.js";

const T0 = new Date("2026-09-24T10:00:00.000Z");
const SHOP = "shop-1";

function existing(po: LegacyOfferPreset, over: Partial<ExistingOffer["offer"]> = {}): ExistingOffer {
  const offerId = `id-${po.key}`;
  const row = { createdAt: T0, updatedAt: T0 };
  return {
    versionCount: 0,
    offer: {
      id: offerId,
      shopId: SHOP,
      type: po.type,
      status: "draft",
      internalName: po.internalName,
      publicTitle: po.publicTitle,
      description: po.description,
      priority: po.priority,
      createdBy: LEGACY_IMPORTER,
      updatedBy: LEGACY_IMPORTER,
      createdAt: T0,
      updatedAt: T0,
      ...over,
    } as ExistingOffer["offer"],
    conditions: presetConditionRows(SHOP, offerId, po).map((r, i) => ({ id: `c${i}`, ...r, ...row })) as never,
    rewards: presetRewardRows(SHOP, offerId, po).map((r, i) => ({ id: `r${i}`, ...r, ...row })) as never,
  };
}

const preset = getLegacyStorePreset("ambrosia-nutraceuticals.myshopify.com")!;
const landing = preset.offers.find((o) => o.key === "landing-kinetic-sk-otg-freegifts")!;
const staleOf = (po: LegacyOfferPreset, over: Partial<ExistingOffer["offer"]> = {}): ExistingOffer => {
  const e = existing(po, over);
  // the pre-fix import: default cart_value condition + anchor-line subscription flag
  e.conditions = [{ ...e.conditions[0]!, conditionType: "cart_value", operator: "gte", value: { thresholdCents: 0, currencyCode: "USD", includeGiftValues: false } }];
  e.rewards = [{ ...e.rewards[0]!, target: { ...(e.rewards[0]!.target as object), requiresAnchorSubscription: true } }];
  return e;
};
const mini = (offer: LegacyOfferPreset): LegacyStorePreset => ({ ...preset, offers: [offer] });
const plan = (e: ExistingOffer | undefined, po = landing) =>
  planReconcile(mini(po), new Map(e ? [[po.internalName, e]] : []))[0]!;

describe("planReconcile", () => {
  it("imports a missing offer", () => {
    expect(plan(undefined)).toMatchObject({ action: "import", status: null });
  });

  it("reports an identical offer as in sync, whatever its status", () => {
    expect(plan(existing(landing)).action).toBe("in_sync");
    expect(plan(existing(landing, { status: "active" })).action).toBe("in_sync");
  });

  it("updates a pristine drifted draft and reports the exact diff", () => {
    const result = plan(staleOf(landing));
    expect(result.action).toBe("update");
    expect(result.diff).toEqual(
      expect.arrayContaining([
        'condition[0].conditionType: db="cart_value" preset="subscription_product_type"',
        "reward[0].target.requiresAnchorSubscription: db=true preset=false",
      ]),
    );
  });

  it.each([
    ["active", { status: "active" as const }],
    ["paused", { status: "paused" as const }],
  ])("never touches a %s offer", (_n, over) => {
    const result = plan(staleOf(landing, over));
    expect(result.action).toBe("manual_review");
    expect(result.reasons[0]).toContain("status is");
    expect(result.diff.length).toBeGreaterThan(0);
  });

  it("flags a draft that was edited by someone else", () => {
    expect(plan(staleOf(landing, { updatedBy: "user@example.com" })).reasons.join()).toContain("updatedBy is user@example.com");
  });

  it("flags a draft that was published before (offer_versions exist)", () => {
    const e = staleOf(landing);
    e.versionCount = 1;
    expect(plan(e).action).toBe("manual_review");
  });

  it("flags a draft whose rows were replaced after import", () => {
    const e = staleOf(landing);
    e.conditions = e.conditions.map((c) => ({ ...c, createdAt: new Date(T0.getTime() + 3_600_000), updatedAt: new Date(T0.getTime() + 3_600_000) }));
    expect(plan(e).reasons.join()).toContain("rows replaced");
  });

  it("flags a draft whose row was edited in place", () => {
    const e = staleOf(landing);
    e.rewards = e.rewards.map((r) => ({ ...r, updatedAt: new Date(T0.getTime() + 5_000) }));
    expect(plan(e).reasons.join()).toContain("edited after creation");
  });

  it("an offer already reconciled is judged against the reconcile time, not the import time", () => {
    const later = new Date(T0.getTime() + 86_400_000);
    const e = staleOf(landing, { updatedBy: LEGACY_RECONCILER, updatedAt: later });
    e.conditions = e.conditions.map((c) => ({ ...c, createdAt: later, updatedAt: later }));
    e.rewards = e.rewards.map((r) => ({ ...r, createdAt: later, updatedAt: later }));
    expect(plan(e).action).toBe("update");
  });

  it("never changes an offer's type automatically", () => {
    const e = staleOf(landing);
    e.offer = { ...e.offer, type: "gift" };
    expect(plan(e).action).toBe("manual_review");
  });
});

/** Records every write; select().from(table).where() resolves to the table's seeded rows. */
function fakeDb(state: Map<unknown, unknown[]>) {
  const writes: { op: string; table: unknown; values?: unknown }[] = [];
  let transactions = 0;
  const writer = {
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        writes.push({ op: "insert", table, values });
        return Object.assign(Promise.resolve(), { returning: async () => [{ id: "new-offer-id" }] });
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({ where: async () => void writes.push({ op: "update", table, values }) }),
    }),
    delete: (table: unknown) => ({ where: async () => void writes.push({ op: "delete", table }) }),
  };
  const db = {
    ...writer,
    select: () => ({ from: (table: unknown) => ({ where: async () => state.get(table) ?? [] }) }),
    transaction: async (fn: (tx: typeof writer) => Promise<void>) => {
      transactions += 1;
      await fn(writer);
    },
  };
  return { db: db as never, writes, transactions: () => transactions };
}

function seed(...items: ExistingOffer[]) {
  return new Map<unknown, unknown[]>([
    [offers, items.map((i) => i.offer)],
    [offerConditions, items.flatMap((i) => i.conditions)],
    [offerRewards, items.flatMap((i) => i.rewards)],
    [offerVersions, items.flatMap((i) => Array.from({ length: i.versionCount }, () => ({ offerId: i.offer.id })))],
  ]);
}

describe("reconcileLegacyPreset", () => {
  const paused = staleOf(preset.offers.find((o) => o.key === "landing-nektar-skin-v2")!, { status: "paused" });
  const drifted = staleOf(landing);
  const synced = existing(preset.offers.find((o) => o.key === "landing-scoped-product-mtvt54kq")!);
  const subset: LegacyStorePreset = {
    ...preset,
    offers: preset.offers.filter((o) =>
      ["landing-nektar-skin-v2", "landing-kinetic-sk-otg-freegifts", "landing-scoped-product-mtvt54kq", "landing-planta-sk-otg-freegifts"].includes(o.key),
    ),
  };

  it("is a dry-run by default: reads only, no writes, no transactions", async () => {
    const f = fakeDb(seed(paused, drifted, synced));
    const out = await reconcileLegacyPreset(f.db, SHOP, subset);
    expect(out.applied).toBe(false);
    expect(out.counts).toEqual({ import: 1, update: 1, inSync: 1, manualReview: 1 });
    expect(f.writes).toEqual([]);
    expect(f.transactions()).toBe(0);
  });

  it("apply: imports the missing offer, rewrites the pristine draft in one transaction, never writes the paused one", async () => {
    const f = fakeDb(seed(paused, drifted, synced));
    const out = await reconcileLegacyPreset(f.db, SHOP, subset, { apply: true });
    expect(out.results.map((r) => [r.key, r.action])).toEqual([
      ["landing-nektar-skin-v2", "manual_review"],
      ["landing-kinetic-sk-otg-freegifts", "update"],
      ["landing-planta-sk-otg-freegifts", "import"],
      ["landing-scoped-product-mtvt54kq", "in_sync"],
    ]);
    expect(f.transactions()).toBe(2); // one per written offer
    // nothing referencing the paused offer's id
    expect(JSON.stringify(f.writes.map((w) => w.values), (_k, v) => (v && typeof v === "object" && "queryChunks" in v ? "[sql]" : v))).not.toContain(paused.offer.id);
    const ops = f.writes.map((w) => `${w.op}:${w.table === offers ? "offers" : w.table === offerConditions ? "conditions" : w.table === offerRewards ? "rewards" : "other"}`);
    expect(ops).toEqual(
      expect.arrayContaining([
        "delete:conditions", "delete:rewards", "insert:conditions", "insert:rewards", "update:offers", // update path
        "insert:offers", // import path
      ]),
    );
    const update = f.writes.find((w) => w.op === "update")!;
    expect(update.values).toMatchObject({ updatedBy: LEGACY_RECONCILER });
    const inserted = f.writes.find((w) => w.op === "insert" && w.table === offerConditions)!;
    expect(inserted.values).toMatchObject([{ conditionType: "subscription_product_type", operator: "eq", scope: "main" }]);
  });

  it("is idempotent: a second run over the corrected rows finds nothing to do", async () => {
    const fixed = existing(landing);
    const f = fakeDb(seed(fixed));
    const out = await reconcileLegacyPreset(f.db, SHOP, mini(landing), { apply: true });
    expect(out.counts).toMatchObject({ import: 0, update: 0, inSync: 1 });
    expect(f.writes).toEqual([]);
  });
});

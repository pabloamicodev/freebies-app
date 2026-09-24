import { describe, expect, it, vi } from "vitest";
import {
  executeOfferSchedule,
  planOfferScheduleTransitions,
  type DueOffer,
  type OfferScheduleDependencies,
} from "./offer-scheduling.server.js";

const now = new Date("2026-09-24T12:00:00.000Z");

function due(overrides: Partial<DueOffer> = {}): DueOffer {
  return {
    id: "offer-1",
    shopId: "shop-1",
    shopDomain: "store.myshopify.com",
    status: "scheduled",
    startsAt: new Date("2026-09-24T11:00:00.000Z"),
    endsAt: null,
    ...overrides,
  };
}

function dependencies(rows: DueOffer[]): OfferScheduleDependencies {
  return {
    loadDueOffers: vi.fn().mockResolvedValue(rows),
    applyTransitions: vi.fn().mockResolvedValue(undefined),
    rollbackTransitions: vi.fn().mockResolvedValue(undefined),
    validateOffers: vi.fn().mockResolvedValue({ ok: true }),
    publishShop: vi.fn().mockResolvedValue(null),
  };
}

describe("offer scheduler", () => {
  it("expires an ended scheduled offer instead of briefly activating it", () => {
    expect(planOfferScheduleTransitions([
      due({ endsAt: new Date("2026-09-24T11:30:00.000Z") }),
    ], now)).toEqual([expect.objectContaining({ from: "scheduled", to: "expired" })]);
  });

  it("publishes successful transitions for each affected shop", async () => {
    const deps = dependencies([
      due(),
      due({ id: "offer-2", status: "active", startsAt: null, endsAt: new Date("2026-09-24T11:00:00.000Z") }),
    ]);

    await expect(executeOfferSchedule(deps, now)).resolves.toEqual({
      activated: 1,
      expired: 1,
      failures: [],
    });
    expect(deps.applyTransitions).toHaveBeenCalledTimes(1);
    expect(deps.publishShop).toHaveBeenCalledWith("shop-1", "store.myshopify.com");
    expect(deps.rollbackTransitions).not.toHaveBeenCalled();
  });

  it("still expires valid rows when a due activation is not publishable", async () => {
    const deps = dependencies([
      due(),
      due({ id: "offer-2", status: "active", startsAt: null, endsAt: new Date("2026-09-24T11:00:00.000Z") }),
    ]);
    vi.mocked(deps.validateOffers).mockResolvedValue({ ok: false, error: "invalid offer" });

    const result = await executeOfferSchedule(deps, now);

    expect(result.activated).toBe(0);
    expect(result.expired).toBe(1);
    expect(result.failures).toEqual([expect.objectContaining({ stage: "validation", error: "invalid offer" })]);
    expect(deps.applyTransitions).toHaveBeenCalledWith([
      expect.objectContaining({ id: "offer-2", to: "expired" }),
    ], now);
  });

  it("rolls back database state and republishes the previous config after publish failure", async () => {
    const deps = dependencies([due()]);
    vi.mocked(deps.publishShop).mockResolvedValueOnce("Shopify unavailable").mockResolvedValueOnce(null);

    const result = await executeOfferSchedule(deps, now);

    expect(result.activated).toBe(0);
    expect(result.failures).toEqual([expect.objectContaining({ stage: "publish", error: "Shopify unavailable" })]);
    expect(deps.rollbackTransitions).toHaveBeenCalledTimes(1);
    expect(deps.publishShop).toHaveBeenCalledTimes(2);
  });

  it("also rolls back when the publisher throws before returning an error", async () => {
    const deps = dependencies([due()]);
    vi.mocked(deps.publishShop)
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(null);

    const result = await executeOfferSchedule(deps, now);

    expect(result.failures).toEqual([
      expect.objectContaining({ stage: "publish", error: "network timeout" }),
    ]);
    expect(deps.rollbackTransitions).toHaveBeenCalledTimes(1);
  });
});

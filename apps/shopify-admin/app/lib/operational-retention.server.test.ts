import { describe, expect, it, vi } from "vitest";
import { cleanupOperationalState, operationalRetentionCutoffs } from "./operational-retention.server.js";

describe("operational retention", () => {
  it("uses separate short-lived cutoffs for rate limits and webhook deliveries", () => {
    const now = new Date("2026-09-24T12:00:00.000Z");

    expect(operationalRetentionCutoffs(now, {
      rateLimitHours: 24,
      processedWebhookDays: 7,
      failedWebhookDays: 30,
      stuckProcessingWebhookDays: 1,
    })).toEqual({
      staleRateLimits: new Date("2026-09-23T12:00:00.000Z"),
      processedWebhooks: new Date("2026-09-17T12:00:00.000Z"),
      failedWebhooks: new Date("2026-08-25T12:00:00.000Z"),
      stuckProcessingWebhooks: new Date("2026-09-23T12:00:00.000Z"),
    });
  });

  it("returns deletion counts from all operational stores", async () => {
    const returning = vi.fn()
      .mockResolvedValueOnce([{ key: "old-rate-limit" }])
      .mockResolvedValueOnce([{ webhookId: "processed" }, { webhookId: "processed-2" }])
      .mockResolvedValueOnce([{ webhookId: "failed" }])
      .mockResolvedValueOnce([{ webhookId: "stuck-processing" }]);
    const where = vi.fn(() => ({ returning }));
    const deleteFrom = vi.fn(() => ({ where }));
    const db = { delete: deleteFrom };

    await expect(cleanupOperationalState(
      db as never,
      new Date("2026-09-24T12:00:00.000Z"),
    )).resolves.toEqual({
      rateLimits: 1,
      processedWebhooks: 2,
      failedWebhooks: 1,
      stuckProcessingWebhooks: 1,
    });
    expect(deleteFrom).toHaveBeenCalledTimes(4);
  });
});

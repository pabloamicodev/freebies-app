import { describe, expect, it, vi } from "vitest";
vi.mock("@sentry/node", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
import { planTimezoneFix, reinterpretInZone } from "./offer-timezone-fix.server.js";

const d = (s: string) => new Date(s);
const now = d("2026-10-05T12:00:00Z");

describe("reinterpretInZone", () => {
  it("keeps the wall-clock, moves the instant", () => {
    expect(reinterpretInZone(d("2026-10-06T00:01:00Z"), "America/New_York")!.toISOString()).toBe("2026-10-06T04:01:00.000Z");
    expect(reinterpretInZone(d("2026-10-06T00:01:00Z"), "America/Los_Angeles")!.toISOString()).toBe("2026-10-06T07:01:00.000Z");
    expect(reinterpretInZone(null, "America/New_York")).toBeNull();
  });
});

describe("planTimezoneFix", () => {
  const w = { startsAt: d("2026-10-06T00:01:00Z"), endsAt: d("2026-10-07T23:59:00Z") };
  it("shifts a scheduled offer and keeps it scheduled", () => {
    const p = planTimezoneFix({ status: "scheduled", ...w }, "America/New_York", now)!;
    expect(p.startsAt!.toISOString()).toBe("2026-10-06T04:01:00.000Z");
    expect(p.endsAt!.toISOString()).toBe("2026-10-08T03:59:00.000Z");
    expect(p.status).toBe("scheduled");
    expect(p.changed).toBe(true);
  });
  it("recomputes status: an active offer whose real start is still ahead becomes scheduled", () => {
    const p = planTimezoneFix({ status: "active", startsAt: d("2026-10-05T10:00:00Z"), endsAt: null }, "America/Los_Angeles", now)!;
    expect(p.status).toBe("scheduled");
  });
  it("paused stays paused, draft stays draft, archived/expired untouched", () => {
    expect(planTimezoneFix({ status: "paused", ...w }, "America/New_York", now)!.status).toBe("paused");
    expect(planTimezoneFix({ status: "draft", ...w }, "America/New_York", now)!.status).toBe("draft");
    expect(planTimezoneFix({ status: "archived", ...w }, "America/New_York", now)).toBeNull();
    expect(planTimezoneFix({ status: "expired", ...w }, "America/New_York", now)).toBeNull();
  });
  it("no-ops without dates", () => {
    expect(planTimezoneFix({ status: "active", startsAt: null, endsAt: null }, "America/New_York", now)!.changed).toBe(false);
  });
});

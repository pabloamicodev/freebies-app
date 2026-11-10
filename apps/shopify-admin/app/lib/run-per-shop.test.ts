import { describe, expect, it, vi } from "vitest";
import { runPerShop } from "./run-per-shop.js";

describe("runPerShop", () => {
  it("keeps going after a throw, reports it, and counts throws and false results as failures", async () => {
    const seen: string[] = [];
    const report = vi.fn();
    const failed = await runPerShop(
      [{ domain: "a" }, { domain: "b" }, { domain: "c" }, { domain: "d" }],
      async ({ domain }) => {
        seen.push(domain);
        if (domain === "b") throw new Error("boom");
        return domain !== "c";
      },
      report,
    );
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(failed).toBe(2);
    expect(report).toHaveBeenCalledWith("b: FAILED boom");
  });
  it("is zero when everything succeeds", async () => {
    expect(await runPerShop([{ domain: "a" }], async () => true)).toBe(0);
  });
});

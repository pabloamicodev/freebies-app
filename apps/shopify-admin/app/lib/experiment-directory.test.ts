import { describe, expect, it } from "vitest";
import {
  DIRECTORY_MAX_BYTES,
  DIRECTORY_MAX_EXPERIMENTS,
  experimentStaleness,
  parseExperimentDirectory,
} from "./experiment-directory.js";

const exp = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Test ${id}`,
  status: "RUNNING",
  type: "SPLIT_URL_TEST",
  mode: "redirect",
  variants: [
    { key: "control", name: "Control", control: true },
    { key: "variant_a", name: "Variant A", control: false },
  ],
  ...extra,
});
const payload = (experiments: unknown[]) => JSON.stringify({ v: 1, updatedAt: "2026-10-26T00:00:00Z", experiments });

describe("parseExperimentDirectory", () => {
  it("parses a valid directory", () => {
    const dir = parseExperimentDirectory(payload([exp("abcd1234")]));
    expect(dir).toEqual({
      experiments: [
        {
          id: "abcd1234",
          name: "Test abcd1234",
          status: "RUNNING",
          mode: "redirect",
          variants: [
            { key: "control", name: "Control", control: true },
            { key: "variant_a", name: "Variant A", control: false },
          ],
        },
      ],
    });
  });

  it.each([null, undefined, "", "not json", "[]", '{"v":2,"experiments":[]}', '{"v":1}', '{"v":1,"experiments":"x"}'])(
    "treats absent or garbage input as unavailable: %s",
    (raw) => {
      expect(parseExperimentDirectory(raw)).toEqual({ unavailable: true });
    },
  );

  it("rejects an oversize value", () => {
    const big = payload([exp("abcd1234", { name: "x".repeat(DIRECTORY_MAX_BYTES) })]);
    expect(parseExperimentDirectory(big)).toEqual({ unavailable: true });
  });

  it("caps at 50 experiments and drops duplicates and invalid entries", () => {
    const many = Array.from({ length: 60 }, (_, i) => exp(`exp${String(i).padStart(6, "0")}`));
    const dir = parseExperimentDirectory(payload([...many, exp("exp000000"), "junk", exp("BAD ID!")]));
    expect(dir.unavailable).toBeFalsy();
    expect(dir.unavailable ? [] : dir.experiments).toHaveLength(DIRECTORY_MAX_EXPERIMENTS);
  });

  it("drops arms with an invalid key and cleans foreign labels", () => {
    const dir = parseExperimentDirectory(
      payload([exp("abcd1234", { name: "<b>Hero\n</b>", variants: [{ key: "ok", name: "A" }, { key: "bad key!", name: "B" }, 5] })]),
    );
    if (dir.unavailable) throw new Error("expected a directory");
    expect(dir.experiments[0]!.name).toBe("b Hero /b");
    expect(dir.experiments[0]!.variants.map((v) => v.key)).toEqual(["ok"]);
  });
});

describe("experimentStaleness", () => {
  const dir = parseExperimentDirectory(payload([exp("abcd1234")]));
  it("flags a missing experiment and missing arms", () => {
    expect(experimentStaleness("zzzzzzzz", ["control"], dir)).toEqual({ experimentMissing: true, missingArms: [] });
    expect(experimentStaleness("abcd1234", ["control", "gone"], dir)).toEqual({ experimentMissing: false, missingArms: ["gone"] });
    expect(experimentStaleness("abcd1234", ["control"], dir)).toEqual({ experimentMissing: false, missingArms: [] });
  });
  it("flags nothing without a readable directory", () => {
    expect(experimentStaleness("zzzzzzzz", ["a"], { unavailable: true })).toBeNull();
    expect(experimentStaleness("zzzzzzzz", ["a"], null)).toBeNull();
    expect(experimentStaleness("", [], dir)).toBeNull();
  });
});

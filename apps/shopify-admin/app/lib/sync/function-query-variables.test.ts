import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeFunctionConfig } from "./compile-config.js";

const QUERY = resolve(__dirname, "../../../extensions/discount-function/src/cart_lines_discounts_generate_run.graphql");

describe("function config as input-query variables", () => {
  it("contains every variable the discount query declares, even when unused", () => {
    const declared = [...readFileSync(QUERY, "utf8").matchAll(/\$(\w+)\s*:/g)].map((match) => match[1]!);
    const serialized = JSON.parse(
      serializeFunctionConfig({ offers: [], shippingOffers: [], version: "1", compiledAt: "2026-01-01T00:00:00.000Z" }),
    ) as Record<string, unknown>;

    expect(declared.length).toBeGreaterThan(0);
    for (const name of new Set(declared)) expect(serialized[name], name).not.toBeUndefined();
  });

  it("keeps configured attribute keys over the unused placeholders", () => {
    const serialized = JSON.parse(
      serializeFunctionConfig({ offers: [], shippingOffers: [], version: "1", compiledAt: "x", l1: "gift_note", customerTags: ["vip"] } as never),
    ) as Record<string, unknown>;
    expect(serialized).toMatchObject({ l1: "gift_note", l2: "_promo_engine_unused", customerTags: ["vip"] });
  });
});

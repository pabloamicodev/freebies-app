import { describe, expect, it } from "vitest";
import { normalizeOfferSubconditions } from "./gift-subconditions.js";
import { subconditionsFromRows } from "./subcondition-prefill.js";

function roundTrip(input: Record<string, unknown>) {
  const first = normalizeOfferSubconditions(input);
  if (!first.success) throw new Error(first.error);
  const { activeSubs, subValues } = subconditionsFromRows(first.data);
  const second = normalizeOfferSubconditions(
    Object.fromEntries(activeSubs.map((id) => [id, subValues[id]])),
  );
  return { first: first.data, second, activeSubs };
}

describe("sub-condition prefill round-trip", () => {
  it("reopens page_types and UTM scope/flags exactly as saved", () => {
    const { first, second, activeSubs } = roundTrip({
      page_types: { pageTypes: ["product", "collection"], onlyMatchedLines: true, rejectUnmatchedLines: true },
      utm_parameters: { utmSource: "newsletter", scope: "visit", onlyMatchedLines: false, rejectUnmatchedLines: true },
      link: { requiredUrl: "/pages/vip", paramName: "ref", rejectUnmatchedLines: true },
    });
    expect(activeSubs).toEqual(["page_types", "utm_parameters", "link"]);
    expect(second).toEqual({ success: true, data: first });
    expect(first.find((row) => row.conditionType === "utm_parameters")!.value).toMatchObject({
      scope: "visit",
      rejectUnmatchedLines: true,
    });
  });

  it("keeps the other sub-conditions stable too", () => {
    const { first, second } = roundTrip({
      customer_tags: { includeTags: ["vip"], excludeTags: [] },
      location: { includeCountryCodes: ["US"], excludeCountryCodes: [] },
      order_history: { metric: "total_spent", operator: "gte", threshold: 50 },
    });
    expect(second).toEqual({ success: true, data: first });
  });

  it("rejects an empty or unknown page type list", () => {
    expect(normalizeOfferSubconditions({ page_types: { pageTypes: [] } }).success).toBe(false);
    expect(normalizeOfferSubconditions({ page_types: { pageTypes: ["checkout"] } }).success).toBe(false);
  });
});

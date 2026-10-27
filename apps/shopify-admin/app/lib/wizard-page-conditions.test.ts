import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIFT_SUBCONDITIONS,
  isFunctionEnforcedSubcondition,
  PAGE_SUBCONDITION_IDS,
  SUBCONDITION_CONDITION_TYPES,
} from "../components/subconditions/types.js";
import { initializeOfferConditionValues } from "./offer-condition-defaults.js";

const THEME_CONDITIONS = ["template", "section_shown", "experiment"] as const;
const routes = resolve(__dirname, "../routes");
const source = (file: string) => readFileSync(resolve(routes, file), "utf8");

describe("theme conditions are offered by every wizard", () => {
  it("are in the shared condition list with function enforcement", () => {
    for (const id of THEME_CONDITIONS) {
      expect(GIFT_SUBCONDITIONS.some((def) => def.id === id)).toBe(true);
      expect(SUBCONDITION_CONDITION_TYPES[id]).toEqual([id]);
      expect(isFunctionEnforcedSubcondition(id)).toBe(true);
    }
  });

  it("have a default value so adding the card works", () => {
    const values = initializeOfferConditionValues([...THEME_CONDITIONS], {});
    expect(Object.keys(values)).toEqual([...THEME_CONDITIONS]);
  });

  it("the shipping allow-list keeps them", () => {
    for (const id of THEME_CONDITIONS) expect(PAGE_SUBCONDITION_IDS).toContain(id);
  });

  it.each([
    "app.offers.new.discount.$template.tsx",
    "app.offers.new.bundle.$template.tsx",
    "app.offers.new.upsell.$template.tsx",
    "app.offers.new.codes.$template.tsx",
    "app.offers.new.shipping.$template.tsx",
  ])("%s renders the shared conditions builder", (file) => {
    expect(source(file)).toContain("<OfferConditionsBuilder");
  });

  it("the gift wizard and the offer editor list the full set", () => {
    for (const file of ["app.offers.new.gift.$template.tsx", "app.offers.$id._index.tsx"]) {
      expect(source(file)).toContain("types={GIFT_SUBCONDITIONS}");
    }
  });

  it("the gift-tier campaign builder renders the shared builder", () => {
    expect(readFileSync(resolve(routes, "../components/GiftTierCampaignBuilder.tsx"), "utf8")).toContain("<OfferConditionsBuilder");
  });

  it("the shipping wizard saves its page conditions, and the shipping codes step is no longer hidden", () => {
    const shipping = source("app.offers.new.shipping.$template.tsx");
    expect(shipping).toContain("normalizeOfferSubconditions");
    expect(shipping).toContain("only={PAGE_SUBCONDITION_IDS}");
    expect(source("app.offers.new.codes.$template.tsx")).not.toContain("{!isShipping && (\n            <OfferWizardSection step={nextStep()} title=\"Extra conditions");
  });

  it("the conditions page offers them as main and sub conditions", () => {
    const page = source("app.offers.$id.conditions.tsx");
    for (const id of THEME_CONDITIONS) {
      expect(page.match(new RegExp(`value: "${id}"`, "g"))?.length).toBe(2);
    }
  });
});

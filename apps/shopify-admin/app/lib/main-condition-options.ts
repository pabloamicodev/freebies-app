/** The "Add condition" dropdown of the offer detail page. */
export const MAIN_CONDITION_OPTIONS = [
  { value: "cart_value", label: "Cart Value — spend threshold" },
  { value: "cart_quantity", label: "Cart Quantity — item count" },
  { value: "cart_value_multiplier", label: "Cart Value Multiplier — earn gifts per $ spent" },
  { value: "specific_product", label: "Specific Product — must contain selected products" },
  { value: "page_url", label: "Page URL — restrict to specific storefront pages" },
  { value: "page_types", label: "Store pages — products added from home, collections, product pages…" },
  { value: "template", label: "Template — visitor saw one of these templates" },
  { value: "section_shown", label: "Section is shown — visitor saw one of these sections" },
  { value: "experiment", label: "Test group — visitor is in one of these arms" },
] as const;

/** Have no usable default, so their value is picked before the condition is created. */
export const VALUE_FIRST_CONDITIONS = ["template", "section_shown", "experiment"] as const;
export type ValueFirstCondition = (typeof VALUE_FIRST_CONDITIONS)[number];

export const valueFirstType = (type: string): ValueFirstCondition | null =>
  (VALUE_FIRST_CONDITIONS as readonly string[]).includes(type) ? (type as ValueFirstCondition) : null;

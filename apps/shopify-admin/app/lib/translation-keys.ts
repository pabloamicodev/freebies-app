import type { WidgetTranslations } from "@promo/shared-types";

export type TranslationKeyDef = { key: keyof WidgetTranslations; label: string; hint?: string; vars?: readonly string[] };

/** Editable storefront widget strings; shared by the admin page (client) and the translations service. */
export const TRANSLATION_KEYS: TranslationKeyDef[] = [
  { key: "progress.before_goal", label: "Progress bar — before goal", hint: "Use {{remaining_amount}} for the amount, {{remaining_quantity}} for quantity.", vars: ["remaining_amount", "remaining_quantity", "current_amount", "target_amount"] },
  { key: "progress.after_goal", label: "Progress bar — after goal" },
  { key: "progress.gift_tier_before_goal", label: "Gift tiers bar — before next tier", hint: "Use {{remaining_amount}} for the amount left to the next gift tier.", vars: ["remaining_amount"] },
  { key: "progress.gift_tier_after_goal", label: "Gift tiers bar — all gifts unlocked" },
  { key: "gift_slider.title", label: "Gift slider title" },
  { key: "gift_slider.confirm_button", label: "Gift slider confirm button" },
  { key: "gift_slider.out_of_stock", label: "Gift out of stock label" },
  { key: "gift_slider.free_label", label: "Free price label" },
  { key: "gift_slider.choose_variant", label: "Gift picker — choose a variant prompt" },
  { key: "gift_slider.limit_reached", label: "Gift picker — limit reached notice", hint: "Use {{max}} for the number of gifts.", vars: ["max"] },
  { key: "today_offer.title", label: "Today Offer widget title" },
  { key: "today_offer.button", label: "Today Offer button text" },
  { key: "volume_discount.title", label: "Volume discount title" },
  { key: "fbt.title", label: "FBT widget title" },
  { key: "fbt.add_button", label: "FBT add button", hint: "Use {{count}} for number of items.", vars: ["count"] },
  { key: "upsell.no_thanks", label: "Upsell dismiss text" },
];

/** Widget strings are one line of storefront text. */
export const MAX_TRANSLATION_LENGTH = 300;

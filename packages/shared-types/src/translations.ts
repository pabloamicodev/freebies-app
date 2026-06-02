import { z } from "zod";

/** Supported locales with fallback to English. */
export const SUPPORTED_LOCALES = [
  "en", "es", "fr", "de", "ja", "nl", "it", "pt", "zh", "ko", "sv", "da", "fi", "nb",
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Widget translation strings — all with English defaults. */
export const WidgetTranslationsSchema = z.object({
  locale: z.string(),
  /** Cart message / progress bar strings. */
  "progress.before_goal": z.string().default("Spend {{remaining_amount}} more for a free gift!"),
  "progress.after_goal": z.string().default("You've unlocked your free gift! 🎁"),
  /** Gift slider. */
  "gift_slider.title": z.string().default("Choose Your Free Gift"),
  "gift_slider.subtitle": z.string().optional(),
  "gift_slider.confirm_button": z.string().default("Add Gift to Cart"),
  "gift_slider.out_of_stock": z.string().default("Out of Stock"),
  "gift_slider.free_label": z.string().default("Free"),
  /** Today offer. */
  "today_offer.title": z.string().default("Today's Deals"),
  "today_offer.button": z.string().default("View →"),
  /** Volume discount. */
  "volume_discount.title": z.string().default("Volume Discounts"),
  /** FBT. */
  "fbt.title": z.string().default("Frequently Bought Together"),
  "fbt.add_button": z.string().default("Add {{count}} to Cart"),
  /** Upsell. */
  "upsell.no_thanks": z.string().default("No thanks"),
});
export type WidgetTranslations = z.infer<typeof WidgetTranslationsSchema>;

/** Interpolate template strings: "Spend {{amount}} more" → "Spend $50.00 more" */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

/** Pick the best translation for a locale with English fallback. */
export function pickTranslation(
  translations: Record<string, WidgetTranslations>,
  locale: string,
): WidgetTranslations {
  const exact = translations[locale];
  if (exact) return exact;
  // Try language prefix (e.g. "fr" for "fr-CA")
  const prefix = locale.split("-")[0];
  if (prefix && translations[prefix]) return translations[prefix]!;
  // Fallback to English
  return translations["en"] ?? WidgetTranslationsSchema.parse({ locale: "en" });
}

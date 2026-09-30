import { z } from "zod";

export const CurrencyContextSchema = z.object({
  activeCurrencyCode: z.string().length(3),
  shopCurrencyCode: z.string().length(3),
  exchangeRate: z.number().positive().optional(),
});
export type CurrencyContext = z.infer<typeof CurrencyContextSchema>;

/**
 * Currency codes supported in the promo engine UI for per-currency threshold overrides.
 * Single source of truth — import from @promo/shared-types instead of duplicating.
 */
export const SUPPORTED_CURRENCIES = [
  "AFN","AUD","AWG","BBD","BZD","CAD","CNY","DJF","EUR","FKP",
  "GBP","HKD","JPY","MXN","USD",
] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

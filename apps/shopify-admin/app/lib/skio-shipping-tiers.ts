import { z } from "zod";

export const skioVariantGidSchema = z
  .string()
  .trim()
  .startsWith("gid://shopify/ProductVariant/");

export const shippingOverrideSchema = z.object({
  amount: z.number().min(0).nullable(),
});

export const cycleOverrideSchema = z.object({
  cycle: z.number().int().positive(),
  override: shippingOverrideSchema,
});

export const skioShippingTierSchema = z
  .object({
    id: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers, and hyphens."),
    name: z.string().trim().min(1).max(120),
    subscriptionDurationMonths: z.number().int().positive(),
    minSubtotal: z.number().min(0).default(0),
    maxSubtotal: z.number().min(0).nullable().default(null),
    productVariantIds: z.array(skioVariantGidSchema).max(250).nullable().default(null),
    cycleOverrides: z.array(cycleOverrideSchema).max(100).default([]).refine(
      (entries) => new Set(entries.map((entry) => entry.cycle)).size === entries.length,
      { message: "Each cycle number can only be listed once per tier." },
    ),
    defaultOverride: shippingOverrideSchema,
  })
  .refine((tier) => tier.maxSubtotal === null || tier.maxSubtotal > tier.minSubtotal, {
    message: "Maximum subtotal must be greater than minimum subtotal.",
    path: ["maxSubtotal"],
  })
  .refine((tier) => tier.productVariantIds === null || tier.productVariantIds.length > 0, {
    message: "Select at least one variant or leave product targeting disabled.",
    path: ["productVariantIds"],
  });

export const skioShippingTiersConfigSchema = z.object({
  tiers: z.array(skioShippingTierSchema).max(100),
}).refine(
  (config) => new Set(config.tiers.map((tier) => tier.id)).size === config.tiers.length,
  { message: "Tier ids must be unique.", path: ["tiers"] },
);

export type ShippingOverride = z.infer<typeof shippingOverrideSchema>;
export type CycleOverride = z.infer<typeof cycleOverrideSchema>;
export type SkioShippingTier = z.infer<typeof skioShippingTierSchema>;
export type SkioShippingTiersConfig = z.infer<typeof skioShippingTiersConfigSchema>;

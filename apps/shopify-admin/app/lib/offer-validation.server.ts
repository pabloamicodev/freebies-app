/**
 * Server-side offer validation — field-level rules used in wizard and API.
 * Returns typed validation errors so the UI can highlight specific fields.
 */

import { z } from "zod";

// ── Field schemas with descriptive error messages ────────────────────────────

export const OfferInfoSchema = z.object({
  internalName: z
    .string()
    .min(1, "Internal name is required")
    .max(100, "Internal name must be under 100 characters")
    .regex(/^[a-z0-9-_]+$/, "Internal name can only contain lowercase letters, numbers, hyphens, and underscores"),
  publicTitle: z
    .string()
    .min(1, "Public title is required")
    .max(100, "Public title must be under 100 characters"),
  priority: z
    .number({ invalid_type_error: "Priority must be a number" })
    .int("Priority must be an integer")
    .min(1, "Priority must be at least 1")
    .max(9999, "Priority must be 9999 or less"),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.startsAt && data.endsAt) {
    if (new Date(data.startsAt) >= new Date(data.endsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Start date must be before end date",
        path: ["endsAt"],
      });
    }
  }
});

export const CartValueConditionSchema = z.object({
  thresholdCents: z
    .number({ invalid_type_error: "Threshold must be a number" })
    .int()
    .positive("Cart value threshold must be greater than 0"),
  currencyCode: z.string().length(3, "Currency code must be 3 characters"),
});

export const GiftRewardSchema = z.object({
  variantGids: z
    .array(z.string().startsWith("gid://shopify/ProductVariant/", "Must be a valid variant GID"))
    .min(1, "At least one gift product is required"),
  quantity: z
    .number()
    .int()
    .min(1, "Gift quantity must be at least 1")
    .max(99, "Gift quantity must be 99 or less"),
  discountType: z.enum(["free", "percentage", "fixed_amount"]),
  discountValue: z.number().min(0).max(100),
}).superRefine((data, ctx) => {
  if (data.discountType === "percentage" && data.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Percentage discount cannot exceed 100%",
      path: ["discountValue"],
    });
  }
});

export const DiscountCodeSchema = z.object({
  code: z
    .string()
    .min(1, "Discount code is required")
    .max(255, "Discount code must be under 255 characters")
    .regex(/^\S+$/, "Discount code cannot contain spaces"),
});

export const BundleTiersSchema = z.array(
  z.object({
    minQuantity: z.number().int().positive(),
    label: z.string().min(1),
    discountValue: z.number().min(0),
  })
).superRefine((tiers, ctx) => {
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1];
    const curr = tiers[i];
    if (prev && curr && curr.minQuantity <= prev.minQuantity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Tier ${i + 1}: min quantity (${curr.minQuantity}) must be greater than tier ${i} (${prev.minQuantity})`,
        path: [i, "minQuantity"],
      });
    }
  }
});

// ── Validation result type ────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}

export function validateOfferInfo(data: unknown): ValidationResult {
  const result = OfferInfoSchema.safeParse(data);
  if (result.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: result.error.issues.map((i) => ({
      field: i.path.join("."),
      message: i.message,
    })),
  };
}

export function validateGiftReward(data: unknown): ValidationResult {
  const result = GiftRewardSchema.safeParse(data);
  if (result.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: result.error.issues.map((i) => ({
      field: i.path.join("."),
      message: i.message,
    })),
  };
}

export function validateBundleTiers(data: unknown): ValidationResult {
  const result = BundleTiersSchema.safeParse(data);
  if (result.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: result.error.issues.map((i) => ({
      field: i.path.join("."),
      message: i.message,
    })),
  };
}

/** Estimate function config size for a compiled offer. */
export function estimateConfigSizeBytes(compiledConfig: unknown): number {
  return JSON.stringify(compiledConfig).length;
}

/** Warn if config exceeds 9.5 KB (safe margin under 10 KB metafield limit). */
export function isConfigNearSizeLimit(compiledConfig: unknown): boolean {
  return estimateConfigSizeBytes(compiledConfig) > 9500;
}

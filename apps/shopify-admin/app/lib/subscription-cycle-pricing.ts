import { z } from "zod";

export const productGidSchema = z.string().trim().startsWith("gid://shopify/Product/");
export const sellingPlanIntervalSchema = z.enum(["DAY", "WEEK", "MONTH", "YEAR"]);

export const cycleDiscountValueSchema = z.object({
  type: z.enum(["percentage", "fixed_amount"]),
  value: z.number().min(0),
}).strict().superRefine((discount, ctx) => {
  if (discount.type === "percentage" && discount.value > 100) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "Percentage discount cannot exceed 100%." });
  }
});
export type CycleDiscountValue = z.infer<typeof cycleDiscountValueSchema>;

export const subscriptionCyclePricingPlanInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  intervalUnit: sellingPlanIntervalSchema,
  intervalCount: z.number().int().positive(),
  totalCycles: z.number().int().positive(),
  firstCycleDiscount: cycleDiscountValueSchema,
  recurringDiscount: cycleDiscountValueSchema,
  productIds: z.array(productGidSchema).min(1, "Choose at least one product").refine(
    (ids) => new Set(ids).size === ids.length,
    { message: "Duplicate product — each product can only be added once." },
  ),
}).strict();

export type SubscriptionCyclePricingPlanInput = z.infer<typeof subscriptionCyclePricingPlanInputSchema>;

export interface SubscriptionCyclePricingPlan extends SubscriptionCyclePricingPlanInput {
  id: string;
  sellingPlanId: string;
  productTitlesById: Record<string, string>;
}

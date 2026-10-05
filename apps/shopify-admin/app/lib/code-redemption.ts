import { PAGE_TYPES } from "@promo/shared-types";

export type CodeRedemptionMode = "checkout_code" | "automatic";

export function isCheckoutCodeGated(
  offer: { codeRedemption?: CodeRedemptionMode | null; requiresCode: boolean; requiredDiscountCode: string | null },
  hasCodes: boolean,
): boolean {
  return (
    (offer.codeRedemption ?? "checkout_code") === "checkout_code" &&
    (offer.requiresCode || hasCodes || Boolean(offer.requiredDiscountCode))
  );
}

export const AUTOMATIC_NO_ORDER_COMBINE_WARNING =
  "Combination rules are shared by every automatic offer, and this offer doesn't combine with order discounts. That would stop all automatic offers from combining with order discounts.";
export const AUTOMATIC_SITEWIDE_WARNING =
  "No page restriction: this offer applies sitewide to everyone whose cart meets its conditions.";

/** Warnings for running an offer through the shared automatic nodes; `pageTypes` is the selected set. */
export function automaticModeWarnings(opts: { combinesWithOrderDiscounts: boolean; pageTypes: readonly string[] }): string[] {
  const warnings: string[] = [];
  if (!opts.combinesWithOrderDiscounts) warnings.push(AUTOMATIC_NO_ORDER_COMBINE_WARNING);
  if (opts.pageTypes.length >= PAGE_TYPES.length) warnings.push(AUTOMATIC_SITEWIDE_WARNING);
  return warnings;
}

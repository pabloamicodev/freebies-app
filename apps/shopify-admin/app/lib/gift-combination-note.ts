/** Shown on the combination page of a gift offer that does not combine with product discounts. */
export const GIFT_NOT_COMBINING_NOTE = "If a bigger discount wins at checkout, this gift is removed from the cart.";

export const showGiftRemovalNote = (offerType: string, combinesWithProductDiscounts: boolean): boolean =>
  offerType === "gift" && !combinesWithProductDiscounts;

/** Copy and parsing for the per-cart / per-customer limits on the combination page. */

export const MAX_LIMIT = 1000;

const ORDER_LEVEL = new Set(["order_discount", "shipping_discount"]);

export interface LimitHelp {
  showPerCart: boolean;
  perCart: string;
  perCustomer: string;
}

export const PER_CUSTOMER_HELP =
  "One application = one paid order in which this offer gave a discount. Several lines or gift sets in the same order count once. Cancellations and refunds don't give a use back. Customers are recognised by their Shopify customer record, including a guest who types an email Shopify already knows.";

export const ONCE_PER_ORDER_HELP = "Applies once per order, so there is nothing to limit per cart.";

export const REQUIRE_CUSTOMER_HELP =
  "Guests who type a new email at checkout have no customer record, so without this toggle they always count as 0 uses and still get the offer. Turn it on to only offer this to identified customers.";

export function isOrderLevelOnly(rewardTypes: readonly string[]): boolean {
  return rewardTypes.length > 0 && rewardTypes.every((t) => ORDER_LEVEL.has(t));
}

export function limitHelp(offerType: string, rewardTypes: readonly string[]): LimitHelp {
  const types = new Set(rewardTypes);
  if (isOrderLevelOnly(rewardTypes)) {
    return { showPerCart: false, perCart: ONCE_PER_ORDER_HELP, perCustomer: `${PER_CUSTOMER_HELP} Leave blank for unlimited.` };
  }
  let perCart: string;
  if (offerType === "gift" || types.has("product_gift")) {
    perCart = "One application = one gift set (the full set of gifts the offer grants). Limits how many sets a single cart can receive.";
  } else if (types.has("bundle_discount") || offerType === "bundle") {
    perCart = "One application = one bundle (one full pack of the matched tier). Limits how many bundles are discounted in a single cart.";
  } else if (types.has("product_discount") || types.has("upsell_discount") || offerType === "upsell" || offerType === "discount") {
    perCart = "One application = one discounted unit. Limits how many units in a single cart receive the discount.";
  } else {
    perCart = "One application = one gift set, bundle or discounted unit, depending on the reward. It can only lower an existing cap, never raise it.";
  }
  return { showPerCart: true, perCart: `${perCart} Leave blank for unlimited.`, perCustomer: `${PER_CUSTOMER_HELP} Leave blank for unlimited.` };
}

/** undefined = blank (no limit); null = invalid; number = valid 1..MAX_LIMIT. */
export function parseLimit(raw: FormDataEntryValue | null): number | null | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "") return undefined;
  if (!/^\d+$/.test(s)) return null;
  const v = Number(s);
  return v >= 1 && v <= MAX_LIMIT ? v : null;
}

export function hasWriteCustomersScope(scope: string | null | undefined): boolean {
  return (scope ?? "").split(",").map((s) => s.trim()).includes("write_customers");
}

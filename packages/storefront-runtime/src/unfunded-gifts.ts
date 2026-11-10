import { appliedDiscountCodes, type CartData, type CartItem } from "./cart-adapter.js";
import { giftRewardKey } from "./declined-gifts.js";

const STORAGE_KEY = "promo_engine_unfunded_gifts";

/** Gift line properties to `offerId:rewardId`, or null for a non-gift line. */
export function giftKeyOfItem(item: CartItem): string | null {
  const props = item.properties ?? {};
  if (props["_promo_engine_line_type"] !== "gift") return null;
  const offerId = props["_promo_engine_offer_id"];
  const rewardId = props["_promo_engine_reward_id"];
  return offerId && rewardId ? giftRewardKey(offerId, rewardId) : null;
}

/** Reward keys whose every gift line is charged in full: Shopify's best-of picked a set without our gift discount. */
export function unfundedGiftKeys(cart: CartData): Set<string> {
  const unfunded = new Map<string, boolean>();
  for (const item of cart.items) {
    const key = giftKeyOfItem(item);
    if (!key) continue;
    const { original_line_price: orig, final_line_price: fin } = item;
    const full = typeof orig === "number" && typeof fin === "number" && orig > 0 && orig <= fin;
    unfunded.set(key, (unfunded.get(key) ?? true) && full);
  }
  return new Set([...unfunded].flatMap(([key, full]) => (full ? [key] : [])));
}

/** Paid lines + applied codes + currency + `context` (login, market); no prices, so removing our own gift leaves it unchanged. */
export function cartFingerprint(cart: CartData, context = ""): string {
  const lines = cart.items.filter((i) => !giftKeyOfItem(i)).map((i) => `${i.variant_id}x${i.quantity}`);
  return [lines.sort().join(), appliedDiscountCodes(cart).sort().join(), cart.currency, context].join("|");
}

export function loadUnfundedSuppressions(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveUnfundedSuppressions(map: Record<string, string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(map).slice(-200))));
  } catch {
    // Storage unavailable: suppression degrades to this page load.
  }
}

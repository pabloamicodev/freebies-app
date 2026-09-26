/**
 * Tracks gift rewards the customer explicitly declined (removed a gift line,
 * or dismissed the gift slider without picking) so the runtime doesn't force
 * them back into the cart. Shared between runtime.ts (detects removal, sends
 * the list to /evaluate) and the gift slider widget (records dismissal,
 * skips auto-open). Cleared per-offer once the evaluator says that offer no
 * longer qualifies.
 */

const STORAGE_KEY = "promo_engine_declined_gifts";
const MAX_TRACKED = 200;

export function giftRewardKey(offerId: string, rewardId: string): string {
  return `${offerId}:${rewardId}`;
}

export function loadDeclinedGiftRewards(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function saveDeclinedGiftRewards(rewards: Set<string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...rewards].slice(-MAX_TRACKED)));
  } catch {
    // Storage unavailable (private mode, quota) — decline tracking degrades gracefully.
  }
}

/**
 * A/B Test Assignment
 * Deterministic hash-based assignment — same session always gets same variant.
 * No randomness at request time — consistent UX for the buyer.
 */

/** Assign a buyer to an A/B variant deterministically using their session ID. */
export function assignAbVariant(
  sessionId: string,
  offerId: string,
  trafficSplitPercent: number, // 0-100, e.g. 50 = 50/50 split
): "control" | "variant" {
  // Create a deterministic hash from sessionId + offerId
  let hash = 0;
  const input = `${sessionId}:${offerId}:ab`;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  const normalized = Math.abs(hash) % 100;
  return normalized < trafficSplitPercent ? "variant" : "control";
}

/** Calculate statistical significance between two variants (two-proportion z-test). */
export function calculateSignificance(
  controlImpressions: number,
  controlConversions: number,
  variantImpressions: number,
  variantConversions: number,
): {
  controlRate: number;
  variantRate: number;
  relativeUplift: number;
  zScore: number;
  pValue: number;
  isSignificant: boolean;
  confidenceLevel: number;
} {
  if (controlImpressions === 0 || variantImpressions === 0) {
    return {
      controlRate: 0, variantRate: 0,
      relativeUplift: 0, zScore: 0, pValue: 1,
      isSignificant: false, confidenceLevel: 0,
    };
  }

  const controlRate = controlConversions / controlImpressions;
  const variantRate = variantConversions / variantImpressions;
  const relativeUplift = controlRate > 0 ? (variantRate - controlRate) / controlRate : 0;

  // Two-proportion z-test
  const pooledP = (controlConversions + variantConversions) / (controlImpressions + variantImpressions);
  const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / controlImpressions + 1 / variantImpressions));
  const zScore = se > 0 ? (variantRate - controlRate) / se : 0;

  // Approximate p-value using normal distribution
  const pValue = 2 * (1 - normalCdf(Math.abs(zScore)));

  return {
    controlRate,
    variantRate,
    relativeUplift,
    zScore,
    pValue,
    isSignificant: pValue < 0.05,
    confidenceLevel: Math.round((1 - pValue) * 100),
  };
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-0.5 * x * x);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302745))));
  return x > 0 ? 1 - p : p;
}

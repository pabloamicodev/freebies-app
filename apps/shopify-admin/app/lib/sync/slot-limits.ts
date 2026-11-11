export const SLOT_LIMITS = { slotBytes: 9500, targetFill: 0.85, maxKeys: 3, maxTags: 100, maxOffers: 100 } as const;

/** Bytes `"mergeCandidates":true` (and its comma) add to a node's config when the shop has the merge flag on. */
export const MERGE_FLAG_BYTES = ',"mergeCandidates":true'.length;

/** The planner's limits for a shop: the merge flag lives in every node's envelope, so each node has that much less room for offers. */
export function slotLimitsFor(mergeCandidates: boolean) {
  return { ...SLOT_LIMITS, envelopeExtraBytes: mergeCandidates ? MERGE_FLAG_BYTES : 0 };
}

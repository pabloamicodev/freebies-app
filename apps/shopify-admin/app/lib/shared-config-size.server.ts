import type { Db } from "@promo/db";
import { preflightCapacity } from "./capacity-preflight.server.js";

export {
  estimateSharedConfigBytes,
  sharedConfigBreakdown,
  sharedConfigTooLargeMessage,
  shippingConfigTooLargeMessage,
  type SharedConfigBreakdown,
} from "./capacity-preflight.server.js";

export interface PreflightFailure {
  error: string;
  /** Set when one offer's own data is at fault, not the shop-wide limits. */
  offerId?: string;
}

/** Thin wrapper over `preflightCapacity` for callers that only need the message. */
export async function preflightSharedConfig(
  db: Db,
  shopId: string,
  offerIds: string[],
): Promise<PreflightFailure | null> {
  const result = await preflightCapacity(db, shopId, offerIds);
  if (result.ok) return null;
  return { error: result.message, ...(result.code === "COMPILE_ERROR" ? { offerId: result.offerIds[0] } : {}) };
}

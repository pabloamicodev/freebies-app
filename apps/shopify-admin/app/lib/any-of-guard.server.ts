import { offerConditions, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { ANY_OF_CONFLICT_ERROR, hasAnyOfConflict } from "./product-condition.js";

export async function anyOfConflictError(db: Db, shopId: string, offerId: string, excludeConditionId?: string): Promise<string | null> {
  const rows = await db
    .select({ id: offerConditions.id, conditionType: offerConditions.conditionType, operator: offerConditions.operator, isEnabled: offerConditions.isEnabled })
    .from(offerConditions)
    .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));
  return hasAnyOfConflict(rows, excludeConditionId) ? ANY_OF_CONFLICT_ERROR : null;
}

import { and, eq } from "drizzle-orm";
import { discountCodes, offers, shops, type Db } from "@promo/db";
import { decryptToken } from "./token-crypto.server.js";
import { lookupCodes } from "./code-preflight.server.js";
import { removeRedeemCodes } from "./discount-node.server.js";
import { CODE_TAKEN_MESSAGE, DISCOUNT_CODE_INDEX } from "./discount-codes.server.js";
import { isConstraintViolation } from "./unique-offer-name.server.js";

/**
 * One-click "use the original code again" after a collision. Only proceeds when
 * the original code is free in Shopify now (or already ours); the suffixed variant
 * is taken off the offer's node and the original is attached by the next publish.
 * Never touches the merchant's own discount.
 */
export async function retryOriginalCode(
  db: Db,
  shopId: string,
  shopDomain: string,
  codeId: string,
  lookup: typeof lookupCodes = lookupCodes,
  remove: typeof removeRedeemCodes = removeRedeemCodes,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const [row] = await db
    .select()
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.id, codeId)))
    .limit(1);
  if (!row?.requestedCode) return { ok: false, error: "That code has no original to restore." };
  const [offer] = await db
    .select({ codeDiscountId: offers.codeDiscountId })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, row.offerId)))
    .limit(1);
  const [shop] = await db
    .select({ accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!shop) return { ok: false, error: "Shop not found." };
  const accessToken = await decryptToken(shop.accessTokenEncrypted);

  const availability = (await lookup(shopDomain, accessToken, [row.requestedCode], offer?.codeDiscountId ?? null)).get(
    row.requestedCode,
  );
  if (availability?.status === "taken") {
    const title = availability.title ? ` (discount "${availability.title}")` : "";
    return {
      ok: false,
      error: `${row.requestedCode} still exists in Shopify${title}. Rename or delete that discount in Shopify, then try again.`,
    };
  }
  if (row.shopifySyncedAt && offer?.codeDiscountId) {
    await remove(shopDomain, accessToken, offer.codeDiscountId, [row.code]);
  }
  try {
    await db
      .update(discountCodes)
      .set({
        code: row.requestedCode,
        requestedCode: null,
        collisionNote: null,
        shopifySyncedAt: availability?.status === "ours" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.id, codeId)));
  } catch (err) {
    if (isConstraintViolation(err, DISCOUNT_CODE_INDEX)) return { ok: false, error: CODE_TAKEN_MESSAGE };
    throw err;
  }
  return { ok: true, code: row.requestedCode };
}

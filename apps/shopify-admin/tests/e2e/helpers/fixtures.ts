/**
 * Fixture probe: proves the offers the storefront specs depend on are live on
 * hpn-test-store before any spec runs. Fails with the exact repair command.
 */

import type { Page } from "@playwright/test";
import {
  addLines,
  clearCart,
  gotoStorefront,
  storefrontFetch,
  waitForPromoEngine,
} from "./storefront.js";
import { evaluateNow } from "./widgets.js";
import { E2E_GIFT_ANCHOR_HANDLE } from "../fixtures/live-offers.js";

const REPAIR =
  "Seed them with `pnpm seed:ambrosia-e2e` (needs DATABASE_URL and TOKEN_ENCRYPTION_KEY, " +
  "target hpn-test-store only) and confirm with `pnpm verify:ambrosia-e2e`. In GitHub Actions the " +
  "e2e-live workflow does this when the E2E_DATABASE_URL and E2E_TOKEN_ENCRYPTION_KEY secrets exist.";

export async function firstVariantId(page: Page, handle: string): Promise<number> {
  const product = await storefrontFetch<{ variants: Array<{ id: number }> }>(
    page,
    `/products/${encodeURIComponent(handle)}.js`,
  );
  const id = product.variants[0]?.id;
  if (!id) throw new Error(`Product ${handle} has no variants on the storefront.`);
  return id;
}

export async function assertFixtures(page: Page): Promise<void> {
  await gotoStorefront(page, `/products/${encodeURIComponent(E2E_GIFT_ANCHOR_HANDLE)}`);
  await waitForPromoEngine(page);
  await clearCart(page);

  const anchor = await firstVariantId(page, E2E_GIFT_ANCHOR_HANDLE);
  await addLines(page, [{ id: anchor, quantity: 1 }]);
  const result = await evaluateNow(page);
  const giftQualified = result.qualifiedOffers.some((offer) => offer.type === "gift" && offer.qualified);
  await clearCart(page);
  if (!giftQualified) {
    throw new Error(
      `Fixture "E2E Gift Offer" is not live: adding ${E2E_GIFT_ANCHOR_HANDLE} qualified no gift offer on the storefront. ${REPAIR}`,
    );
  }

  const ambrosiaAnchor = await firstVariantId(page, process.env["E2E_PRODUCT_HANDLE"] ?? "test-product");
  await addLines(page, [{ id: ambrosiaAnchor, quantity: 1 }]);
  const subtotal = await evaluateNow(page);
  await clearCart(page);
  if (!subtotal.giftSlider) {
    throw new Error(
      `Fixture "[Ambrosia E2E] cart-subtotal-free-gift" is not live: the $85 subtotal gift slider did not open. ${REPAIR}`,
    );
  }
}

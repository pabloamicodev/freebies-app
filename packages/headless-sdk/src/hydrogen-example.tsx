/**
 * Hydrogen / Headless Integration Example
 * Shows how to use @promo/headless-sdk in a Shopify Hydrogen storefront.
 *
 * Place this in your Hydrogen project root and configure the client.
 * The hooks work with any React 18+ headless storefront.
 *
 * @example
 * // app/root.tsx
 * import { PromoProvider } from './promo-provider';
 * export default function Root() {
 *   return <PromoProvider><Outlet /></PromoProvider>;
 * }
 *
 * // In your cart page or cart drawer:
 * import { usePromoOffers } from '@promo/headless-sdk/react';
 */

// @ts-nocheck — This file is documentation/example only, not compiled directly

import { createPromoClient } from "./client.js";
import { usePromoOffers, usePromoTrack } from "./react/hooks.js";
import { useEffect } from "react";

// ─── 1. Create the client (once per app) ─────────────────────────────────────

export const promoClient = createPromoClient({
  storeDomain: "your-store.myshopify.com",
  publicKey: "your-public-key-from-shopify-admin",
  locale: "en",
});

// ─── 2. Use in cart page ─────────────────────────────────────────────────────

interface CartLine {
  id: string;
  merchandise: { id: string; product: { id: string } };
  quantity: number;
  cost: { amountPerQuantity: { amount: string } };
}

interface Cart {
  id: string;
  lines: { nodes: CartLine[] };
  cost: { subtotalAmount: { currencyCode: string } };
}

export function CartWithPromo({ cart }: { cart: Cart }) {
  const cartForPromo = {
    id: cart.id,
    lines: cart.lines.nodes.map((line) => ({
      variantId: line.merchandise.id,
      productId: line.merchandise.product.id,
      quantity: line.quantity,
      price: parseFloat(line.cost.amountPerQuantity.amount),
    })),
    currencyCode: cart.cost.subtotalAmount.currencyCode,
  };

  const { data } = usePromoOffers({
    client: promoClient,
    cart: cartForPromo,
    debounceMs: 300,
  });

  const track = usePromoTrack(promoClient);

  // Show progress bar
  const progressBar = data?.progressBars[0];
  // Show cart messages
  const messages = data?.cartMessages ?? [];
  // Handle gift slider
  const giftSlider = data?.giftSlider;

  // Auto-apply cart actions (add gifts, remove invalid gifts)
  useEffect(() => {
    if (!data?.cartActions.length) return;
    // In headless, you manage cart via Shopify Storefront API
    // Use the StorefrontApiAdapter from @promo/storefront-runtime
    for (const action of data.cartActions) {
      if (action.action === "add_line") {
        track("promo_engine:gift_auto_added", {
          variant_id: action.variantId,
          offer_id: action.properties?._promo_engine_offer_id,
        });
        // cartLinesAdd(action.variantId, action.quantity, action.properties)
      }
    }
  }, [data?.cartActions]);

  return (
    <div>
      {/* Cart lines rendered here */}

      {/* Progress Bar */}
      {progressBar && (
        <div className="promo-progress">
          <div style={{ width: `${progressBar.progressPercent}%`, background: "#111", height: 4 }} />
          <p>{progressBar.isGoalReached ? progressBar.messageAfterGoal : progressBar.messageBeforeGoal}</p>
        </div>
      )}

      {/* Cart Messages */}
      {messages.map((msg) => (
        <div key={msg.offerId} className={`promo-message promo-message--${msg.type}`}>
          {msg.message}
        </div>
      ))}

      {/* Gift Slider */}
      {giftSlider && (
        <GiftSliderModal payload={giftSlider} onClose={() => {}} />
      )}
    </div>
  );
}

interface GiftSliderPayload {
  title: string;
  selectableGifts: Array<{
    variantId: string;
    imageUrl?: string | null;
    title: string;
    discountedPriceCents: number;
  }>;
}

function GiftSliderModal({ payload, onClose }: { payload: GiftSliderPayload; onClose: () => void }) {
  return (
    <div className="promo-gift-slider">
      <h2>{payload.title}</h2>
      {payload.selectableGifts.map((gift) => (
        <div key={gift.variantId}>
          {gift.imageUrl && <img src={gift.imageUrl} alt={gift.title} width={80} height={80} />}
          <p>{gift.title}</p>
          <p>{gift.discountedPriceCents === 0 ? "Free" : `$${(gift.discountedPriceCents / 100).toFixed(2)}`}</p>
          <button>Select</button>
        </div>
      ))}
      <button onClick={onClose}>Close</button>
    </div>
  );
}

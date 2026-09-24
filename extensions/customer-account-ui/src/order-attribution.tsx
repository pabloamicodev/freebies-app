/**
 * Customer Account UI Extension — Order Attribution Display.
 */

import "@shopify/ui-extensions/preact";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Required by the classic Preact JSX transform.
import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useApi,
  useOrder,
} from "@shopify/ui-extensions/customer-account/preact";

interface OfferAttribution {
  offerId: string;
  offerName: string;
  offerType: string;
  savedCents: number;
  currencyCode: string;
  giftProductTitle?: string;
}

interface AttributionResponse {
  attributions: OfferAttribution[];
}

export default function extension() {
  render(<OrderAttribution />, document.body);
}

function OrderAttribution() {
  const api = useApi<"customer-account.order-status.block.render">();
  const order = useOrder();
  const [attributions, setAttributions] = useState<OfferAttribution[]>([]);
  const [loading, setLoading] = useState(true);

  const orderId = order?.id;
  const shopDomain = api.shop.myshopifyDomain;

  useEffect(() => {
    if (!orderId || !shopDomain) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    fetch(
      `https://${shopDomain}/apps/promo-engine/customer/order-attribution?order_gid=${encodeURIComponent(orderId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Attribution failed: ${response.status}`);
        return response.json() as Promise<AttributionResponse>;
      })
      .then((data) => setAttributions(data.attributions ?? []))
      .catch(() => setAttributions([]))
      .finally(() => {
        clearTimeout(timeout);
        setLoading(false);
      });

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [orderId, shopDomain]);

  if (loading || attributions.length === 0) return null;

  const totalSavedCents = attributions.reduce(
    (sum, attribution) => sum + attribution.savedCents,
    0,
  );
  const currencyCode = attributions[0]?.currencyCode ?? "USD";
  const formatMoney = (cents: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(cents / 100);

  return (
    <s-section heading="Promotions applied">
      <s-stack direction="block" gap="base">
        {totalSavedCents > 0 ? (
          <s-text tone="success">
            You saved {formatMoney(totalSavedCents)} with promotions on this order.
          </s-text>
        ) : null}
        {attributions.map((attribution) => (
          <s-stack key={attribution.offerId} direction="inline" gap="base" alignItems="center">
            <s-badge tone="neutral">{attribution.offerType}</s-badge>
            <s-text>{attribution.offerName}</s-text>
            {attribution.savedCents > 0 ? (
              <s-text tone="success">-{formatMoney(attribution.savedCents)}</s-text>
            ) : null}
            {attribution.giftProductTitle ? (
              <s-text type="small">+ {attribution.giftProductTitle} (free gift)</s-text>
            ) : null}
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}

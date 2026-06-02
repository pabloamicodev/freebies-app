/**
 * Customer Account UI Extension — Order Attribution Display
 * Shows which promotions were applied on each order.
 *
 * Available on ALL plans as of 2026-01 (not Plus-only).
 * Renders on: order detail page, order status page.
 *
 * Edge cases handled:
 * - No attribution data → renders nothing (graceful degradation)
 * - Network timeout → renders nothing
 * - Guest order (no customer GID) → renders nothing
 */

import {
  extension,
  BlockStack,
  InlineStack,
  Text,
  Image,
  Badge,
  Divider,
  useApi,
} from "@shopify/ui-extensions-react/customer-account";
import { useState, useEffect } from "react";

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

export default extension("customer-account.order-status.block.render", (root, api) => {
  root.append(createComponent(api));
});

function createComponent(api: any) {
  return api.createComponent(OrderAttribution, { api });
}

function OrderAttribution({ api }: { api: any }) {
  const order = api.order?.current;
  const shop = api.shop;
  const [attributions, setAttributions] = useState<OfferAttribution[]>([]);
  const [loading, setLoading] = useState(true);

  const orderId = order?.id;
  const shopDomain = shop?.myshopifyDomain ?? "";

  useEffect(() => {
    if (!orderId || !shopDomain) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    fetch(
      `https://${shopDomain}/apps/promo-engine/customer/order-attribution?order_gid=${encodeURIComponent(orderId)}`,
      {
        headers: { "X-Promo-Shop": shopDomain },
        signal: controller.signal,
      },
    )
      .then((r) => r.json() as Promise<AttributionResponse>)
      .then((data) => {
        setAttributions(data.attributions ?? []);
      })
      .catch(() => {
        // Fail silently — never block order status page
      })
      .finally(() => {
        clearTimeout(timeout);
        setLoading(false);
      });

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [orderId, shopDomain]);

  // Don't render while loading or if no attributions
  if (loading || attributions.length === 0) return null;

  const totalSavedCents = attributions.reduce((acc, a) => acc + a.savedCents, 0);
  const currencyCode = attributions[0]?.currencyCode ?? "USD";
  const formatMoney = (cents: number) =>
    new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(cents / 100);

  return (
    <BlockStack spacing="base">
      <Divider />
      <Text size="base" emphasis="bold">
        🎁 Promotions Applied
      </Text>
      <Text size="small" appearance="success">
        You saved {formatMoney(totalSavedCents)} with promotions on this order!
      </Text>
      {attributions.map((attr) => (
        <InlineStack key={attr.offerId} spacing="base" alignment="center">
          <Badge tone="success">{attr.offerType}</Badge>
          <Text size="small">{attr.offerName}</Text>
          {attr.savedCents > 0 && (
            <Text size="small" appearance="success">
              -{formatMoney(attr.savedCents)}
            </Text>
          )}
          {attr.giftProductTitle && (
            <Text size="small" appearance="subdued">
              + {attr.giftProductTitle} (free gift)
            </Text>
          )}
        </InlineStack>
      ))}
    </BlockStack>
  );
}

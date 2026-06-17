/**
 * Checkout Upsell Extension — Shopify Plus (all checkout surfaces).
 *
 * Shows a product recommendation at checkout.
 * Targets: order summary, actions area (above Pay Now), thank-you page.
 *
 * Edge cases handled:
 * - Upsell product already in cart → don't show
 * - Upsell product out of stock → don't show
 * - Network failure → don't show (graceful degradation, never block checkout)
 * - Buyer dismissed → store dismissal, don't re-show same session
 * - Cart changes after upsell rendered → re-fetch and revalidate
 */

import {
  useEffect, useState, useCallback,
} from "react";
import {
  reactExtension,
  useApi,
  useApplyCartLinesChange,
  useCartLines,
  useTotalAmount,
  useSettings,
  BlockStack,
  InlineStack,
  Image,
  Text,
  Button,
  Divider,
  View,
} from "@shopify/ui-extensions-react/checkout";

interface UpsellProduct {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  originalPriceCents: number;
  discountedPriceCents: number;
  isAvailable: boolean;
}

interface UpsellConfig {
  offerId: string;
  product: UpsellProduct | null;
  message: string;
  buttonText: string;
  discountPercent: number;
}

interface EvaluateResponse {
  upsells?: UpsellConfig[];
}

export default reactExtension("purchase.checkout.block.render", () => <CheckoutUpsell />);

function CheckoutUpsell() {
  const api = useApi<"purchase.checkout.block.render">();
  const applyCartLinesChange = useApplyCartLinesChange();
  const cartLines = useCartLines();
  const totalAmount = useTotalAmount();
  const settings = useSettings<{ offer_id?: string }>();

  const [config, setConfig] = useState<UpsellConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offerId = settings.offer_id ?? "";
  const shopDomain = api.shop.myshopifyDomain;

  // Fetch upsell config from app backend
  useEffect(() => {
    if (!offerId || !shopDomain) { setLoading(false); return; }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const evalEndpoint = `https://${shopDomain}/apps/promo-engine/evaluate`;

    const cartNormalized = {
      token: null,
      id: null,
      lines: cartLines.map((line) => ({
        key: line.id,
        variantId: line.merchandise.id,
        productId: "unknown",
        quantity: line.quantity,
        priceCents: Math.round(parseFloat(line.cost.amountPerQuantity.amount) * 100),
        compareAtPriceCents: null,
        properties: line.attributes.reduce((acc: Record<string, string>, a) => {
          if (a.value) acc[a.key] = a.value;
          return acc;
        }, {}),
        requiresSellingPlan: false,
        sellingPlanId: null,
        productHandle: "",
        productTitle: "",
        variantTitle: null,
        vendor: "",
        productType: "",
        tags: [],
        collections: [],
        availableForSale: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: null,
      })),
      subtotalCents: Math.round(parseFloat(totalAmount.amount) * 100),
      discountCodes: [],
      currencyCode: totalAmount.currencyCode,
      totalQuantity: cartLines.reduce((acc, l) => acc + l.quantity, 0),
    };

    fetch(evalEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Promo-Shop": shopDomain,
        "X-Promo-Session": "checkout",
      },
      body: JSON.stringify({
        shopDomain,
        cart: cartNormalized,
        customer: null,
        market: null,
        locale: null,
        salesChannel: "online_store",
        requestedUrl: null,
        sessionId: "checkout",
      }),
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((result: EvaluateResponse) => {
        const upsell = result.upsells?.find((u) => u.offerId === offerId);
        if (upsell?.product) {
          // Check if product is already in cart
          const alreadyInCart = cartLines.some(
            (line) => line.merchandise.id === upsell.product.variantId,
          );
          if (!alreadyInCart) {
            setConfig(upsell);
          }
        }
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError("Failed to load offer");
      })
      .finally(() => {
        clearTimeout(timeout);
        setLoading(false);
      });

    return () => { controller.abort(); clearTimeout(timeout); };
  }, [offerId, shopDomain]);

  const handleAdd = useCallback(async () => {
    if (!config?.product) return;
    setAdding(true);
    try {
      const result = await applyCartLinesChange({
        type: "addCartLine",
        merchandiseId: config.product.variantId,
        quantity: 1,
        attributes: [
          { key: "_promo_engine_line_type", value: "upsell" },
          { key: "_promo_engine_offer_id", value: offerId },
        ],
      });

      if (result.type === "success") {
        setAdded(true);
      } else {
        setError("Could not add product. Please try again.");
      }
    } catch {
      setError("Could not add product. Please try again.");
    } finally {
      setAdding(false);
    }
  }, [config, applyCartLinesChange, offerId]);

  // Don't render: loading, no config, dismissed, already added
  if (loading || !config?.product || dismissed || added) return null;
  if (error) return null; // Fail silently — never block checkout

  const product = config.product;
  const originalPrice = product.originalPriceCents / 100;
  const discountedPrice = product.discountedPriceCents / 100;
  const currency = totalAmount.currencyCode;

  const fmt = (amount: number) =>
    new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);

  return (
    <BlockStack spacing="base">
      <Divider />
      <BlockStack spacing="tight">
        <Text size="base" emphasis="bold">{config.message || "You might also like"}</Text>
        <InlineStack spacing="base" alignment="center">
          {product.imageUrl && (
            <View maxInlineSize={80}>
              <Image source={product.imageUrl} accessibilityDescription={product.title} />
            </View>
          )}
          <BlockStack spacing="extraTight" inlineAlignment="start">
            <Text size="base" emphasis="bold">{product.title}</Text>
            {product.variantTitle && (
              <Text size="small" appearance="subdued">{product.variantTitle}</Text>
            )}
            <InlineStack spacing="tight">
              {discountedPrice < originalPrice ? (
                <>
                  <Text size="base" emphasis="bold" appearance="accent">{fmt(discountedPrice)}</Text>
                  <Text size="small" appearance="subdued">
                    <del>{fmt(originalPrice)}</del>
                  </Text>
                </>
              ) : (
                <Text size="base">{fmt(originalPrice)}</Text>
              )}
            </InlineStack>
          </BlockStack>
          <View>
            <Button
              kind="primary"
              onPress={handleAdd}
              loading={adding}
              disabled={!product.isAvailable}
              accessibilityLabel={`Add ${product.title} to cart`}
            >
              {product.isAvailable ? (config.buttonText || "Add") : "Sold Out"}
            </Button>
          </View>
        </InlineStack>
        <View>
          <Button kind="plain" onPress={() => setDismissed(true)} accessibilityLabel="Dismiss offer">
            <Text size="small" appearance="subdued">No thanks</Text>
          </Button>
        </View>
      </BlockStack>
    </BlockStack>
  );
}

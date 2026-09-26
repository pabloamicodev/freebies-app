/**
 * Checkout Upsell Extension — Shopify API 2026-07.
 */

import "@shopify/ui-extensions/preact";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Required by the classic Preact JSX transform.
import { h, render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import {
  useApi,
  useApplyCartLinesChange,
  useCartLines,
  useSettings,
  useTotalAmount,
  useTranslate,
} from "@shopify/ui-extensions/checkout/preact";
import { APP_URL } from "./app-url.js";

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

export default function extension() {
  render(<CheckoutUpsell />, document.body);
}

function CheckoutUpsell() {
  const api = useApi();
  const applyCartLinesChange = useApplyCartLinesChange();
  const cartLines = useCartLines();
  const totalAmount = useTotalAmount();
  const settings = useSettings<{ offer_id?: string }>();
  const translate = useTranslate();

  const [config, setConfig] = useState<UpsellConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [addError, setAddError] = useState(false);

  const offerId = typeof settings.offer_id === "string" ? settings.offer_id : "";
  const shopDomain = api.shop.myshopifyDomain;
  const cartFingerprint = useMemo(
    () => cartLines.map((line) => `${line.id}:${line.quantity}`).join("|"),
    [cartLines],
  );

  useEffect(() => {
    setConfig(null);
    setLoading(true);
    if (!offerId || !shopDomain) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const cartNormalized = {
      token: null,
      id: null,
      lines: cartLines.map((line) => ({
        key: line.id,
        variantId: line.merchandise.id,
        productId: line.merchandise.product.id,
        quantity: line.quantity,
        priceCents: Math.round((line.cost.totalAmount.amount / Math.max(line.quantity, 1)) * 100),
        compareAtPriceCents: null,
        properties: Object.fromEntries(
          line.attributes.flatMap((attribute) =>
            attribute.value ? [[attribute.key, attribute.value]] : [],
          ),
        ),
        requiresSellingPlan: Boolean(line.merchandise.sellingPlan),
        sellingPlanId: line.merchandise.sellingPlan?.id ?? null,
        productHandle: "",
        productTitle: line.merchandise.title,
        variantTitle: line.merchandise.title,
        vendor: line.merchandise.product.vendor,
        productType: line.merchandise.product.productType,
        tags: [] as string[],
        collections: [] as string[],
        availableForSale: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: null,
      })),
      subtotalCents: Math.round(totalAmount.amount * 100),
      discountCodes: [] as string[],
      currencyCode: totalAmount.currencyCode,
      totalQuantity: cartLines.reduce((sum, line) => sum + line.quantity, 0),
    };

    api.sessionToken.get()
      .then((token) => fetch(`${APP_URL}/api/checkout/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
      }))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Evaluation failed: ${response.status}`);
        return response.json() as Promise<EvaluateResponse>;
      })
      .then((result) => {
        const upsell = result.upsells?.find((candidate) => candidate.offerId === offerId);
        if (
          upsell?.product?.isAvailable &&
          !cartLines.some((line) => line.merchandise.id === upsell.product?.variantId)
        ) {
          setConfig(upsell);
        }
      })
      .catch(() => {
        setConfig(null);
      })
      .finally(() => {
        clearTimeout(timeout);
        setLoading(false);
      });

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [offerId, shopDomain, cartFingerprint, totalAmount.amount, totalAmount.currencyCode]);

  const handleAdd = useCallback(async () => {
    if (!config?.product) return;
    setAdding(true);
    setAddError(false);
    const metadata = JSON.stringify({
      _promo_engine_line_type: "upsell",
      _promo_engine_offer_id: offerId,
    });
    try {
      const result = await applyCartLinesChange({
        type: "addCartLine",
        merchandiseId: config.product.variantId,
        quantity: 1,
        attributes: [
          { key: "_promo_engine_metadata", value: metadata },
          { key: "_promo_engine_line_type", value: "upsell" },
          { key: "_promo_engine_offer_id", value: offerId },
        ],
      });
      if (result.type === "success") {
        setAdded(true);
      } else {
        setAddError(true);
      }
    } finally {
      setAdding(false);
    }
  }, [applyCartLinesChange, config, offerId]);

  if (loading || !config?.product || dismissed || added) return null;

  const product = config.product;
  const originalPrice = product.originalPriceCents / 100;
  const discountedPrice = product.discountedPriceCents / 100;
  const formatMoney = (amount: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: totalAmount.currencyCode,
    }).format(amount);

  return (
    <s-section heading={config.message || translate("upsell.heading")}>
      <s-stack direction="block" gap="base">
        <s-divider />
        <s-stack direction="inline" gap="base" alignItems="center">
          {product.imageUrl ? (
            <s-product-thumbnail
              src={product.imageUrl}
              alt={product.title}
              size="small"
            />
          ) : null}
          <s-stack direction="block" gap="small">
            <s-text type="strong">{product.title}</s-text>
            {product.variantTitle ? <s-text type="small">{product.variantTitle}</s-text> : null}
            <s-stack direction="inline" gap="small">
              <s-text type="strong" tone={discountedPrice < originalPrice ? "success" : "auto"}>
                {formatMoney(discountedPrice < originalPrice ? discountedPrice : originalPrice)}
              </s-text>
              {discountedPrice < originalPrice ? (
                <s-text type="redundant">{formatMoney(originalPrice)}</s-text>
              ) : null}
            </s-stack>
          </s-stack>
          <s-button
            variant="primary"
            onClick={handleAdd}
            loading={adding}
            disabled={!product.isAvailable}
            accessibilityLabel={translate("upsell.addAccessibilityLabel", { title: product.title })}
          >
            {product.isAvailable ? config.buttonText || translate("upsell.add") : translate("upsell.soldOut")}
          </s-button>
        </s-stack>
        {addError ? (
          <s-text tone="critical">{translate("upsell.addError")}</s-text>
        ) : null}
        <s-button
          variant="secondary"
          onClick={() => setDismissed(true)}
          accessibilityLabel={translate("upsell.dismissAccessibilityLabel")}
        >
          {translate("upsell.noThanks")}
        </s-button>
      </s-stack>
    </s-section>
  );
}

/** @jsxImportSource preact */
import { useState, useEffect } from "preact/hooks";
import { h } from "preact";
import { render } from "preact";
import { AjaxCartAdapter } from "../cart-adapter.js";
import { emit, PromoEvents, publishAnalytics } from "../event-bus.js";

interface FbtProduct {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  handle: string;
  imageUrl: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  discountedPriceCents: number;
  isAvailable: boolean;
}

interface FbtConfig {
  offerId: string;
  mainProduct: FbtProduct;
  relatedProducts: FbtProduct[];
  title: string;
  buttonText: string;
  discountPercent: number;
  maxProducts: number;
  layout: "amazon" | "stacked";
}

const STYLES = `
.pe-fbt { font-family: inherit; margin: 24px 0; }
.pe-fbt-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
.pe-fbt-products {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
}
.pe-fbt-product {
  display: flex; align-items: center; gap: 8px;
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 10px;
  cursor: pointer; transition: border-color .15s; min-width: 140px;
}
.pe-fbt-product.pe-selected { border-color: #111; background: #f9f9f9; }
.pe-fbt-product:hover { border-color: #9ca3af; }
.pe-fbt-check { width: 18px; height: 18px; flex-shrink: 0; }
.pe-fbt-img { width: 52px; height: 52px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.pe-fbt-img-ph { width: 52px; height: 52px; background: #f3f4f6; border-radius: 4px; flex-shrink: 0; }
.pe-fbt-info { min-width: 0; }
.pe-fbt-name { font-size: 12px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
.pe-fbt-price { font-size: 12px; color: #6b7280; }
.pe-fbt-price-disc { color: #059669; font-weight: 700; }
.pe-fbt-plus { font-size: 20px; color: #9ca3af; flex-shrink: 0; }
.pe-fbt-summary {
  margin-top: 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
}
.pe-fbt-total { font-size: 15px; }
.pe-fbt-total strong { font-size: 18px; }
.pe-fbt-btn {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; font-size: 14px; font-weight: 700; cursor: pointer;
  transition: background .15s;
}
.pe-fbt-btn:hover { background: #333; }
.pe-fbt-btn:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-fbt-added { color: #059669; font-weight: 600; font-size: 14px; }
`;

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat(navigator.language, { style: "currency", currency }).format(
    cents / 100,
  );
}

function FbtWidget({
  config,
  currency,
  sessionId,
}: {
  config: FbtConfig;
  currency: string;
  sessionId: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set([config.mainProduct.variantId, ...config.relatedProducts.slice(0, 2).map((p) => p.variantId)]),
  );
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const allProducts = [config.mainProduct, ...config.relatedProducts.slice(0, config.maxProducts - 1)];
  const selectedProducts = allProducts.filter((p) => selected.has(p.variantId));

  const totalCents = selectedProducts.reduce((acc, p) => acc + p.discountedPriceCents, 0);
  const originalCents = selectedProducts.reduce((acc, p) => acc + p.priceCents, 0);
  const savings = originalCents - totalCents;

  function toggle(variantId: string) {
    if (variantId === config.mainProduct.variantId) return; // Main product always included
    const next = new Set(selected);
    next.has(variantId) ? next.delete(variantId) : next.add(variantId);
    setSelected(next);
  }

  async function handleAddAll() {
    if (adding || selectedProducts.length === 0) return;
    setAdding(true);
    try {
      await AjaxCartAdapter.addLines(
        selectedProducts.map((p) => ({
          variantId: p.variantId,
          quantity: 1,
          properties: {
            _promo_engine_line_type: "upsell",
            _promo_engine_offer_id: config.offerId,
          },
        })),
      );
      setAdded(true);
      emit(PromoEvents.CartChanged);
      publishAnalytics("promo_engine:bundle_added_to_cart", {
        offer_id: config.offerId,
        widget_type: "fbt",
        variant_ids: [...selected],
        session_id: sessionId,
      });
    } finally {
      setAdding(false);
    }
  }

  useEffect(() => {
    publishAnalytics("promo_engine:widget_viewed", {
      offer_id: config.offerId,
      widget_type: "fbt",
      session_id: sessionId,
    });
  }, []);

  if (added) {
    return (
      <div class="pe-fbt">
        <p class="pe-fbt-added">✓ Added {selectedProducts.length} item(s) to cart!</p>
      </div>
    );
  }

  return (
    <div class="pe-fbt">
      <h3 class="pe-fbt-title">{config.title || "Frequently Bought Together"}</h3>
      <div class="pe-fbt-products">
        {allProducts.map((product, idx) => {
          const isSelected = selected.has(product.variantId);
          const isMain = product.variantId === config.mainProduct.variantId;
          return (
            <>
              {idx > 0 && <span class="pe-fbt-plus" aria-hidden="true">+</span>}
              <div
                key={product.variantId}
                class={`pe-fbt-product${isSelected ? " pe-selected" : ""}`}
                onClick={() => toggle(product.variantId)}
                role="checkbox"
                aria-checked={isSelected}
                tabIndex={isMain ? -1 : 0}
                onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(product.variantId); } }}
              >
                <input
                  type="checkbox"
                  class="pe-fbt-check"
                  checked={isSelected}
                  disabled={isMain}
                  aria-hidden="true"
                  tabIndex={-1}
                  readOnly
                />
                {product.imageUrl ? (
                  <img class="pe-fbt-img" src={product.imageUrl} alt={product.title} loading="lazy" />
                ) : (
                  <div class="pe-fbt-img-ph" aria-hidden="true" />
                )}
                <div class="pe-fbt-info">
                  <p class="pe-fbt-name">{product.title}</p>
                  {product.variantTitle && <p class="pe-fbt-price">{product.variantTitle}</p>}
                  <p class="pe-fbt-price">
                    {product.discountedPriceCents < product.priceCents ? (
                      <span class="pe-fbt-price-disc">{formatPrice(product.discountedPriceCents, currency)}</span>
                    ) : (
                      formatPrice(product.priceCents, currency)
                    )}
                  </p>
                </div>
              </div>
            </>
          );
        })}
      </div>

      <div class="pe-fbt-summary">
        <p class="pe-fbt-total">
          Total: <strong>{formatPrice(totalCents, currency)}</strong>
          {savings > 0 && (
            <> <span class="pe-fbt-price-disc">(save {formatPrice(savings, currency)})</span></>
          )}
        </p>
        <button
          class="pe-fbt-btn"
          onClick={handleAddAll}
          disabled={adding || selectedProducts.length === 0}
          aria-label={`Add ${selectedProducts.length} item(s) to cart for ${formatPrice(totalCents, currency)}`}
        >
          {adding ? "Adding…" : (config.buttonText || `Add ${selectedProducts.length} to Cart`)}
        </button>
      </div>
    </div>
  );
}

/** Mount the FBT widget on the product page. */
export function initFbtWidget(
  container: HTMLElement,
  config: FbtConfig,
  currency: string,
  sessionId: string,
) {
  if (!document.getElementById("pe-fbt-styles")) {
    const style = document.createElement("style");
    style.id = "pe-fbt-styles";
    style.textContent = STYLES;
    document.head.appendChild(style);
  }
  render(h(FbtWidget, { config, currency, sessionId }), container);
}

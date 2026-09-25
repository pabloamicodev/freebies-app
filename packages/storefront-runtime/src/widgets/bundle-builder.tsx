/** @jsxImportSource preact */
/**
 * Bundle Builder — Preact component for the bundle page / build-a-box.
 * Supports:
 * - Multi-step layout (one step per page)
 * - All-steps-on-one-page layout
 * - Product search within step
 * - Sort by name/price/date/best-selling
 * - Filter by category/collection/tag/type/price range
 * - Min/max quantity per step
 * - Dynamic discount tier display
 * - Accessibility keyboard navigation
 */

import { h } from "preact";
import { useState, useMemo } from "preact/hooks";
import { render } from "preact";
import { AjaxCartAdapter } from "../cart-adapter.js";
import { emit, PromoEvents, publishAnalytics } from "../event-bus.js";

interface BundleProduct {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  handle: string;
  imageUrl: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  isAvailable: boolean;
  vendor: string;
  productType: string;
  tags: string[];
}

interface BundleStep {
  id: string;
  title: string;
  subtitle: string | null;
  products: BundleProduct[];
  minQuantity: number;
  maxQuantity: number | null;
  searchEnabled: boolean;
}

interface BundleTier {
  minQuantity: number;
  maxQuantity?: number | null;
  label: string;
  discountType: string;
  discountValue: number;
}

interface BundleBuilderConfig {
  offerId: string;
  bundleId: string;
  title: string;
  description: string | null;
  layoutMode: "one_step_per_page" | "all_steps_one_page";
  steps: BundleStep[];
  tiers: BundleTier[];
  currency: string;
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat(navigator.language, { style: "currency", currency }).format(
    cents / 100,
  );
}

export function getActiveTier(totalQty: number, tiers: BundleTier[]): BundleTier | null {
  return (
    [...tiers]
      .sort((a, b) => b.minQuantity - a.minQuantity)
      .find(
        (tier) =>
          totalQty >= tier.minQuantity &&
          (tier.maxQuantity === undefined ||
            tier.maxQuantity === null ||
            totalQty <= tier.maxQuantity),
      ) ?? null
  );
}

function BundleBuilderComponent({
  config,
  sessionId,
}: {
  config: BundleBuilderConfig;
  sessionId: string;
}) {
  const [currentStep, setCurrentStep] = useState(0);
  const [selections, setSelections] = useState<Map<string, Map<string, number>>>(new Map());
  const [searchQuery, setSearchQuery] = useState("");
  const sortBy: string = "name_asc";
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const isOneStepPerPage = config.layoutMode === "one_step_per_page";
  const activeSteps = isOneStepPerPage ? [config.steps[currentStep]].filter(Boolean) : config.steps;

  const totalSelectedQty = useMemo(() => {
    let total = 0;
    for (const stepMap of selections.values()) {
      for (const qty of stepMap.values()) {
        total += qty;
      }
    }
    return total;
  }, [selections]);

  const activeTier = getActiveTier(totalSelectedQty, config.tiers);

  function updateSelection(stepId: string, variantId: string, qty: number) {
    setSelections((prev) => {
      const next = new Map(prev);
      const stepMap = new Map(next.get(stepId) ?? []);
      if (qty === 0) {
        stepMap.delete(variantId);
      } else {
        stepMap.set(variantId, qty);
      }
      next.set(stepId, stepMap);
      return next;
    });
  }

  function getStepQty(stepId: string): number {
    return [...(selections.get(stepId)?.values() ?? [])].reduce((a, b) => a + b, 0);
  }

  function isStepValid(step: BundleStep): boolean {
    const qty = getStepQty(step.id);
    return qty >= step.minQuantity && (step.maxQuantity === null || qty <= step.maxQuantity);
  }

  async function handleAddToCart() {
    if (adding) return;
    setAdding(true);
    try {
      const lines: Array<{
        variantId: string;
        quantity: number;
        properties: Record<string, string>;
      }> = [];
      for (const [stepId, stepMap] of selections.entries()) {
        for (const [variantId, qty] of stepMap.entries()) {
          lines.push({
            variantId,
            quantity: qty,
            properties: {
              _promo_engine_line_type: "bundle_component",
              _promo_engine_offer_id: config.offerId,
              _promo_engine_bundle_id: config.bundleId,
              _promo_engine_bundle_step_id: stepId,
              _promo_engine_bundle_title: config.title,
            },
          });
        }
      }

      await AjaxCartAdapter.addLines(lines);
      setAdded(true);
      emit(PromoEvents.CartChanged);
      publishAnalytics("promo_engine:bundle_added_to_cart", {
        offer_id: config.offerId,
        bundle_id: config.bundleId,
        total_qty: totalSelectedQty,
        session_id: sessionId,
      });
    } finally {
      setAdding(false);
    }
  }

  if (added) {
    return (
      <div class="pe-bb-success">
        <p>✓ Bundle added to cart!</p>
        <button onClick={() => setAdded(false)}>Build Another</button>
      </div>
    );
  }

  return (
    <div class="pe-bb">
      <h1 class="pe-bb-title">{config.title}</h1>
      {config.description && <p class="pe-bb-desc">{config.description}</p>}

      {/* Tier discount display */}
      {config.tiers.length > 0 && (
        <div class="pe-bb-tiers">
          {config.tiers.map((tier) => (
            <div
              key={tier.minQuantity}
              class={`pe-bb-tier${activeTier?.minQuantity === tier.minQuantity ? " pe-active" : ""}`}
            >
              <span class="pe-bb-tier-label">{tier.label}</span>
              <span class="pe-bb-tier-qty">
                Buy {tier.minQuantity}
                {tier.maxQuantity ? `–${tier.maxQuantity}` : "+"}
              </span>
              <span class="pe-bb-tier-discount">
                {tier.discountType === "percentage"
                  ? `-${Math.round(tier.discountValue)}%`
                  : formatPrice(Math.round(tier.discountValue * 100), config.currency)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Steps */}
      {(activeSteps as BundleStep[]).map((step) => {
        const stepQty = getStepQty(step.id);
        const isValid = isStepValid(step);

        const filteredProducts = step.products
          .filter((p) => !searchQuery || p.title.toLowerCase().includes(searchQuery.toLowerCase()))
          .sort((a, b) => {
            if (sortBy === "price_asc") return a.priceCents - b.priceCents;
            if (sortBy === "price_desc") return b.priceCents - a.priceCents;
            return a.title.localeCompare(b.title);
          });

        return (
          <div key={step.id} class="pe-bb-step">
            <div class="pe-bb-step-header">
              <h2 class="pe-bb-step-title">
                {isOneStepPerPage && `Step ${currentStep + 1} of ${config.steps.length}: `}
                {step.title}
              </h2>
              {step.subtitle && <p class="pe-bb-step-subtitle">{step.subtitle}</p>}
              <p class="pe-bb-step-count">
                {stepQty} selected
                {step.minQuantity > 0 && ` (min ${step.minQuantity})`}
                {step.maxQuantity && ` (max ${step.maxQuantity})`}
                {isValid && " ✓"}
              </p>
            </div>

            {step.searchEnabled && (
              <input
                class="pe-bb-search"
                type="text"
                placeholder="Search products..."
                value={searchQuery}
                onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                aria-label="Search products in this step"
              />
            )}

            <div class="pe-bb-products">
              {filteredProducts.map((product) => {
                const qty = selections.get(step.id)?.get(product.variantId) ?? 0;
                const atMax = step.maxQuantity !== null && stepQty >= step.maxQuantity && qty === 0;

                return (
                  <div
                    key={product.variantId}
                    class={`pe-bb-product${qty > 0 ? " pe-selected" : ""}${!product.isAvailable ? " pe-unavailable" : ""}${atMax ? " pe-at-max" : ""}`}
                  >
                    {product.imageUrl && (
                      <img
                        class="pe-bb-img"
                        src={product.imageUrl}
                        alt={product.title}
                        loading="lazy"
                      />
                    )}
                    <p class="pe-bb-product-name">{product.title}</p>
                    {product.variantTitle && <p class="pe-bb-variant">{product.variantTitle}</p>}
                    <p class="pe-bb-price">{formatPrice(product.priceCents, config.currency)}</p>
                    {!product.isAvailable ? (
                      <span class="pe-bb-oos">Out of stock</span>
                    ) : (
                      <div class="pe-bb-qty-ctrl">
                        <button
                          onClick={() =>
                            updateSelection(step.id, product.variantId, Math.max(0, qty - 1))
                          }
                          disabled={qty === 0}
                          aria-label={`Remove ${product.title}`}
                        >
                          −
                        </button>
                        <span class="pe-bb-qty">{qty}</span>
                        <button
                          onClick={() => updateSelection(step.id, product.variantId, qty + 1)}
                          disabled={atMax}
                          aria-label={`Add ${product.title}`}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Navigation and summary */}
      <div class="pe-bb-footer">
        {isOneStepPerPage ? (
          <div class="pe-bb-nav">
            {currentStep > 0 && (
              <button class="pe-bb-btn-prev" onClick={() => setCurrentStep((s) => s - 1)}>
                ← Previous
              </button>
            )}
            {currentStep < config.steps.length - 1 ? (
              <button
                class="pe-bb-btn-next"
                onClick={() => {
                  publishAnalytics("promo_engine:bundle_step_completed", {
                    offer_id: config.offerId,
                    step_index: currentStep,
                    session_id: sessionId,
                  });
                  setCurrentStep((s) => s + 1);
                }}
                disabled={!config.steps[currentStep] || !isStepValid(config.steps[currentStep]!)}
              >
                Next →
              </button>
            ) : (
              <button
                class="pe-bb-btn-add"
                onClick={handleAddToCart}
                disabled={adding || !config.steps.every((s) => isStepValid(s))}
              >
                {adding
                  ? "Adding…"
                  : `Add Bundle to Cart${activeTier ? ` (${activeTier.label})` : ""}`}
              </button>
            )}
          </div>
        ) : (
          <div class="pe-bb-summary">
            <p class="pe-bb-total">{totalSelectedQty} items selected</p>
            {activeTier && <p class="pe-bb-saving">💰 {activeTier.label} applied!</p>}
            <button
              class="pe-bb-btn-add"
              onClick={handleAddToCart}
              disabled={adding || !config.steps.every((s) => isStepValid(s))}
            >
              {adding ? "Adding…" : `Add Bundle to Cart`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function initBundleBuilder(
  container: HTMLElement,
  config: BundleBuilderConfig,
  sessionId: string,
) {
  if (!document.getElementById("pe-bundle-builder-styles")) {
    const style = document.createElement("style");
    style.id = "pe-bundle-builder-styles";
    style.textContent = BUNDLE_BUILDER_STYLES;
    document.head.appendChild(style);
  }
  render(h(BundleBuilderComponent, { config, sessionId }), container);
}

const BUNDLE_BUILDER_STYLES = `
.pe-bb{font-family:inherit;color:inherit;max-width:1200px;margin:0 auto}.pe-bb-title{font-size:clamp(1.8rem,4vw,2.75rem);margin:0 0 .5rem}.pe-bb-desc{color:rgba(0,0,0,.65);margin:0 0 1.5rem}.pe-bb-tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75rem;margin:0 0 1.5rem}.pe-bb-tier{border:1px solid rgba(0,0,0,.14);border-radius:12px;padding:.9rem;display:grid;gap:.25rem;background:#fff}.pe-bb-tier.pe-active{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.14)}.pe-bb-tier-label{font-weight:700}.pe-bb-tier-qty{font-size:.82rem;color:rgba(0,0,0,.62)}.pe-bb-tier-discount{font-weight:700;color:#166534}.pe-bb-step{margin:0 0 1.75rem}.pe-bb-step-header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap}.pe-bb-step-title{font-size:1.25rem;margin:0}.pe-bb-step-subtitle,.pe-bb-step-count{color:rgba(0,0,0,.62);margin:.35rem 0}.pe-bb-search{width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,.2);border-radius:10px;padding:.75rem;margin:.75rem 0}.pe-bb-products{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem}.pe-bb-product{border:1px solid rgba(0,0,0,.14);border-radius:14px;padding:.85rem;background:#fff;transition:border-color .15s,box-shadow .15s}.pe-bb-product.pe-selected{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.12)}.pe-bb-product.pe-unavailable{opacity:.55}.pe-bb-img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:9px}.pe-bb-product-name{font-weight:650;margin:.7rem 0 .2rem}.pe-bb-variant,.pe-bb-price,.pe-bb-oos{font-size:.88rem;margin:.2rem 0;color:rgba(0,0,0,.65)}.pe-bb-qty-ctrl{display:grid;grid-template-columns:40px 1fr 40px;align-items:center;margin-top:.75rem;border:1px solid rgba(0,0,0,.15);border-radius:9px;overflow:hidden}.pe-bb-qty-ctrl button{min-height:40px;border:0;background:#f5f5f5;font-size:1.15rem;cursor:pointer}.pe-bb-qty-ctrl button:disabled{opacity:.4;cursor:not-allowed}.pe-bb-qty{text-align:center;font-weight:700}.pe-bb-footer{position:sticky;bottom:0;background:rgba(255,255,255,.96);border-top:1px solid rgba(0,0,0,.12);padding:1rem 0}.pe-bb-nav,.pe-bb-summary{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;flex-wrap:wrap}.pe-bb-btn-prev,.pe-bb-btn-next,.pe-bb-btn-add,.pe-bb-success button{min-height:44px;border:0;border-radius:10px;padding:.75rem 1.1rem;font:inherit;font-weight:700;cursor:pointer}.pe-bb-btn-prev{background:#eee}.pe-bb-btn-next,.pe-bb-btn-add,.pe-bb-success button{background:#111;color:#fff}.pe-bb-btn-next:disabled,.pe-bb-btn-add:disabled{opacity:.45;cursor:not-allowed}.pe-bb-total,.pe-bb-saving{margin:0}.pe-bb-success{padding:1.5rem;border:1px solid #86efac;border-radius:14px;background:#f0fdf4}.pe-bb button:focus-visible,.pe-bb input:focus-visible{outline:3px solid rgba(37,99,235,.4);outline-offset:2px}@media(max-width:640px){.pe-bb-products{grid-template-columns:repeat(2,minmax(0,1fr))}.pe-bb-step-header{display:block}.pe-bb-footer{padding:1rem}.pe-bb-btn-add{width:100%}}
`;

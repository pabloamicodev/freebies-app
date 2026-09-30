/**
 * ProductPicker — modal para seleccionar productos/variantes en el offer builder.
 * Busca en el product cache (sincronizado desde Shopify Admin API).
 * Muestra thumbnail, título, variantes y precio.
 * Devuelve los GIDs de las variantes seleccionadas.
 */

import { useEffect, useCallback, useRef } from "react";
import { useDebouncedCallback } from "use-debounce";
import { AccessibleModal } from "./AccessibleModal.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";

interface ProductVariant {
  id: string;
  legacyId: number | null;
  sku: string | null;
  title: string;
  price: string;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  requiresSellingPlan: boolean;
  inventoryPolicy: string | null;
}

interface Product {
  id: string;
  legacyId: number | null;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  imageUrl: string | null;
  status: string | null;
  tags: string[];
  variants: ProductVariant[];
}

interface ProductPickerProps {
  open: boolean;
  onClose: () => void;
  /** Return mode: "variants" returns variant GIDs, "products" returns product GIDs. */
  mode?: "variants" | "products";
  allowMultiple?: boolean;
  title?: string;
  /** Already selected GIDs (shown as pre-checked). */
  selectedIds?: string[];
  onSelect: (gids: string[]) => void;
}

const EMPTY_SELECTED_IDS: string[] = [];

export function ProductPicker({
  open,
  selectedIds = EMPTY_SELECTED_IDS,
  ...props
}: ProductPickerProps) {
  if (!open) return null;

  return (
    <ProductPickerContent
      open={open}
      selectedIds={selectedIds}
      {...props}
    />
  );
}

function ProductPickerContent({
  open,
  onClose,
  mode = "variants",
  allowMultiple = true,
  title = "Select Products",
  selectedIds = EMPTY_SELECTED_IDS,
  onSelect,
}: ProductPickerProps) {
  const [pickerState, setPickerField] = useObjectState(() => ({
    query: "",
    products: [] as Product[],
    loading: false,
    syncing: false,
    error: null as string | null,
    selected: new Set(selectedIds),
    expandedProducts: new Set<string>(),
  }));
  const { query, products, loading, syncing, error, selected, expandedProducts } = pickerState;
  const setQuery = createFieldSetter(setPickerField, "query");
  const setSelected = createFieldSetter(setPickerField, "selected");
  const setExpandedProducts = createFieldSetter(setPickerField, "expandedProducts");
  const fetchRequestId = useRef(0);

  // Sync selection from parent whenever the modal opens
  useEffect(() => {
    if (open) setSelected(new Set(selectedIds));
  }, [open]);

  // Fetch products from search API. If the cache has never been synced, trigger sync first.
  const fetchProducts = useCallback(async (q: string) => {
    const requestId = ++fetchRequestId.current;
    setPickerField("loading", true);
    setPickerField("error", null);
    try {
      const params = new URLSearchParams({ q, limit: "20", variants: "true" });
      const res = await fetch(`/api/products/search?${params}`);
      if (!res.ok) {
        if (requestId !== fetchRequestId.current) return;
        setPickerField("error", `Search failed (${res.status}). Please try again.`);
        setPickerField("products", []);
        return;
      }
      const data = await res.json() as { products: Product[]; cache: { lastSyncedAt: string | null } };
      if (requestId !== fetchRequestId.current) return;

      // Cache is empty and has never been synced — trigger initial sync then reload.
      if (data.products.length === 0 && data.cache.lastSyncedAt === null) {
        setPickerField("loading", false);
        setPickerField("syncing", true);
        try {
          const queued = await fetch("/api/products/sync", { method: "POST" });
          if (!queued.ok) throw new Error(`Sync request failed (${queued.status})`);
          // Poll progress while also nudging queued work. The persisted job and
          // lease keep these calls idempotent; cron continues if the modal closes.
          for (let attempt = 0; attempt < 30; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            const statusResponse = await fetch("/api/products/sync");
            if (!statusResponse.ok) throw new Error(`Sync status failed (${statusResponse.status})`);
            const statusBody = await statusResponse.json() as { job: { status: string; syncedProducts: number; error: string | null } | null };
            if (statusBody.job?.status === "completed") break;
            if (statusBody.job?.status === "failed") throw new Error(statusBody.job.error ?? "Catalog sync failed");
            if (statusBody.job?.status === "queued") {
              await fetch("/api/products/sync", { method: "POST" });
            }
          }
        } catch (syncError) {
          if (requestId === fetchRequestId.current) {
            setPickerField("error", syncError instanceof Error ? syncError.message : "Catalog sync failed.");
          }
        }
        setPickerField("syncing", false);
        // Re-fetch after sync
        const res2 = await fetch(`/api/products/search?${params}`);
        if (res2.ok && requestId === fetchRequestId.current) {
          const data2 = await res2.json() as { products: Product[] };
          setPickerField("products", data2.products);
        }
        return;
      }

      setPickerField("products", data.products);
    } catch {
      if (requestId !== fetchRequestId.current) return;
      setPickerField("error", "Search unavailable. Check your connection and try again.");
      setPickerField("products", []);
    } finally {
      if (requestId === fetchRequestId.current) {
        setPickerField("loading", false);
        setPickerField("syncing", false);
      }
    }
  }, [setPickerField]);

  const debouncedFetch = useDebouncedCallback(fetchProducts, 300);

  useEffect(() => {
    if (query) {
      void debouncedFetch(query);
    } else {
      debouncedFetch.cancel();
      void fetchProducts("");
    }
    return () => debouncedFetch.cancel();
  }, [debouncedFetch, fetchProducts, query]);

  useEffect(() => () => {
    fetchRequestId.current += 1;
    debouncedFetch.cancel();
  }, [debouncedFetch]);

  const toggleVariant = useCallback((variantGid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(variantGid)) {
        next.delete(variantGid);
      } else {
        if (!allowMultiple) next.clear();
        next.add(variantGid);
      }
      return next;
    });
  }, [allowMultiple, setSelected]);

  const toggleProduct = useCallback((productGid: string, allVariantGids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (mode === "products") {
        if (next.has(productGid)) next.delete(productGid);
        else { if (!allowMultiple) next.clear(); next.add(productGid); }
      } else {
        const allSelected = allVariantGids.every((v) => next.has(v));
        if (allSelected) allVariantGids.forEach((v) => next.delete(v));
        else allVariantGids.forEach((v) => next.add(v));
      }
      return next;
    });
  }, [mode, allowMultiple, setSelected]);

  const handleConfirm = useCallback(() => {
    onSelect([...selected]);
    onClose();
  }, [selected, onSelect, onClose]);

  return (
    <AccessibleModal ariaLabel={title} className="b-modal-lg" onClose={onClose}>
      <div className="b-modal-header">
        <h2 className="b-modal-title">{title}</h2>
        <button type="button" className="b-modal-close" onClick={onClose} aria-label="Close">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="b-picker-search-bar">
        <div className="b-search-wrap">
          <span className="b-search-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <label htmlFor="product-picker-search" className="visually-hidden">Search products</label>
          <input
            id="product-picker-search"
            type="text"
            className="b-search-input"
            placeholder="Search by title, handle, or vendor…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
          />
          {query && (
            <button
              type="button"
              className="b-picker-search-clear"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="b-picker-list">
        {loading || syncing ? (
          <div className="b-picker-empty" role="status" aria-live="polite">
            <span className="b-spinner" aria-hidden="true" />
            <span className="visually-hidden">Loading products…</span>
            {syncing && (
              <p className="b-picker-empty-text">Syncing your product catalog… this only happens once.</p>
            )}
          </div>
        ) : error ? (
          <div className="b-picker-empty">
            <p className="b-picker-empty-heading">Could not load products</p>
            <p className="b-picker-empty-text">{error}</p>
          </div>
        ) : products.length === 0 ? (
          <div className="b-picker-empty">
            <p className="b-picker-empty-heading">No products found</p>
            <p className="b-picker-empty-text">Try a different search term.</p>
          </div>
        ) : (
          <ul className="b-list-reset">
            {products.map((product) => {
              const isExpanded = expandedProducts.has(product.id);
              // availableForSale already covers untracked inventory and oversell policy.
              const selectableVariants = product.variants?.filter((variant) =>
                variant.availableForSale && !variant.requiresSellingPlan,
              ) ?? [];
              const variantGids = selectableVariants.map((variant) => variant.id);
              const productSelectable = product.status === "ACTIVE" && variantGids.length > 0;
              const productSelected =
                mode === "products"
                  ? selected.has(product.id)
                  : variantGids.length > 0 && variantGids.every((v) => selected.has(v));

              // The product-level checkbox always toggles the whole product/all its
              // variants; clicking elsewhere on the row instead expands/collapses
              // the variant list when there's more than one variant (in "variants" mode).
              const toggleAction = () => {
                if (!productSelectable) return;
                if (product.variants?.length === 1 && mode === "variants") {
                  toggleVariant(product.variants[0]!.id);
                } else {
                  toggleProduct(product.id, variantGids);
                }
              };

              const rowOnClick = () => {
                if (!productSelectable) return;
                if (mode === "products" || !product.variants?.length || product.variants.length === 1) {
                  toggleAction();
                } else {
                  const next = new Set(expandedProducts);
                  isExpanded ? next.delete(product.id) : next.add(product.id);
                  setExpandedProducts(next);
                }
              };

              return (
                <li key={product.id} className="b-picker-row">
                  <div className="b-picker-row-main" onClick={rowOnClick}>
                    <span className="b-checkbox-row" onClick={(event) => event.stopPropagation()}>
                      <label className="visually-hidden" htmlFor={`picker-check-${product.id}`}>
                        Select {product.title}
                      </label>
                      <input
                        id={`picker-check-${product.id}`}
                        type="checkbox"
                        checked={productSelected}
                        disabled={!productSelectable}
                        onChange={toggleAction}
                      />
                    </span>

                    {product.imageUrl ? (
                      <img src={product.imageUrl} alt="" className="b-picker-thumb" />
                    ) : (
                      <span className="b-picker-thumb" aria-hidden="true" />
                    )}

                    <div className="b-picker-row-body">
                      <div className="b-row-between b-gap-2">
                        <span className="b-picker-row-title">{product.title}</span>
                        <span className="b-flex b-items-center b-gap-2">
                          {product.status !== "ACTIVE" && <span className="b-badge b-badge-red">Not active</span>}
                          {!productSelectable && product.status === "ACTIVE" && (
                            <span className="b-badge b-badge-red">No eligible variants</span>
                          )}
                          {product.vendor && <span className="b-picker-row-sub">{product.vendor}</span>}
                        </span>
                      </div>

                      {/* Variant list — shown when expanded or when product has multiple variants */}
                      {mode === "variants" && product.variants && product.variants.length > 1 && isExpanded && (
                        <ul className="b-list-reset b-picker-variant-list">
                          {product.variants.map((variant) => (
                            <li
                              key={variant.id}
                              className="b-picker-variant-row"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <span className="b-checkbox-row">
                                <label className="visually-hidden" htmlFor={`picker-variant-${variant.id}`}>
                                  Select {product.title} - {variant.title}
                                </label>
                                <input
                                  id={`picker-variant-${variant.id}`}
                                  type="checkbox"
                                  checked={selected.has(variant.id)}
                                  disabled={!selectableVariants.some((candidate) => candidate.id === variant.id)}
                                  onChange={() => toggleVariant(variant.id)}
                                />
                              </span>
                              <span className="b-picker-variant-title">{variant.title}</span>
                              <span className="b-picker-row-sub">${variant.price}</span>
                              {variant.sku && <span className="b-picker-row-sub">SKU: {variant.sku}</span>}
                              {!variant.availableForSale && <span className="b-badge b-badge-red">OOS</span>}
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* Single variant — show inline */}
                      {mode === "variants" && product.variants?.length === 1 && (
                        <p className="b-picker-row-sub b-m-0">
                          ${product.variants[0]?.price}
                          {product.variants[0]?.sku ? ` · SKU: ${product.variants[0].sku}` : ""}
                          {!product.variants[0]?.availableForSale ? " · Out of stock" : ""}
                        </p>
                      )}

                      {/* Expand button for multiple variants */}
                      {mode === "variants" && product.variants && product.variants.length > 1 && (
                        <button
                          type="button"
                          className="b-btn b-btn-plain"
                          onClick={(event) => {
                            event.stopPropagation();
                            const next = new Set(expandedProducts);
                            isExpanded ? next.delete(product.id) : next.add(product.id);
                            setExpandedProducts(next);
                          }}
                        >
                          {isExpanded ? "▲ Hide variants" : `▼ ${product.variants.length} variants`}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="b-modal-footer">
        <button type="button" className="b-btn b-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="b-btn b-btn-primary"
          disabled={selected.size === 0}
          onClick={handleConfirm}
        >
          {`Select ${selected.size > 0 ? `(${selected.size})` : ""}`}
        </button>
      </div>
    </AccessibleModal>
  );
}

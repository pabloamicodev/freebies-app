/**
 * ProductPicker — modal para seleccionar productos/variantes en el offer builder.
 * Busca en el product cache (sincronizado desde Shopify Admin API).
 * Muestra thumbnail, título, variantes y precio.
 * Devuelve los GIDs de las variantes seleccionadas.
 */

import { useEffect, useCallback } from "react";
import {
  Modal, TextField, ResourceList, ResourceItem, Thumbnail,
  Text, Badge, InlineStack, BlockStack, Spinner, Button,
  EmptyState, Checkbox,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useDebouncedCallback } from "use-debounce";
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

  // Sync selection from parent whenever the modal opens
  useEffect(() => {
    if (open) setSelected(new Set(selectedIds));
  }, [open]);

  // Fetch products from search API. If the cache has never been synced, trigger sync first.
  const fetchProducts = useCallback(async (q: string) => {
    setPickerField("loading", true);
    setPickerField("error", null);
    try {
      const params = new URLSearchParams({ q, limit: "20", variants: "true" });
      const res = await fetch(`/api/products/search?${params}`);
      if (!res.ok) {
        setPickerField("error", `Search failed (${res.status}). Please try again.`);
        setPickerField("products", []);
        return;
      }
      const data = await res.json() as { products: Product[]; cache: { lastSyncedAt: string | null } };

      // Cache is empty and has never been synced — trigger initial sync then reload.
      if (data.products.length === 0 && data.cache.lastSyncedAt === null) {
        setPickerField("loading", false);
        setPickerField("syncing", true);
        try {
          await fetch("/api/products/sync", { method: "POST" });
        } catch {
          // Sync failure is non-fatal — will show empty state below
        }
        setPickerField("syncing", false);
        // Re-fetch after sync
        const res2 = await fetch(`/api/products/search?${params}`);
        if (res2.ok) {
          const data2 = await res2.json() as { products: Product[] };
          setPickerField("products", data2.products);
        }
        return;
      }

      setPickerField("products", data.products);
    } catch {
      setPickerField("error", "Search unavailable. Check your connection and try again.");
      setPickerField("products", []);
    } finally {
      setPickerField("loading", false);
      setPickerField("syncing", false);
    }
  }, [setPickerField]);

  const debouncedFetch = useDebouncedCallback(fetchProducts, 300);

  useEffect(() => {
    void fetchProducts("");
  }, [fetchProducts]);

  useEffect(() => {
    void debouncedFetch(query);
  }, [debouncedFetch, query]);

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
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      primaryAction={{ content: `Select ${selected.size > 0 ? `(${selected.size})` : ""}`, onAction: handleConfirm, disabled: selected.size === 0 }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <TextField
          label="Search products"
          labelHidden
          placeholder="Search by title, handle, or vendor…"
          value={query}
          onChange={setQuery}
          prefix={<SearchIcon />}
          autoComplete="off"
          clearButton
          onClearButtonClick={() => setQuery("")}
        />
      </Modal.Section>

      <Modal.Section flush>
        {loading || syncing ? (
          <div style={{ padding: "40px", textAlign: "center" }}>
            <BlockStack gap="300" inlineAlign="center">
              <Spinner size="large" />
              {syncing && (
                <Text as="p" tone="subdued">
                  Syncing your product catalog… this only happens once.
                </Text>
              )}
            </BlockStack>
          </div>
        ) : error ? (
          <EmptyState heading="Could not load products" image="">
            <p>{error}</p>
          </EmptyState>
        ) : products.length === 0 ? (
          <EmptyState heading="No products found" image="">
            <p>Try a different search term.</p>
          </EmptyState>
        ) : (
          <ResourceList
            resourceName={{ singular: "product", plural: "products" }}
            items={products}
            renderItem={(product) => {
              const isExpanded = expandedProducts.has(product.id);
              const variantGids = product.variants?.map((v) => v.id) ?? [];
              const productSelected =
                mode === "products"
                  ? selected.has(product.id)
                  : variantGids.length > 0 && variantGids.every((v) => selected.has(v));
              return (
                <ResourceItem
                  id={product.id}
                  onClick={() => {
                    if (mode === "products" || !product.variants?.length || product.variants.length === 1) {
                      if (product.variants?.length === 1 && mode === "variants") {
                        toggleVariant(product.variants[0]!.id);
                      } else {
                        toggleProduct(product.id, variantGids);
                      }
                    } else {
                      // Expand to show variants
                      const next = new Set(expandedProducts);
                      isExpanded ? next.delete(product.id) : next.add(product.id);
                      setExpandedProducts(next);
                    }
                  }}
                  media={
                    <Thumbnail
                      source={product.imageUrl ?? ""}
                      alt={product.title}
                      size="medium"
                    />
                  }
                >
                  <BlockStack gap="100">
                    <InlineStack gap="300" align="space-between">
                      <InlineStack gap="200">
                        <Checkbox
                          label={`Select ${product.title}`}
                          labelHidden
                          checked={productSelected}
                          onChange={() => {
                            if (product.variants?.length === 1 && mode === "variants") {
                              toggleVariant(product.variants[0]!.id);
                            } else {
                              toggleProduct(product.id, variantGids);
                            }
                          }}
                        />
                        <Text as="p" fontWeight="semibold">{product.title}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        {product.status === "ARCHIVED" && <Badge tone="critical">Archived</Badge>}
                        {product.vendor && <Text as="span" tone="subdued">{product.vendor}</Text>}
                      </InlineStack>
                    </InlineStack>

                    {/* Variant list — shown when expanded or when product has multiple variants */}
                    {mode === "variants" && product.variants && product.variants.length > 1 && isExpanded && (
                      <BlockStack gap="100">
                        {product.variants.map((variant) => (
                          <InlineStack key={variant.id} gap="200" align="start">
                            <Checkbox
                              label={`Select ${product.title} - ${variant.title}`}
                              labelHidden
                              checked={selected.has(variant.id)}
                              onChange={() => toggleVariant(variant.id)}
                            />
                            <Text as="span" variant="bodySm">{variant.title}</Text>
                            <Text as="span" variant="bodySm" tone="subdued">${variant.price}</Text>
                            {variant.sku && <Text as="span" variant="bodySm" tone="subdued">SKU: {variant.sku}</Text>}
                            {!variant.availableForSale && <Badge tone="critical">OOS</Badge>}
                          </InlineStack>
                        ))}
                      </BlockStack>
                    )}

                    {/* Single variant — show inline */}
                    {mode === "variants" && product.variants?.length === 1 && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        ${product.variants[0]?.price}
                        {product.variants[0]?.sku ? ` · SKU: ${product.variants[0].sku}` : ""}
                        {!product.variants[0]?.availableForSale ? " · Out of stock" : ""}
                      </Text>
                    )}

                    {/* Expand button for multiple variants */}
                    {mode === "variants" && product.variants && product.variants.length > 1 && (
                      <Button
                        variant="plain"
                        size="micro"
                        onClick={() => {
                          const next = new Set(expandedProducts);
                          isExpanded ? next.delete(product.id) : next.add(product.id);
                          setExpandedProducts(next);
                        }}
                      >
                        {isExpanded ? "▲ Hide variants" : `▼ ${product.variants.length} variants`}
                      </Button>
                    )}
                  </BlockStack>
                </ResourceItem>
              );
            }}
          />
        )}
      </Modal.Section>
    </Modal>
  );
}

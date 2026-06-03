/**
 * ProductPicker — modal para seleccionar productos/variantes en el offer builder.
 * Busca en el product cache (sincronizado desde Shopify Admin API).
 * Muestra thumbnail, título, variantes y precio.
 * Devuelve los GIDs de las variantes seleccionadas.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Modal, TextField, ResourceList, ResourceItem, Thumbnail,
  Text, Badge, InlineStack, BlockStack, Spinner, Button,
  EmptyState, Checkbox,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useDebouncedCallback } from "use-debounce";

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

export function ProductPicker({
  open,
  onClose,
  mode = "variants",
  allowMultiple = true,
  title = "Select Products",
  selectedIds = [],
  onSelect,
}: ProductPickerProps) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedIds));
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());

  // Fetch products from search API
  const fetchProducts = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, limit: "20", variants: "true" });
      const res = await fetch(`/api/products/search?${params}`);
      if (!res.ok) return;
      const data = await res.json() as { products: Product[] };
      setProducts(data.products);
    } catch {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const debouncedFetch = useDebouncedCallback(fetchProducts, 300);

  // Load on open
  useEffect(() => {
    if (open) {
      setSelected(new Set(selectedIds));
      void fetchProducts("");
    }
  }, [open]);

  useEffect(() => {
    void debouncedFetch(query);
  }, [query]);

  function toggleVariant(variantGid: string) {
    const next = new Set(selected);
    if (next.has(variantGid)) {
      next.delete(variantGid);
    } else {
      if (!allowMultiple) next.clear();
      next.add(variantGid);
    }
    setSelected(next);
  }

  function toggleProduct(productGid: string, allVariantGids: string[]) {
    if (mode === "products") {
      const next = new Set(selected);
      if (next.has(productGid)) {
        next.delete(productGid);
      } else {
        if (!allowMultiple) next.clear();
        next.add(productGid);
      }
      setSelected(next);
    } else {
      // Select all variants of this product
      const next = new Set(selected);
      const allSelected = allVariantGids.every((v) => next.has(v));
      if (allSelected) {
        allVariantGids.forEach((v) => next.delete(v));
      } else {
        allVariantGids.forEach((v) => next.add(v));
      }
      setSelected(next);
    }
  }

  function handleConfirm() {
    onSelect([...selected]);
    onClose();
  }

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
          label=""
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
        {loading ? (
          <div style={{ padding: "40px", textAlign: "center" }}>
            <Spinner size="large" />
          </div>
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
                          label=""
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
                              label=""
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

import type { PageType } from "@promo/shared-types";

export const PAGE_TYPE_OPTIONS: ReadonlyArray<{ value: PageType; label: string; example: string }> = [
  { value: "home", label: "Home page", example: "/" },
  { value: "collection", label: "Collections", example: "/collections/…" },
  { value: "product", label: "Product pages", example: "/products/…" },
  { value: "search", label: "Search results", example: "/search" },
  { value: "page", label: "Landing pages", example: "/pages/…" },
  { value: "blog", label: "Blog", example: "/blogs/…" },
  { value: "cart", label: "Cart", example: "/cart" },
];

export const DEFAULT_CODE_PAGE_TYPES: PageType[] = ["home", "collection", "product"];

const LABELS = new Map<string, string>(PAGE_TYPE_OPTIONS.map((option) => [option.value, option.label]));

export function pageTypeLabel(value: string): string {
  return LABELS.get(value) ?? value;
}

export function readPageTypes(value: unknown): PageType[] {
  if (!Array.isArray(value)) return [];
  return PAGE_TYPE_OPTIONS.map((option) => option.value).filter((type) => value.includes(type));
}

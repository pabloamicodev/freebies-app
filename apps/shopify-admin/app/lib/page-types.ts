import { splitPageUrl, type PageType } from "@promo/shared-types";

export const PAGE_TYPE_OPTIONS: ReadonlyArray<{ value: PageType; label: string; example: string }> = [
  { value: "home", label: "Home page", example: "/" },
  { value: "collection", label: "Collections", example: "/collections/…" },
  { value: "product", label: "Product pages", example: "/products/…" },
  { value: "search", label: "Search results", example: "/search" },
  { value: "page", label: "Pages", example: "/pages/…" },
  { value: "blog", label: "Blog", example: "/blogs/…" },
  { value: "cart", label: "Cart", example: "/cart" },
];

export const DEFAULT_CODE_PAGE_TYPES: PageType[] = ["home", "collection", "product"];

const LABELS = new Map<string, string>(PAGE_TYPE_OPTIONS.map((option) => [option.value, option.label]));

export function pageTypeLabel(value: string): string {
  return LABELS.get(value) ?? value;
}

/**
 * The Pages URL input shows only the handle after a fixed "/pages" prefix; the stored value is the
 * full path. `final` (blur / save) also drops trailing slashes and a bare "pages"; while typing both stay.
 */
export function cleanPageHandle(raw: string, final = false): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  let path = splitPageUrl(trimmed).path.replace(/^\/?pages\//i, "/");
  if (final) path = path.replace(/^\/?pages$/i, "").replace(/\/+$/, "");
  if (path === "" || path === "/") return "";
  return path.startsWith("/") ? path : `/${path}`;
}

export function pageHandleToUrl(handle: string): string {
  const clean = cleanPageHandle(handle, true);
  return clean ? `/pages${clean}` : "";
}

export function pageUrlToHandle(stored: string): string {
  return cleanPageHandle(stored, true);
}

/**
 * "Exclude these pages" input: a full path on any kind of page. A pasted URL (https://shop.com/products/x?v=1)
 * becomes its path while typing; a leading slash is added; `final` (blur / save) also drops the query,
 * fragment and trailing slashes. A bare "/" (home) is dropped on `final`.
 */
export function cleanExcludeUrl(raw: string, final = false): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const absolute = /^(?:https?:)?\/\//i.test(trimmed);
  if (!final && !absolute) return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const path = splitPageUrl(trimmed).path.replace(/\/+$/, "");
  if (path === "") return final ? "" : "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/** Raw URL rows as stored (kept un-normalized so the editor shows what the merchant typed). */
export function readPageUrls(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((url): url is string => typeof url === "string") : [];
}

export function readExcludeUrls(value: unknown): string[] {
  return readPageUrls(value);
}

export function readPageTypes(value: unknown): PageType[] {
  if (!Array.isArray(value)) return [];
  return PAGE_TYPE_OPTIONS.map((option) => option.value).filter((type) => value.includes(type));
}

import { ApiVersion } from "@shopify/shopify-api";

/**
 * Single source of truth for the Shopify Admin API version.
 *
 * Keep this in sync with `[webhooks].api_version` in shopify.app.toml and the
 * `SHOPIFY_API_VERSION` constants in the background workers (which can't import
 * from this app package).
 *
 * 2026-04 is the latest stable release as of mid-2026 and is supported by
 * @shopify/shopify-api ^13 (ApiVersion.April26).
 */
export const SHOPIFY_API_VERSION = ApiVersion.April26; // "2026-04"

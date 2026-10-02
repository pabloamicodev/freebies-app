import type { ApiVersion } from "@shopify/shopify-api";
import { SHOPIFY_API_VERSION as SHARED_API_VERSION } from "@promo/shared-types";

/**
 * The Admin API version, derived from the one constant in `@promo/shared-types` (which the
 * storefront runtime and the background workers import too). Bump it there. What cannot import
 * code (the `api_version` in the app and extension TOMLs, the Function schemas) is checked against
 * it by `shopify-api-version.test.ts`, so a partial bump fails CI instead of production.
 *
 * Must be a version @shopify/shopify-api knows (the test asserts that too).
 */
export const SHOPIFY_API_VERSION = SHARED_API_VERSION as unknown as ApiVersion;

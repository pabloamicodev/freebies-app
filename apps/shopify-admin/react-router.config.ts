import type { Config } from "@react-router/dev/config";

export default {
  // Shopify embedded apps run inside an iframe in the Shopify admin.
  // SSR causes React hydration mismatches with App Bridge (browser-only).
  // SPA mode (ssr: false) renders entirely client-side — no hydration needed.
  // Server-side loaders and redirects (auth flow) still work correctly.
  ssr: false,
} satisfies Config;

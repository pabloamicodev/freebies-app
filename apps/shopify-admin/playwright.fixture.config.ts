import { defineConfig } from "@playwright/test";

// Offline storefront fixture: the committed promo-engine.js runs on a fake Dawn-like theme, every request answered by page.route.
// No store, no sign-in, no app server.
export default defineConfig({
  testDir: "./tests/storefront-fixture",
  workers: 1,
  reporter: "list",
  outputDir: "./test-results/storefront-fixture",
  use: { headless: true },
});

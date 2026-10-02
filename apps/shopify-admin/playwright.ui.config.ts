import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4192";
process.env["APP_URL"] = baseURL;

export default defineConfig({
  testDir: "./tests",
  testMatch: ["e2e/code-discount-products.spec.ts", "ui/code-discount-navigation.spec.ts"],
  workers: 1,
  reporter: "list",
  outputDir: "./test-results/ui",
  use: { baseURL, headless: true },
  webServer: {
    command: "node tests/ui/wizard-harness.mjs",
    url: baseURL,
    reuseExistingServer: false,
  },
});

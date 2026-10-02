import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4192";
export default defineConfig({
  testDir: "./tests/ui",
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

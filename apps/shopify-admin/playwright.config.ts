import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";
import path from "path";

config({ path: ".env.test" });

const DEV_STORE_URL = process.env["DEV_STORE_URL"];
const APP_URL = process.env["APP_URL"];

// Skip all tests when required env vars are not configured.
// This prevents CI failures when the "e2e" environment secrets aren't set.
const isConfigured =
  DEV_STORE_URL &&
  DEV_STORE_URL !== "https://YOUR-DEV-STORE.myshopify.com" &&
  APP_URL;

if (!isConfigured) {
  console.log(
    "[playwright] Skipping E2E tests — DEV_STORE_URL and APP_URL must be set in .env.test or CI secrets.",
  );
}

const AUTH_FILE = path.join(__dirname, "tests/e2e/.auth/shopify.json");
const hasAuthFile = (() => {
  try {
    require("fs").accessSync(AUTH_FILE);
    return true;
  } catch {
    return false;
  }
})();

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: isConfigured ? [] : ["**/*.spec.ts"],
  globalSetup: isConfigured ? "./tests/e2e/global-setup.ts" : undefined,
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
  use: {
    baseURL: DEV_STORE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    storageState: hasAuthFile ? AUTH_FILE : undefined,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
    },
  ],
  timeout: 60_000,
});

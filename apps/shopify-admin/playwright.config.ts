import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

config({ path: ".env.test" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEV_STORE_URL = process.env["DEV_STORE_URL"];
const APP_URL = process.env["APP_URL"];
const AUTH_FILE = path.join(__dirname, "tests/e2e/.auth/shopify.json");
const hasAuthFile = (() => {
  try {
    fs.accessSync(AUTH_FILE);
    return true;
  } catch {
    return false;
  }
})();

const isConfigured =
  DEV_STORE_URL && DEV_STORE_URL !== "https://YOUR-DEV-STORE.myshopify.com" && APP_URL;

if (!isConfigured) {
  throw new Error(
    "E2E configuration is required: set DEV_STORE_URL and APP_URL in .env.test or CI secrets.",
  );
}
if (process.env["CI"] === "true") {
  const requiredCiVars = [
    "E2E_PRODUCT_HANDLE",
    "E2E_BUNDLE_PRODUCT_HANDLE",
    "E2E_VOLUME_PRODUCT_HANDLE",
    "E2E_QUALIFYING_VARIANT_ID",
  ];
  const missingCiVars = requiredCiVars.filter((name) => !process.env[name]);
  if (missingCiVars.length > 0) {
    throw new Error(`E2E storefront configuration is required in CI: ${missingCiVars.join(", ")}`);
  }
}

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
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

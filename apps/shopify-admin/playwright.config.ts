import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

config({ path: ".env.test", quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// "storefront" (default): buyer flows against the hpn-test-store storefront.
// "admin": embedded-admin CRUD flows; needs a Shopify admin session (see global-setup.ts).
const SUITE = process.env["E2E_SUITE"] === "admin" ? "admin" : "storefront";

const DEV_STORE_URL = process.env["DEV_STORE_URL"];
const APP_URL = process.env["APP_URL"];
export const AUTH_FILE = path.join(__dirname, "tests/e2e/.auth/shopify.json");
export const ADMIN_AUTH_FILE = path.join(__dirname, "tests/e2e/.auth/admin.json");

if (!DEV_STORE_URL || DEV_STORE_URL === "https://YOUR-DEV-STORE.myshopify.com" || !APP_URL) {
  throw new Error(
    "E2E configuration is required: set DEV_STORE_URL and APP_URL in .env.test or CI secrets.",
  );
}
if (process.env["CI"] === "true" && SUITE === "storefront") {
  const requiredCiVars = [
    "DEV_STORE_PASSWORD",
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

// Shopify's bot checkpoint challenges the HeadlessChrome user agent on /cart/*.js.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const desktop = {
  ...devices["Desktop Chrome"],
  userAgent: CHROME_UA,
  launchOptions: { args: ["--disable-blink-features=AutomationControlled"] },
};

const storefrontSpecs = /(ambrosia-parity|gift-offer|bundle-offer|multi-currency)\.spec\.ts/;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  // A retry would only repeat cart calls against the bot protection; helpers already back off.
  retries: 0,
  // Storefront specs share one cart-API budget per IP, so they must never run concurrently.
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: SUITE === "admin" ? APP_URL : DEV_STORE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    storageState: SUITE === "admin" ? ADMIN_AUTH_FILE : AUTH_FILE,
  },
  projects:
    SUITE === "admin"
      ? [{ name: "admin", testMatch: /offer-lifecycle\.spec\.ts/, use: desktop, timeout: 90_000 }]
      : [
          // Budget covers the bounded bot-protection backoff in helpers/storefront.ts.
          { name: "storefront", testMatch: storefrontSpecs, use: desktop, timeout: 240_000 },
          ...(process.env["E2E_MOBILE"] === "1"
            ? [
                {
                  name: "storefront-mobile",
                  testMatch: /(gift-offer|bundle-offer)\.spec\.ts/,
                  use: { ...devices["Pixel 7"] },
                  timeout: 240_000,
                },
              ]
            : []),
        ],
});

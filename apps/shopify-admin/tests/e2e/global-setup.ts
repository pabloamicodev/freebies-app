/**
 * Playwright global setup — authenticates with Shopify admin OAuth.
 *
 * Logs in to the dev store, completes the app OAuth flow, and saves the
 * resulting browser state so tests can reuse it without re-authenticating.
 *
 * Required env vars (set in .env.test or CI secrets):
 *   APP_URL              — deployed app URL, e.g. https://yourapp.vercel.app
 *   DEV_STORE_URL        — Shopify dev store URL, e.g. https://hpn-test-store.myshopify.com
 *   DEV_STORE_PASSWORD   — Online Store password for the protected dev storefront
 *   SHOPIFY_ADMIN_EMAIL  — dev store admin email
 *   SHOPIFY_ADMIN_PASSWORD — dev store admin password
 */

import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { buildShopifyOAuthUrl, isStorefrontPasswordUrl } from "../../app/lib/e2e-bootstrap.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URL = process.env["APP_URL"] ?? "";
const DEV_STORE_URL = process.env["DEV_STORE_URL"] ?? "";
const EMAIL = process.env["SHOPIFY_ADMIN_EMAIL"] ?? "";
const PASSWORD = process.env["SHOPIFY_ADMIN_PASSWORD"] ?? "";
const STOREFRONT_PASSWORD = process.env["DEV_STORE_PASSWORD"] ?? "";
const PRODUCT_HANDLE = process.env["E2E_PRODUCT_HANDLE"] ?? "test-product";

export const AUTH_FILE = path.join(__dirname, ".auth", "shopify.json");

export default async function globalSetup() {
  if (!APP_URL || !DEV_STORE_URL) {
    throw new Error("E2E setup requires APP_URL and DEV_STORE_URL.");
  }

  const authDir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  console.info("[global-setup] Starting Shopify OAuth flow...");

  try {
    if (EMAIL && PASSWORD) {
      // Start at the explicit login route. Opening APP_URL without Shopify's
      // embedded query parameters redirects to /app and correctly returns 410.
      await page.goto(buildShopifyOAuthUrl(APP_URL, DEV_STORE_URL), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      if (page.url().includes("accounts.shopify.com") || page.url().includes("/admin/login")) {
        console.info("[global-setup] Logging in to Shopify...");

        const emailInput = page
          .locator('input[type="email"], input[name="account[email]"]')
          .first();
        if (await emailInput.isVisible({ timeout: 10_000 })) {
          await emailInput.fill(EMAIL);
          await page.locator('button[type="submit"]').first().click();
          await page.waitForTimeout(1000);
        }

        const passwordInput = page
          .locator('input[type="password"], input[name="account[password]"]')
          .first();
        if (await passwordInput.isVisible({ timeout: 10_000 })) {
          await passwordInput.fill(PASSWORD);
          await page.locator('button[type="submit"]').first().click();
        }

        await page.waitForURL((url) => url.href.startsWith(APP_URL), { timeout: 30_000 });
        console.info("[global-setup] OAuth complete, landed at:", page.url());
      }

      await page.waitForLoadState("networkidle", { timeout: 20_000 });
    } else {
      if (EMAIL || PASSWORD) {
        console.info(
          "[global-setup] Incomplete admin credential pair ignored for storefront-only tests.",
        );
      }
      console.info(
        "[global-setup] Admin OAuth skipped; storefront tests do not require admin credentials.",
      );
    }

    // Development stores are password protected. Unlock the Online Store in
    // the same browser context so storefront specs inherit storefront_digest.
    await page.goto(`${DEV_STORE_URL}/products/${encodeURIComponent(PRODUCT_HANDLE)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    if (isStorefrontPasswordUrl(page.url(), DEV_STORE_URL)) {
      if (!STOREFRONT_PASSWORD) {
        throw new Error(
          "The development storefront is password protected; set DEV_STORE_PASSWORD.",
        );
      }

      const passwordInput = page.locator('input[name="password"]').first();
      await passwordInput.waitFor({ state: "visible", timeout: 10_000 });
      await passwordInput.fill(STOREFRONT_PASSWORD);
      await page.locator('button[type="submit"], input[type="submit"]').first().click();
      await page.waitForLoadState("networkidle", { timeout: 20_000 });

      if (isStorefrontPasswordUrl(page.url(), DEV_STORE_URL)) {
        throw new Error("DEV_STORE_PASSWORD was rejected by Shopify.");
      }
    }

    // Save auth state (cookies + localStorage)
    await context.storageState({ path: AUTH_FILE });
    console.info("[global-setup] Auth state saved to", AUTH_FILE);
  } catch (err) {
    console.error("[global-setup] Auth failed:", err instanceof Error ? err.message : err);
    throw err;
  } finally {
    await browser.close();
  }
}

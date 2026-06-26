/**
 * Playwright global setup — authenticates with Shopify admin OAuth.
 *
 * Logs in to the dev store, completes the app OAuth flow, and saves the
 * resulting browser state so tests can reuse it without re-authenticating.
 *
 * Required env vars (set in .env.test or CI secrets):
 *   APP_URL              — deployed app URL, e.g. https://yourapp.vercel.app
 *   DEV_STORE_URL        — Shopify dev store URL, e.g. https://hpn-test-store.myshopify.com
 *   SHOPIFY_ADMIN_EMAIL  — dev store admin email
 *   SHOPIFY_ADMIN_PASSWORD — dev store admin password
 */

import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";

const APP_URL = process.env["APP_URL"] ?? "";
const DEV_STORE_URL = process.env["DEV_STORE_URL"] ?? "";
const EMAIL = process.env["SHOPIFY_ADMIN_EMAIL"] ?? "";
const PASSWORD = process.env["SHOPIFY_ADMIN_PASSWORD"] ?? "";

export const AUTH_FILE = path.join(__dirname, ".auth", "shopify.json");

export default async function globalSetup() {
  if (!APP_URL || !DEV_STORE_URL || !EMAIL || !PASSWORD) {
    console.log("[global-setup] Skipping auth — required env vars not set.");
    return;
  }

  const authDir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("[global-setup] Starting Shopify OAuth flow...");

  try {
    // Navigate to the app — this triggers the OAuth redirect
    await page.goto(APP_URL, { waitUntil: "networkidle", timeout: 30_000 });

    // If redirected to Shopify login, fill credentials
    if (page.url().includes("accounts.shopify.com") || page.url().includes("/admin/login")) {
      console.log("[global-setup] Logging in to Shopify...");

      const emailInput = page.locator('input[type="email"], input[name="account[email]"]').first();
      if (await emailInput.isVisible({ timeout: 10_000 })) {
        await emailInput.fill(EMAIL);
        await page.locator('button[type="submit"]').first().click();
        await page.waitForTimeout(1000);
      }

      const passwordInput = page.locator('input[type="password"], input[name="account[password]"]').first();
      if (await passwordInput.isVisible({ timeout: 10_000 })) {
        await passwordInput.fill(PASSWORD);
        await page.locator('button[type="submit"]').first().click();
      }

      // Wait for OAuth redirect back to the app
      await page.waitForURL((url) => url.href.startsWith(APP_URL), { timeout: 30_000 });
      console.log("[global-setup] OAuth complete, landed at:", page.url());
    }

    // Wait for the app to finish loading
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    // Save auth state (cookies + localStorage)
    await context.storageState({ path: AUTH_FILE });
    console.log("[global-setup] Auth state saved to", AUTH_FILE);
  } catch (err) {
    console.error("[global-setup] Auth failed:", err instanceof Error ? err.message : err);
    // Don't throw — tests will run without auth and likely skip/fail gracefully
  } finally {
    await browser.close();
  }
}

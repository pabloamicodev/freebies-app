/**
 * Playwright global setup.
 *
 * storefront suite (default): unlocks the password-protected hpn-test-store
 *   Online Store once, saves the cookies, then probes that the seeded offers are
 *   live so a missing fixture fails here with an actionable message instead of
 *   as dozens of cryptic assertion errors.
 *
 * admin suite (E2E_SUITE=admin): the embedded admin only works inside the
 *   Shopify admin iframe; direct requests to APP_URL answer 410 Gone. A saved
 *   admin session is required (E2E_ADMIN_STORAGE_STATE, see docs/RUNBOOK.md).
 *
 * Env: APP_URL, DEV_STORE_URL, DEV_STORE_PASSWORD, E2E_PRODUCT_HANDLE.
 */

import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { isStorefrontPasswordUrl } from "../../app/lib/e2e-bootstrap.js";
import { gotoStorefront } from "./helpers/storefront.js";
import { assertFixtures } from "./helpers/fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, ".auth");
const AUTH_FILE = path.join(AUTH_DIR, "shopify.json");
const ADMIN_AUTH_FILE = path.join(AUTH_DIR, "admin.json");

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function adminSetup() {
  const raw = process.env["E2E_ADMIN_STORAGE_STATE"];
  if (!raw) {
    throw new Error(
      "Admin E2E needs a logged-in Shopify admin session: set E2E_ADMIN_STORAGE_STATE to the " +
        "base64 of a Playwright storageState JSON for the hpn-test-store admin. Direct requests to " +
        "APP_URL return 410 Gone because the embedded app only authenticates inside the admin iframe.",
    );
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_AUTH_FILE, Buffer.from(raw, "base64").toString("utf8"));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
    const page = await context.newPage();
    const response = await page.goto(`${process.env["APP_URL"]}/app/offers`, {
      waitUntil: "domcontentloaded",
    });
    if (response?.status() === 410) {
      throw new Error(
        "APP_URL/app/offers answered 410 Gone: admin routes are only reachable through the embedded " +
          "Shopify admin. The admin specs must drive https://admin.shopify.com/store/<shop>/apps/<app>/app/offers.",
      );
    }
  } finally {
    await browser.close();
  }
}

async function storefrontSetup() {
  const devStore = (process.env["DEV_STORE_URL"] ?? "").replace(/\/$/, "");
  const password = process.env["DEV_STORE_PASSWORD"] ?? "";
  const productHandle = process.env["E2E_PRODUCT_HANDLE"] ?? "test-product";

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
  try {
    const context = await browser.newContext({ userAgent: CHROME_UA });
    const page = await context.newPage();
    const productPath = `/products/${encodeURIComponent(productHandle)}`;

    // The password gate redirects, so go through the raw navigation rather than gotoStorefront.
    const first = await page.goto(`${devStore}${productPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (first?.status() === 429) {
      await gotoStorefront(page, productPath);
    }

    if (isStorefrontPasswordUrl(page.url(), devStore)) {
      if (!password) {
        throw new Error("The development storefront is password protected; set DEV_STORE_PASSWORD.");
      }
      await page.locator('input[name="password"]').first().fill(password);
      await Promise.all([
        page
          .waitForURL((url) => !isStorefrontPasswordUrl(url.toString(), devStore), { timeout: 20_000 })
          .catch(() => undefined),
        page.locator('button[type="submit"], input[type="submit"]').first().click(),
      ]);
      if (isStorefrontPasswordUrl(page.url(), devStore)) {
        throw new Error("DEV_STORE_PASSWORD was rejected by Shopify.");
      }
      await gotoStorefront(page, productPath);
    }

    if ((await page.title()).match(/404/i)) {
      throw new Error(`The E2E product ${productHandle} is not published to the Online Store sales channel.`);
    }

    await assertFixtures(page);
    await context.storageState({ path: AUTH_FILE });
    console.info("[global-setup] storefront unlocked and fixtures verified");
  } finally {
    await browser.close();
  }
}

export default async function globalSetup() {
  if (!process.env["APP_URL"] || !process.env["DEV_STORE_URL"]) {
    throw new Error("E2E setup requires APP_URL and DEV_STORE_URL.");
  }
  if (process.env["E2E_SUITE"] === "admin") return adminSetup();
  return storefrontSetup();
}

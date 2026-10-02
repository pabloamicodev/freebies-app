/**
 * Storefront helpers shared by every buyer-flow spec.
 *
 * Shopify's storefront bot protection answers bursts of /cart/*.js from
 * datacenter IPs with HTTP 429 and a "Verifying your connection..." HTML page.
 * Every cart call therefore goes through `storefrontFetch`, which spaces calls,
 * recognises the challenge page, backs off a bounded number of times and then
 * fails loudly. Once the runner is confirmed blocked the remaining storefront
 * tests fail fast with the same message instead of each burning minutes.
 */

import { expect, type Page } from "@playwright/test";

export const DEV_STORE = (process.env["DEV_STORE_URL"] ?? "").replace(/\/$/, "");

const MIN_GAP_MS = Number(process.env["E2E_CART_GAP_MS"] ?? 2000);
// A block lasts roughly ten minutes, so backoff only absorbs a transient throttle; sustained blocks fail fast.
const BACKOFF_MS = (process.env["E2E_BOT_BACKOFF_MS"] ?? "10000,25000,45000")
  .split(",")
  .map(Number);

export class ShopifyBotProtectionError extends Error {
  constructor(detail: string) {
    super(
      `Shopify bot protection blocked the runner (HTTP 429 "Verifying your connection..."): ${detail}. ` +
        "This is an environment block, not a product failure. Re-run later or from a different network.",
    );
    this.name = "ShopifyBotProtectionError";
  }
}

let lastCallAt = 0;
let blockedDetail: string | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function space(): Promise<void> {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

export function isBotChallenge(status: number, body: string): boolean {
  return (
    status === 429 &&
    /Verifying your connection|Your connection needs to be verified|challenge-error-text/i.test(body)
  );
}

function assertNotBlocked(): void {
  if (blockedDetail) throw new ShopifyBotProtectionError(blockedDetail);
}

/** Retry a storefront request while Shopify answers with the bot challenge. */
async function withBotBackoff<T extends { status: number; body: string }>(
  label: string,
  send: () => Promise<T>,
): Promise<T> {
  assertNotBlocked();
  for (let attempt = 0; ; attempt++) {
    await space();
    const result = await send();
    if (result.status !== 429) return result;
    const delay = BACKOFF_MS[attempt];
    if (delay === undefined) {
      blockedDetail = `${label} stayed blocked after ${attempt + 1} attempts`;
      throw new ShopifyBotProtectionError(blockedDetail);
    }
    console.warn(`[storefront] ${label} got 429; backing off ${delay}ms (attempt ${attempt + 1})`);
    await sleep(delay);
  }
}

/** Navigate to the storefront origin without touching /cart, so same-origin fetches work. */
export async function ensureStorefrontOrigin(page: Page): Promise<void> {
  if (page.url().startsWith(DEV_STORE)) return;
  await gotoStorefront(page, "/robots.txt");
}

export async function gotoStorefront(
  page: Page,
  path: string,
  options: Parameters<Page["goto"]>[1] = { waitUntil: "domcontentloaded" },
): Promise<void> {
  const url = path.startsWith("http") ? path : `${DEV_STORE}${path}`;
  const { status } = await withBotBackoff(`GET ${path}`, async () => {
    const response = await page.goto(url, options);
    const status = response?.status() ?? 0;
    return { status, body: status === 429 ? await page.content() : "" };
  });
  if (status === 404) throw new Error(`Storefront returned 404 for ${path}; the page or product does not exist.`);
  await expect(page, "Storefront redirected to /password: DEV_STORE_PASSWORD missing or rejected").not.toHaveURL(
    /\/password(?:\?|$)/,
  );
}

export async function storefrontFetch<T = unknown>(
  page: Page,
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<T> {
  await ensureStorefrontOrigin(page);
  const result = await withBotBackoff(`${init?.method ?? "GET"} ${path}`, () =>
    page.evaluate(
      async ({ path, init }) => {
        const response = await fetch(path, init);
        return { status: response.status, ok: response.ok, body: await response.text() };
      },
      { path, init },
    ),
  );
  if (result.status === 401 || /\/password/.test(result.body.slice(0, 400))) {
    throw new Error(`Storefront is password protected (${path}); DEV_STORE_PASSWORD missing or rejected.`);
  }
  if (!result.ok) throw new Error(`Cart API ${path} failed: ${result.status} ${result.body.slice(0, 300)}`);
  return JSON.parse(result.body) as T;
}

export type CartLine = {
  variant_id: number;
  quantity: number;
  original_line_price: number;
  final_line_price: number;
  properties: Record<string, string>;
  selling_plan_allocation?: unknown;
};

export type Cart = { item_count: number; items: CartLine[] };

export type AddLine = {
  id: number;
  quantity: number;
  selling_plan?: number;
  properties?: Record<string, string>;
};

export const clearCart = (page: Page) =>
  storefrontFetch<Cart>(page, "/cart/clear.js", { method: "POST" });

export const getCart = (page: Page) => storefrontFetch<Cart>(page, "/cart.js");

export async function addLines(page: Page, items: AddLine[]): Promise<Cart> {
  await storefrontFetch(page, "/cart/add.js", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ items }),
  });
  return getCart(page);
}

export async function changeLine(page: Page, line: number, quantity: number): Promise<Cart> {
  return storefrontFetch<Cart>(page, "/cart/change.js", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ line, quantity }),
  });
}

export async function waitForPromoEngine(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(() => typeof (window as { PromoEngine?: unknown }).PromoEngine !== "undefined", undefined, {
    timeout,
  });
}

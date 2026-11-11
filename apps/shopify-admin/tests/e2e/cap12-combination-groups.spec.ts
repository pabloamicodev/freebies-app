/**
 * FIX-cap-12 dev-store proof (cases g-j): how Shopify resolves discounts across our shard nodes that carry different
 * combinesWith, observed on hpn-test-store. Needs the offers of `pnpm tsx scripts/seed-cap12-e2e.ts seed`; the seed writes
 * fixtures/cap12-seed.json, and without that marker the whole file is skipped so a normal E2E run is unaffected.
 *
 * Layout the seed forces (each node holds one combination group):
 *   NC node  = "[CAP12 E2E] NC gift" (anchor product -> free gift) + a heavy inert NC filler, combinesWith all false
 *   C node 1 = "[CAP12 E2E] C 20% product A"      combinesWith all true
 *   C node 2 = "[CAP12 E2E] C 10% product B"      combinesWith all true
 *   native   = code CAP12E2E, 50% off the "code product", combinesWith productDiscounts true
 * Carts are built through the cart API; every case attaches the raw cart JSON so the numbers are in the report.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

import {
  addLines,
  clearCart,
  gotoStorefront,
  storefrontFetch,
  waitForPromoEngine,
} from "./helpers/storefront.js";

const MARKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cap12-seed.json");

interface SeedProduct {
  handle: string;
  variantId: string;
  price: number;
}
interface Seed {
  /** true when the seed ran with storefront.remove_unfunded_gifts on: losing auto-added gifts are removed by the runtime. */
  unfunded?: boolean;
  code: string;
  percent: { cA: number; cB: number; code: number };
  products: { gift: SeedProduct; ncAnchor: SeedProduct; cA: SeedProduct; cB: SeedProduct; codeProduct: SeedProduct };
  nodes: Array<{ slot: number; combinesWith: string; units: string[] }>;
}

const seed: Seed | null = existsSync(MARKER) ? (JSON.parse(readFileSync(MARKER, "utf8")) as Seed) : null;

interface RawLine {
  variant_id: number;
  quantity: number;
  original_line_price: number;
  final_line_price: number;
  total_discount: number;
  properties: Record<string, string> | null;
  discounts?: Array<{ title: string; amount: number }>;
}
interface RawCart {
  items: RawLine[];
  total_discount: number;
  cart_level_discount_applications?: Array<{ title: string; total_allocated_amount: number }>;
}

const variantNumber = (gid: string) => Number(gid.split("/").pop());
const isGift = (line: RawLine) => line.properties?.["_promo_engine_line_type"] === "gift";
const TOLERANCE_CENTS = 2;

const readCart = (page: Page) => storefrontFetch<RawCart>(page, "/cart.js");
const lineOf = (cart: RawCart, product: SeedProduct) =>
  cart.items.find((line) => line.variant_id === variantNumber(product.variantId) && !isGift(line));
const giftLine = (cart: RawCart) => cart.items.find(isGift);
const discountOf = (line: RawLine | undefined) => (line ? line.original_line_price - line.final_line_price : 0);

async function record(name: string, cart: RawCart, expectation: string): Promise<void> {
  const summary = cart.items.map((line) => ({
    variant: line.variant_id,
    gift: isGift(line),
    qty: line.quantity,
    original: line.original_line_price,
    final: line.final_line_price,
    discounts: line.discounts,
  }));
  console.info(`[cap12:${name}] expected: ${expectation}\n[cap12:${name}] observed: ${JSON.stringify({ total_discount: cart.total_discount, summary, cartLevel: cart.cart_level_discount_applications })}`);
  await test.info().attach(`${name}.json`, { body: JSON.stringify({ expectation, cart }, null, 2), contentType: "application/json" });
}

async function openWithEmptyCart(page: Page): Promise<void> {
  // The product page loads the storefront runtime that auto-adds the gift, exactly as in gift-offer.spec.
  await gotoStorefront(page, `/products/${encodeURIComponent(seed!.products.ncAnchor.handle)}`);
  await waitForPromoEngine(page);
  await clearCart(page);
}

/** Polls until the cart stops changing (discount allocation and auto-added gift both settle asynchronously). */
async function settledCart(page: Page, wantGift: boolean): Promise<RawCart> {
  let last = "";
  let stable = 0;
  let cart = await readCart(page);
  for (let attempt = 0; attempt < 20; attempt++) {
    cart = await readCart(page);
    const fingerprint = JSON.stringify(cart.items.map((line) => [line.variant_id, line.quantity, line.final_line_price]));
    stable = fingerprint === last ? stable + 1 : 0;
    last = fingerprint;
    if ((giftLine(cart) !== undefined) === wantGift && stable >= 2) return cart;
    await page.waitForTimeout(2_000);
  }
  return cart;
}

/** Waits until the cart has no gift line (the runtime removes a gift Shopify did not discount). */
async function goneGift(page: Page): Promise<RawCart> {
  let cart = await readCart(page);
  for (let attempt = 0; attempt < 20 && giftLine(cart); attempt++) {
    await page.waitForTimeout(2_000);
    cart = await readCart(page);
  }
  return cart;
}

async function applyCode(page: Page, code: string, watch: SeedProduct): Promise<RawCart> {
  await storefrontFetch(page, "/cart/update.js", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ discount: code }),
  });
  let cart = await readCart(page);
  if (discountOf(lineOf(cart, watch)) === 0) {
    // Fallback to the permalink the customer-facing flow uses.
    await gotoStorefront(page, `/discount/${encodeURIComponent(code)}?redirect=%2Fcart`);
    cart = await readCart(page);
  }
  return cart;
}

const near = (actual: number, expected: number) => Math.abs(actual - expected) <= TOLERANCE_CENTS;

test.describe("FIX-cap-12 combination groups on hpn-test-store", () => {
  test.skip(!seed, "No cap12 seed marker: run scripts/seed-cap12-e2e.ts seed first.");

  test.beforeAll(() => {
    const policies = new Set(seed!.nodes.map((node) => node.combinesWith));
    expect(seed!.nodes.length, "seed must have forced at least 3 nodes").toBeGreaterThanOrEqual(3);
    expect(policies.size, "seed must have forced at least 2 combination groups").toBeGreaterThanOrEqual(2);
  });

  test.beforeEach(async ({ page }) => openWithEmptyCart(page));

  test("(d0) control: a single combining offer applies on its own", async ({ page }) => {
    const { cA } = seed!.products;
    await addLines(page, [{ id: variantNumber(cA.variantId), quantity: 1 }]);
    const cart = await settledCart(page, false);
    await record("d0", cart, `A -${seed!.percent.cA}% alone`);
    const a = lineOf(cart, cA)!;
    expect(near(discountOf(a), Math.round(a.original_line_price * seed!.percent.cA / 100)), "line A discount").toBe(true);
  });

  test("(d1) control: the other combining offer applies on its own", async ({ page }) => {
    const { cB } = seed!.products;
    await addLines(page, [{ id: variantNumber(cB.variantId), quantity: 1 }]);
    const cart = await settledCart(page, false);
    await record("d1", cart, `B -${seed!.percent.cB}% alone`);
    const b = lineOf(cart, cB)!;
    expect(near(discountOf(b), Math.round(b.original_line_price * seed!.percent.cB / 100)), "line B discount").toBe(true);
  });

  test("(j) two combining offers in different nodes, different lines: both apply", async ({ page }) => {
    const { cA, cB } = seed!.products;
    await addLines(page, [
      { id: variantNumber(cA.variantId), quantity: 1 },
      { id: variantNumber(cB.variantId), quantity: 1 },
    ]);
    const cart = await settledCart(page, false);
    await record("j", cart, `A -${seed!.percent.cA}% and B -${seed!.percent.cB}% together`);
    const a = lineOf(cart, cA)!;
    const b = lineOf(cart, cB)!;
    expect(near(discountOf(a), Math.round(a.original_line_price * seed!.percent.cA / 100)), "line A discount").toBe(true);
    expect(near(discountOf(b), Math.round(b.original_line_price * seed!.percent.cB / 100)), "line B discount").toBe(true);
  });

  test("(g1) NC gift and a smaller combining % offer in different nodes: the gift (better) wins alone", async ({ page }) => {
    const { ncAnchor, cA, gift } = seed!.products;
    await addLines(page, [
      { id: variantNumber(ncAnchor.variantId), quantity: 1 },
      { id: variantNumber(cA.variantId), quantity: 1 },
    ]);
    const cart = await settledCart(page, true);
    const giftValue = Math.round(gift.price * 100);
    const cValue = Math.round(cA.price * 100 * seed!.percent.cA / 100);
    await record("g1", cart, `gift (${giftValue}c) beats A -20% (${cValue}c): gift free, A undiscounted`);
    const g = giftLine(cart);
    const a = lineOf(cart, cA)!;
    expect(g, "the NC gift must have been auto-added").toBeTruthy();
    expect(g!.final_line_price, "gift line").toBe(0);
    expect(discountOf(a), "combining offer must not stack with the non-combining gift").toBe(0);
  });

  test("(g2) NC gift and a larger combining % offer in different nodes: the % offer wins alone", async ({ page }) => {
    const { ncAnchor, cA, gift } = seed!.products;
    const giftValue = Math.round(gift.price * 100);
    const quantity = Math.max(2, Math.ceil((giftValue * 1.5) / (cA.price * 100 * (seed!.percent.cA / 100))));
    await addLines(page, [
      { id: variantNumber(ncAnchor.variantId), quantity: 1 },
      { id: variantNumber(cA.variantId), quantity },
    ]);
    const cart = await settledCart(page, true);
    const a = lineOf(cart, cA)!;
    const cValue = Math.round(a.original_line_price * seed!.percent.cA / 100);
    await record("g2", cart, `A x${quantity} -20% (${cValue}c) beats gift (${giftValue}c): A discounted, gift line full price`);
    expect(cValue, "case construction: combining offer must be the bigger one").toBeGreaterThan(giftValue);
    expect(near(discountOf(a), cValue), "combining offer applies").toBe(true);
    if (seed!.unfunded) {
      const after = await goneGift(page);
      await record("g2-unfunded", after, "gift line removed, A discount intact");
      expect(giftLine(after), "unfunded gift is removed").toBeUndefined();
      expect(near(discountOf(lineOf(after, cA)), cValue), "winning % offer intact").toBe(true);
      return;
    }
    const g = giftLine(cart);
    expect(g, "the engine still adds the gift line").toBeTruthy();
    expect(discountOf(g), "non-combining gift loses best-of").toBe(0);
  });

  test("(h) combining offer + native product code that combines: both apply", async ({ page }) => {
    const { cA, codeProduct } = seed!.products;
    await addLines(page, [
      { id: variantNumber(cA.variantId), quantity: 1 },
      { id: variantNumber(codeProduct.variantId), quantity: 1 },
    ]);
    await settledCart(page, false);
    const cart = await applyCode(page, seed!.code, codeProduct);
    await record("h", cart, `A -20% (offer node) and code product -${seed!.percent.code}% (native code) together`);
    const a = lineOf(cart, cA)!;
    const c = lineOf(cart, codeProduct)!;
    expect(near(discountOf(c), Math.round(c.original_line_price * seed!.percent.code / 100)), "native code applies").toBe(true);
    expect(near(discountOf(a), Math.round(a.original_line_price * seed!.percent.cA / 100)), "combining offer still applies").toBe(true);
  });

  test("(i) non-combining gift + the same native code: best-of, never both", async ({ page }) => {
    const { ncAnchor, codeProduct, gift } = seed!.products;
    await addLines(page, [
      { id: variantNumber(ncAnchor.variantId), quantity: 1 },
      { id: variantNumber(codeProduct.variantId), quantity: 1 },
    ]);
    await settledCart(page, true);
    const cart = await applyCode(page, seed!.code, codeProduct);
    const c = lineOf(cart, codeProduct)!;
    const codeValue = Math.round(c.original_line_price * seed!.percent.code / 100);
    const giftValue = Math.round(gift.price * 100);
    await record("i", cart, `code (${codeValue}c) vs NC gift (${giftValue}c): exactly one applies`);
    if (seed!.unfunded) {
      const after = await goneGift(page);
      await record("i-unfunded", after, "gift line removed, code discount intact");
      expect(giftLine(after), "unfunded gift is removed").toBeUndefined();
      expect(near(discountOf(lineOf(after, codeProduct)), codeValue), "code discount intact").toBe(true);
      // Removing the code frees the gift again once the cart changes.
      await storefrontFetch(page, "/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ discount: "" }),
      });
      const line = lineOf(await readCart(page), codeProduct)!;
      await storefrontFetch(page, "/cart/change.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id: String(line.variant_id), quantity: 2 }),
      });
      const back = await settledCart(page, true);
      await record("i-code-removed", back, "gift back and free (NC gift is the only discount)");
      expect(giftLine(back), "gift returns").toBeTruthy();
      expect(giftLine(back)!.final_line_price, "gift free again").toBe(0);
      return;
    }
    const g = giftLine(cart);
    expect(g, "the engine adds the gift line").toBeTruthy();
    const codeApplied = discountOf(c) > 0;
    const giftApplied = discountOf(g) > 0;
    expect(codeApplied !== giftApplied, `exactly one of code/gift applies (code=${codeApplied}, gift=${giftApplied})`).toBe(true);
    expect(codeApplied, "the code (bigger) is the one that wins").toBe(codeValue > giftValue);
  });
});

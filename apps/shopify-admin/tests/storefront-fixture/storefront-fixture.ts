import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";

/**
 * A fake storefront for the real storefront runtime: the committed theme-extension bundles are served from disk and the Ajax cart, the
 * product stock endpoint and the app-proxy `evaluate` call are answered here, so no store, no Shopify and no sign-in is involved.
 * Every request goes through `page.route`, so the fake origin never resolves in DNS.
 */
const ORIGIN = "http://shop.fixture.test";
const ASSETS = fileURLToPath(new URL("../../extensions/theme-extension/assets/", import.meta.url));

export const GIFT_OFFER_ID = "offer-gift";
export const PROGRESS_OFFER_ID = "offer-progress";

export interface FixtureOptions {
  /** The evaluation returns a gift picker (it opens by itself once, like a shopper whose cart just qualified). */
  gift?: boolean;
  /** Theme blocks placed in `<main>`. */
  blocks?: string;
  /** Extra HTML after the blocks (e.g. a trigger button). */
  body?: string;
  /** A Dawn-like cart drawer (closed) and an add-to-cart button that opens it, as the theme does after its own cart request. */
  drawer?: boolean;
}

export interface StorefrontState {
  /** Cart total in whole currency units; changing it changes the cart hash, which is what makes the runtime evaluate again. */
  total: number;
  percent: number;
  message: string;
  goal: boolean;
  /** Next POST /cart/add.js answers this instead of succeeding. */
  addFailure: { status: number; body: unknown } | null;
  cartAdds: number;
  /** The cart qualifies for the gift offer (with `drawer`, it starts below the threshold until the shopper adds the paid product). */
  eligible: boolean;
  /** Cart lines; the gift lines are the ones added from the picker. */
  lines: Array<Record<string, unknown>>;
  /** POST /cart/change.js calls: the drawer's quantity buttons. */
  cartChanges: number;
  /** Variant ids in the cart when the shopper reached /checkout, or null before. */
  checkedOut: unknown[] | null;
}

const GIFTS = [
  { rewardId: "r1", variant: 101, handle: "canvas-tote", title: "Canvas tote" },
  { rewardId: "r1", variant: 102, handle: "enamel-pin", title: "Enamel pin" },
];

function giftPayload(selected: Set<number>) {
  return {
    offerId: GIFT_OFFER_ID,
    title: "Choose your free gift",
    subtitle: "Pick one, it is on us.",
    currencyCode: "USD",
    maxSelectableCount: 1,
    alreadySelectedCount: selected.size,
    selectableGifts: GIFTS.map((g) => ({
      rewardId: g.rewardId,
      offerVersion: 1,
      rewardMaxQuantity: 1,
      variantId: `gid://shopify/ProductVariant/${g.variant}`,
      productId: `gid://shopify/Product/${g.variant}`,
      title: g.title,
      variantTitle: null,
      imageUrl: null,
      originalPriceCents: 2400,
      discountedPriceCents: 0,
      isAvailable: true,
      isSelected: selected.has(g.variant),
      productHandle: g.handle,
    })),
  };
}

const QTY_SCRIPT = `document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest("#plus")) return;
  fetch("/cart/change.js", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "paid:k", quantity: 2 }) })
    .then(() => { document.getElementById("qty").textContent = String(Number(document.getElementById("qty").textContent) + 1); });
});`;

// What Dawn renders: a custom element that becomes visible with the `active` class, items in a form, a footer after it.
const DRAWER = `<button type="button" id="atc">Add to cart</button>
<cart-drawer class="drawer"><div class="drawer__inner"><cart-drawer-items><form id="CartDrawer-Form" action="/cart" method="post"><p>Quantity <span id="qty">1</span></p><button type="button" id="plus" aria-label="Increase quantity">+</button></form></cart-drawer-items><div class="drawer__footer"><p>Subtotal</p><button type="submit" name="checkout" id="co" form="CartDrawer-Form">Check out</button></div></div></cart-drawer>
<style>cart-drawer{display:block;position:fixed;top:0;right:0;width:360px;height:100%;background:#fff;box-shadow:0 0 8px #0006;visibility:hidden;transform:translateX(100%);z-index:1000}cart-drawer.active{visibility:visible;transform:none}</style>
<script>${QTY_SCRIPT}
document.getElementById("atc").addEventListener("click", () => {
  fetch("/cart/add.js", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ id: 900, quantity: 1 }] }) })
    .then(() => document.querySelector("cart-drawer").classList.add("active"));
});</script>`;

const CART_PAGE = `<form action="/cart" method="post" id="cart"><p>Quantity <span id="qty">1</span></p><button type="button" id="plus" aria-label="Increase quantity">+</button></form><div class="cart__footer"><p>Subtotal</p><button type="submit" name="checkout" id="co" form="cart">Check out</button></div><script>${QTY_SCRIPT}</script>`;

function pageHtml(options: FixtureOptions, cartPage = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture storefront</title>
<style>body{margin:0;font-family:system-ui,sans-serif;color:#111;background:#fff}main{max-width:720px;margin:0 auto;padding:24px}</style>
<script>
window.Shopify = { routes: { root: "/" } };
window.__promoEngineConfig = { shopDomain: "fixture.myshopify.com", locale: "en", currency: "USD", debug: false, debounceMs: 0, cartItemCount: 1 };
</script>
<script src="/assets/promo-engine.js" defer></script></head>
<body><header><a href="/">Fixture store</a></header>
<main id="main"><h1>Fixture storefront</h1>${options.blocks ?? ""}${options.body ?? ""}${cartPage ? CART_PAGE : ""}</main>${options.drawer ? DRAWER : ""}</body></html>`;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Installs the fake storefront on `page` and returns the state the specs change between evaluations. */
export async function installStorefront(page: Page, options: FixtureOptions = {}): Promise<StorefrontState> {
  const lines: Array<Record<string, unknown>> = [];
  const state: StorefrontState = { total: 40, percent: 50, message: "Add $40.00 more for a free gift", goal: false, addFailure: null, cartAdds: 0, eligible: !options.drawer, lines, cartChanges: 0, checkedOut: null };
  const owed = () => Boolean(options.gift) && state.eligible;
  const selected = () => new Set(GIFTS.filter((g) => lines.some((line) => line["variant_id"] === g.variant)).map((g) => g.variant));
  const cart = () => ({ token: "fixture", id: null, items: lines, total_price: state.total, items_subtotal_price: state.total, currency: "USD", item_count: lines.length + 1 });
  const evaluation = () => ({
    requestId: "r",
    cartHash: String(state.total),
    qualifiedOffers: owed() ? [{ offerId: GIFT_OFFER_ID, offerVersion: 1, type: "gift", qualified: true, reasons: [], cartActions: [], discountCodesToAdd: [], discountCodesToRemove: [] }] : [],
    disqualifiedOffers: [],
    cartActions: [],
    discountCodes: { add: [], remove: [] },
    giftSlider: owed() ? giftPayload(selected()) : null,
    cartMessages: [{ offerId: PROGRESS_OFFER_ID, widgetId: "", type: state.goal ? "success" : "progress", message: state.message, priority: 1 }],
    progressBars: [
      {
        offerId: PROGRESS_OFFER_ID,
        widgetId: "",
        currentCents: state.total * 100,
        targetCents: 8000,
        currentQuantity: 1,
        targetQuantity: null,
        progressPercent: state.percent,
        messageBeforeGoal: state.message,
        messageAfterGoal: state.message,
        isGoalReached: state.goal,
      },
    ],
    upsells: [],
    warnings: [],
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  });

  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(options) });
    if (pathname.startsWith("/assets/")) return route.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(ASSETS + pathname.slice("/assets/".length), "utf8") });
    if (pathname === "/cart.js") return json(route, cart());
    if (pathname === "/cart/add.js") {
      if (state.addFailure) {
        const failure = state.addFailure;
        state.addFailure = null;
        return json(route, failure.body, failure.status);
      }
      const body = request.postDataJSON() as { items?: Array<{ id: number; quantity: number; properties?: Record<string, string> }> };
      for (const item of body.items ?? []) {
        const gift = GIFTS.find((g) => g.variant === item.id);
        if (!gift) {
          state.eligible = true;
          lines.push({ key: "paid:k", variant_id: item.id, product_id: item.id, quantity: item.quantity, price: 4000, final_price: 4000, line_price: 4000, final_line_price: 4000, properties: null, handle: "paid", title: "Paid product", variant_title: null, vendor: "", product_type: "", tags: "", requires_selling_plan: false, selling_plan_allocation: null, available: true, inventory_quantity: 5, inventory_policy: "deny" });
          continue;
        }
        state.cartAdds++;
        lines.push({ key: `${item.id}:k`, variant_id: item.id, product_id: item.id, quantity: item.quantity, price: 0, final_price: 0, line_price: 0, final_line_price: 0, properties: item.properties ?? null, handle: gift?.handle ?? "", title: gift?.title ?? "", variant_title: null, vendor: "", product_type: "", tags: "", requires_selling_plan: false, selling_plan_allocation: null, available: true, inventory_quantity: 5, inventory_policy: "deny" });
      }
      return json(route, { items: lines });
    }
    // The cart form posts here with name=checkout; Shopify answers with a redirect to the checkout.
    if (pathname === "/cart" && request.method() === "POST") return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><script>location.replace("/checkout")</script>` });
    if (pathname === "/checkout") {
      state.checkedOut = lines.map((line) => line["variant_id"]);
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Checkout</title><h1>Checkout</h1>" });
    }
    if (pathname === "/cart") return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(options, true) });
    if (pathname === "/cart/change.js") {
      state.cartChanges++;
      const change = request.postDataJSON() as { id?: string; quantity?: number };
      for (const line of lines) if (line["key"] === change.id) line["quantity"] = change.quantity;
      return json(route, cart());
    }
    if (pathname === "/cart/update.js") {
      const { updates } = request.postDataJSON() as { updates?: Record<string, number> };
      for (const [key, quantity] of Object.entries(updates ?? {})) if (quantity === 0) lines.splice(0, lines.length, ...lines.filter((line) => line["key"] !== key));
      return json(route, cart());
    }
    if (pathname.startsWith("/cart/")) return json(route, cart());
    const product = /^\/products\/([\w-]+)\.js$/.exec(pathname);
    if (product) return json(route, { variants: GIFTS.filter((g) => g.handle === product[1]).map((g) => ({ id: g.variant, available: true })) });
    if (pathname === "/apps/promo-engine/evaluate") return json(route, evaluation());
    return route.fulfill({ status: 404, body: "{}" });
  });
  return state;
}

export const STOREFRONT_URL = `${ORIGIN}/`;

/** Moves the cart so the next evaluation is not skipped as "cart unchanged", then evaluates. */
export async function reevaluate(page: Page, state: StorefrontState, change: Partial<StorefrontState>): Promise<void> {
  Object.assign(state, change, { total: state.total + 1 });
  await page.evaluate(() => (window as unknown as { PromoEngine: { evaluate: () => Promise<unknown> } }).PromoEngine.evaluate());
}

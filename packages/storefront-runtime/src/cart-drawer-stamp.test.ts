// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { browserPageUrl, installPromoMetadataBridge, packCartAddRequest } from "./metadata-bridge.js";

const stampedPage = async (): Promise<string> => {
  const [, init] = await packCartAddRequest("/cart/add.js", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ id: 1, quantity: 1 }] }),
  });
  const body = JSON.parse(String(init?.body)) as { items: Array<{ properties: Record<string, string> }> };
  return JSON.parse(body.items[0]!.properties["_promo_engine_metadata"]!)["_promo_page_url"] as string;
};

describe("add from inside the cart drawer is page type cart", () => {
  beforeAll(() => {
    window.history.replaceState({}, "", "/products/planta");
    document.body.innerHTML = `
      <button id="outside">Add to cart</button>
      <cart-drawer><div id="CartDrawer" class="cart-drawer"><form id="qa"><button id="inside" type="button">Add</button></form></div></cart-drawer>
      <div class="drawer--cart"><button id="alt">Add</button></div>
      <aside aria-label="Shopping cart"><button id="aside">Add</button></aside>`;
    installPromoMetadataBridge();
  });
  afterEach(() => vi.useRealTimers());

  it("stamps /cart for a click inside the drawer, for 2 s, then reverts to the page", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    document.getElementById("inside")!.click();
    expect(await stampedPage()).toBe("/cart");
    vi.advanceTimersByTime(2100);
    expect(await stampedPage()).toBe("/products/planta");
  });

  it("stamps /cart for the other known drawer containers", async () => {
    for (const [n, id] of ["alt", "aside"].entries()) {
      vi.useFakeTimers({ now: Date.now() + 10_000 * (n + 1), toFake: ["Date"] });
      expect(browserPageUrl()).toBe("/products/planta");
      document.getElementById(id)!.click();
      expect(browserPageUrl()).toBe("/cart");
      vi.useRealTimers();
    }
  });

  it("an add made outside the drawer keeps the real page", async () => {
    vi.useFakeTimers({ now: Date.now() + 100_000, toFake: ["Date"] });
    document.getElementById("outside")!.click();
    expect(await stampedPage()).toBe("/products/planta");
  });
});

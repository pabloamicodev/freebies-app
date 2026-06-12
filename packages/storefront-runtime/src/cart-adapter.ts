/**
 * Cart adapter — abstracts over:
 * 1. Shopify Ajax Cart API (standard themes)
 * 2. Shopify Storefront API (headless)
 *
 * All mutations are queued to prevent race conditions.
 */

export interface CartLineAdd {
  variantId: string;
  quantity: number;
  properties: Record<string, string>;
}

export interface CartLineUpdate {
  /** Ajax Cart API line key */
  key?: string;
  /** Storefront API line ID */
  lineId?: string;
  quantity: number;
  properties?: Record<string, string>;
}

export interface CartLineRemove {
  key?: string;
  lineId?: string;
}

export interface CartData {
  token: string | null;
  id: string | null;
  items: CartItem[];
  total_price: number;
  currency: string;
  item_count: number;
  discount_codes?: Array<{ code: string }>;
}

export interface CartItem {
  key: string;
  variant_id: number;
  product_id: number;
  quantity: number;
  price: number;
  properties: Record<string, string>;
  handle: string;
  title: string;
  variant_title: string | null;
  vendor: string;
  product_type: string;
  tags: string;
  requires_selling_plan: boolean;
  selling_plan_allocation: unknown;
  available: boolean;
  inventory_quantity: number;
  inventory_policy: string;
}

// ─── Ajax Cart Adapter ────────────────────────────────────────────────────────

let mutationQueue = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    mutationQueue = mutationQueue
      .then(fn)
      .then(resolve, reject);
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cart API error ${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

export const AjaxCartAdapter = {
  async getCart(): Promise<CartData> {
    return fetchJson<CartData>(`${window.Shopify?.routes?.root ?? "/"}cart.js`);
  },

  async addLines(lines: CartLineAdd[]): Promise<CartData> {
    return enqueue(() =>
      fetchJson<CartData>(`${window.Shopify?.routes?.root ?? "/"}cart/add.js`, {
        method: "POST",
        body: JSON.stringify({
          items: lines.map((l) => ({
            id: parseInt(l.variantId.split("/").pop() ?? l.variantId, 10),
            quantity: l.quantity,
            properties: l.properties,
          })),
        }),
      }),
    );
  },

  async updateLine(line: CartLineUpdate): Promise<CartData> {
    return enqueue(() =>
      fetchJson<CartData>(`${window.Shopify?.routes?.root ?? "/"}cart/change.js`, {
        method: "POST",
        body: JSON.stringify({
          id: line.key,
          quantity: line.quantity,
          ...(line.properties ? { properties: line.properties } : {}),
        }),
      }),
    );
  },

  async removeLine(line: CartLineRemove): Promise<CartData> {
    return enqueue(() =>
      fetchJson<CartData>(`${window.Shopify?.routes?.root ?? "/"}cart/change.js`, {
        method: "POST",
        body: JSON.stringify({ id: line.key, quantity: 0 }),
      }),
    );
  },

  async applyDiscountCode(code: string): Promise<CartData> {
    return enqueue(() =>
      fetchJson<CartData>(`${window.Shopify?.routes?.root ?? "/"}cart/update.js`, {
        method: "POST",
        body: JSON.stringify({ discount: code }),
      }),
    );
  },

  async removeDiscountCode(): Promise<CartData> {
    return enqueue(() =>
      fetchJson<CartData>(`${window.Shopify?.routes?.root ?? "/"}cart/update.js`, {
        method: "POST",
        body: JSON.stringify({ discount: "" }),
      }),
    );
  },
};

declare global {
  interface Window {
    Shopify?: {
      routes?: { root?: string };
      locale?: string;
      currency?: { active: string; rate: string };
      shop?: string;
      country?: string;
    };
  }
}

/**
 * Storefront API adapter — for headless/Hydrogen storefronts.
 * Uses Shopify Storefront API cartLines mutations.
 *
 * IMPORTANT: Always pass ALL attributes on every cartLinesUpdate call
 * or Shopify will silently drop attributes not included in the mutation.
 */

export interface StorefrontCartLine {
  id: string;
  quantity: number;
  merchandise: { id: string };
  attributes: Array<{ key: string; value: string }>;
  cost: {
    amountPerQuantity: { amount: string; currencyCode: string };
    subtotalAmount: { amount: string; currencyCode: string };
  };
}

export interface StorefrontCart {
  id: string;
  checkoutUrl: string;
  lines: { nodes: StorefrontCartLine[] };
  cost: {
    subtotalAmount: { amount: string; currencyCode: string };
    totalAmount: { amount: string; currencyCode: string };
  };
  discountCodes: Array<{ code: string; applicable: boolean }>;
  buyerIdentity: {
    countryCode: string | null;
    customer: { id: string } | null;
  };
}

export class StorefrontApiAdapter {
  private endpoint: string;
  private token: string;
  private cartId: string | null = null;
  private readonly CART_ID_KEY = "promo_engine_cart_id";

  constructor(storeDomain: string, storefrontToken: string) {
    this.endpoint = `https://${storeDomain}/api/2026-01/graphql.json`;
    this.token = storefrontToken;
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": this.token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Storefront API error: ${response.status}`);
    const data = (await response.json()) as { data: T; errors?: Array<{ message: string }> };
    if (data.errors?.length) throw new Error(data.errors[0]!.message);
    return data.data;
  }

  private getStoredCartId(): string | null {
    try {
      return localStorage.getItem(this.CART_ID_KEY);
    } catch {
      return null;
    }
  }

  private storeCartId(id: string) {
    try {
      localStorage.setItem(this.CART_ID_KEY, id);
    } catch {}
  }

  async getOrCreateCart(): Promise<StorefrontCart> {
    const storedId = this.getStoredCartId();
    if (storedId) {
      try {
        const cart = await this.fetchCart(storedId);
        if (cart) { this.cartId = storedId; return cart; }
      } catch {}
    }
    return this.createCart();
  }

  private async fetchCart(cartId: string): Promise<StorefrontCart | null> {
    const data = await this.gql<{ cart: StorefrontCart | null }>(
      `query GetCart($cartId: ID!) {
        cart(id: $cartId) {
          id checkoutUrl
          lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
            cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
          }}
          cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
          discountCodes { code applicable }
          buyerIdentity { countryCode customer { id } }
        }
      }`,
      { cartId },
    );
    return data.cart;
  }

  async createCart(): Promise<StorefrontCart> {
    const data = await this.gql<{ cartCreate: { cart: StorefrontCart } }>(
      `mutation CartCreate {
        cartCreate {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,
    );
    const cart = data.cartCreate.cart;
    this.cartId = cart.id;
    this.storeCartId(cart.id);
    return cart;
  }

  async addLines(
    lines: Array<{ merchandiseId: string; quantity: number; attributes?: Record<string, string> }>,
  ): Promise<StorefrontCart> {
    const cartId = this.cartId ?? (await this.getOrCreateCart()).id;
    const data = await this.gql<{ cartLinesAdd: { cart: StorefrontCart } }>(
      `mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,
      {
        cartId,
        lines: lines.map((l) => ({
          merchandiseId: l.merchandiseId,
          quantity: l.quantity,
          attributes: Object.entries(l.attributes ?? {}).map(([key, value]) => ({ key, value })),
        })),
      },
    );
    return data.cartLinesAdd.cart;
  }

  async updateLines(
    updates: Array<{
      id: string;
      quantity: number;
      /** MUST pass ALL existing attributes or they will be lost. */
      attributes: Record<string, string>;
    }>,
  ): Promise<StorefrontCart> {
    if (!this.cartId) throw new Error("No active cart");
    const data = await this.gql<{ cartLinesUpdate: { cart: StorefrontCart } }>(
      `mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
        cartLinesUpdate(cartId: $cartId, lines: $lines) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,
      {
        cartId: this.cartId,
        lines: updates.map((u) => ({
          id: u.id,
          quantity: u.quantity,
          attributes: Object.entries(u.attributes).map(([key, value]) => ({ key, value })),
        })),
      },
    );
    return data.cartLinesUpdate.cart;
  }

  async removeLines(lineIds: string[]): Promise<StorefrontCart> {
    if (!this.cartId) throw new Error("No active cart");
    const data = await this.gql<{ cartLinesRemove: { cart: StorefrontCart } }>(
      `mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
        cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,
      { cartId: this.cartId, lineIds },
    );
    return data.cartLinesRemove.cart;
  }

  async applyDiscountCodes(codes: string[]): Promise<StorefrontCart> {
    if (!this.cartId) throw new Error("No active cart");
    const data = await this.gql<{ cartDiscountCodesUpdate: { cart: StorefrontCart } }>(
      `mutation CartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]!) {
        cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
          cart { id discountCodes { code applicable } }
        }
      }`,
      { cartId: this.cartId, discountCodes: codes },
    );
    return data.cartDiscountCodesUpdate.cart;
  }

  async updateBuyerIdentity(countryCode: string, customerAccessToken?: string): Promise<StorefrontCart> {
    if (!this.cartId) throw new Error("No active cart");
    const data = await this.gql<{ cartBuyerIdentityUpdate: { cart: StorefrontCart } }>(
      `mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
        cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
          cart { id buyerIdentity { countryCode customer { id } } }
        }
      }`,
      {
        cartId: this.cartId,
        buyerIdentity: {
          countryCode,
          ...(customerAccessToken ? { customerAccessToken } : {}),
        },
      },
    );
    return data.cartBuyerIdentityUpdate.cart;
  }
}

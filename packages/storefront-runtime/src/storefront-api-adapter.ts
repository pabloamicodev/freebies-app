/**
 * Storefront API adapter — for headless/Hydrogen storefronts.
 * Uses Shopify Storefront API cartLines mutations.
 *
 * IMPORTANT: Always pass ALL attributes on every cartLinesUpdate call
 * or Shopify will silently drop attributes not included in the mutation.
 */

import { SHOPIFY_API_VERSION } from "@promo/shared-types";
import { withPromoMetadata } from "./metadata-bridge.js";

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

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
  lines: { nodes: StorefrontCartLine[]; pageInfo: PageInfo };
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

interface CartUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

interface CartMutationPayload {
  cart: StorefrontCart | null;
  userErrors: CartUserError[];
}

const CART_FIELDS = `
  id checkoutUrl
  lines(first: 250) {
    nodes {
      id quantity merchandise { ... on ProductVariant { id } }
      attributes { key value }
      cost {
        amountPerQuantity { amount currencyCode }
        subtotalAmount { amount currencyCode }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
  cost {
    subtotalAmount { amount currencyCode }
    totalAmount { amount currencyCode }
  }
  discountCodes { code applicable }
  buyerIdentity { countryCode customer { id } }
`;

const CART_LINES_PAGE_QUERY = `
  query PromoCartLinesPage($cartId: ID!, $after: String!) {
    cart(id: $cartId) {
      lines(first: 250, after: $after) {
        nodes {
          id quantity merchandise { ... on ProductVariant { id } }
          attributes { key value }
          cost {
            amountPerQuantity { amount currencyCode }
            subtotalAmount { amount currencyCode }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export class StorefrontApiAdapter {
  private endpoint: string;
  private token: string;
  private cartId: string | null = null;
  private readonly CART_ID_KEY = "promo_engine_cart_id";

  constructor(storeDomain: string, storefrontToken: string) {
    const domain = storeDomain.trim().toLowerCase();
    const parsed = new URL(`https://${domain}`);
    if (parsed.hostname !== domain || parsed.port || parsed.username || parsed.password) {
      throw new Error("Invalid Shopify store domain");
    }
    this.endpoint = `https://${domain}/api/${SHOPIFY_API_VERSION}/graphql.json`;
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
    const data = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (data.errors?.length) throw new Error(data.errors[0]!.message);
    if (!data.data) throw new Error("Storefront API returned no data");
    return data.data;
  }

  private async hydrateCartLines(cart: StorefrontCart): Promise<StorefrontCart> {
    const nodes = [...cart.lines.nodes];
    let pageInfo = cart.lines.pageInfo;

    while (pageInfo.hasNextPage) {
      if (!pageInfo.endCursor) throw new Error("Storefront API omitted the cart line cursor");
      const data = await this.gql<{
        cart: { lines: { nodes: StorefrontCartLine[]; pageInfo: PageInfo } } | null;
      }>(CART_LINES_PAGE_QUERY, { cartId: cart.id, after: pageInfo.endCursor });
      if (!data.cart) throw new Error("Cart expired while loading its lines");
      nodes.push(...data.cart.lines.nodes);
      pageInfo = data.cart.lines.pageInfo;
    }

    return { ...cart, lines: { nodes, pageInfo } };
  }

  private async cartFromMutation(operation: string, payload: CartMutationPayload): Promise<StorefrontCart> {
    if (payload.userErrors.length > 0) {
      throw new Error(`${operation}: ${payload.userErrors.map((error) => error.message).join("; ")}`);
    }
    if (!payload.cart) throw new Error(`${operation} returned no cart`);
    return this.hydrateCartLines(payload.cart);
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
          ${CART_FIELDS}
        }
      }`,
      { cartId },
    );
    return data.cart ? this.hydrateCartLines(data.cart) : null;
  }

  async createCart(): Promise<StorefrontCart> {
    const data = await this.gql<{ cartCreate: CartMutationPayload }>(
      `mutation CartCreate {
        cartCreate {
          cart {
            ${CART_FIELDS}
          }
          userErrors { field message code }
        }
      }`,
    );
    const cart = await this.cartFromMutation("cartCreate", data.cartCreate);
    this.cartId = cart.id;
    this.storeCartId(cart.id);
    return cart;
  }

  async addLines(
    lines: Array<{ merchandiseId: string; quantity: number; attributes?: Record<string, string> }>,
  ): Promise<StorefrontCart> {
    if (lines.length === 0) return this.getOrCreateCart();
    if (lines.length > 250) throw new Error("Cannot add more than 250 cart lines per mutation");
    const cartId = this.cartId ?? (await this.getOrCreateCart()).id;
    const data = await this.gql<{ cartLinesAdd: CartMutationPayload }>(
      `mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) {
          cart {
            ${CART_FIELDS}
          }
          userErrors { field message code }
        }
      }`,
      {
        cartId,
        lines: lines.map((l) => ({
          merchandiseId: l.merchandiseId,
          quantity: l.quantity,
          attributes: Object.entries(withPromoMetadata(l.attributes ?? {})).map(([key, value]) => ({ key, value })),
        })),
      },
    );
    return this.cartFromMutation("cartLinesAdd", data.cartLinesAdd);
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
    if (updates.length === 0) return this.getOrCreateCart();
    if (updates.length > 250) throw new Error("Cannot update more than 250 cart lines per mutation");
    const data = await this.gql<{ cartLinesUpdate: CartMutationPayload }>(
      `mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
        cartLinesUpdate(cartId: $cartId, lines: $lines) {
          cart {
            ${CART_FIELDS}
          }
          userErrors { field message code }
        }
      }`,
      {
        cartId: this.cartId,
        lines: updates.map((u) => ({
          id: u.id,
          quantity: u.quantity,
          attributes: Object.entries(withPromoMetadata(u.attributes)).map(([key, value]) => ({ key, value })),
        })),
      },
    );
    return this.cartFromMutation("cartLinesUpdate", data.cartLinesUpdate);
  }

  async removeLines(lineIds: string[]): Promise<StorefrontCart> {
    if (!this.cartId) throw new Error("No active cart");
    if (lineIds.length === 0) return this.getOrCreateCart();
    if (lineIds.length > 250) throw new Error("Cannot remove more than 250 cart lines per mutation");
    const data = await this.gql<{ cartLinesRemove: CartMutationPayload }>(
      `mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
        cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
          cart {
            ${CART_FIELDS}
          }
          userErrors { field message code }
        }
      }`,
      { cartId: this.cartId, lineIds },
    );
    return this.cartFromMutation("cartLinesRemove", data.cartLinesRemove);
  }

  async applyDiscountCodes(codes: string[]): Promise<StorefrontCart> {
    if (!this.cartId) throw new Error("No active cart");
    const data = await this.gql<{ cartDiscountCodesUpdate: CartMutationPayload }>(
      `mutation CartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]!) {
        cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
          cart { ${CART_FIELDS} }
          userErrors { field message code }
        }
      }`,
      { cartId: this.cartId, discountCodes: codes },
    );
    return this.cartFromMutation("cartDiscountCodesUpdate", data.cartDiscountCodesUpdate);
  }

  async updateBuyerIdentity(countryCode: string, customerAccessToken?: string): Promise<StorefrontCart> {
    if (!this.cartId) throw new Error("No active cart");
    const data = await this.gql<{ cartBuyerIdentityUpdate: CartMutationPayload }>(
      `mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
        cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
          cart { ${CART_FIELDS} }
          userErrors { field message code }
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
    return this.cartFromMutation("cartBuyerIdentityUpdate", data.cartBuyerIdentityUpdate);
  }
}

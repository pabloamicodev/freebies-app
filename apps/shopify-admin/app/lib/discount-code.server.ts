/**
 * Discount code management — creates and manages Shopify discount codes
 * for offers that use code-based discounts.
 *
 * For function-based discounts, we create automatic Shopify discounts
 * that apply the Discount Function.
 */

const SHOPIFY_API_VERSION = "2026-04";

export interface CreateDiscountCodeOptions {
  shopDomain: string;
  accessToken: string;
  offerId: string;
  code: string;
  /** Discount Function ID (from shopify app function deploy output). */
  functionId: string;
  combinesWithOrderDiscounts: boolean;
  combinesWithShippingDiscounts: boolean;
  combinesWithProductDiscounts: boolean;
  startsAt?: string;
  endsAt?: string;
}

/** Create an automatic discount backed by our Discount Function. */
export async function createAutomaticDiscount(opts: CreateDiscountCodeOptions): Promise<string> {
  const mutation = `
    mutation DiscountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount {
          discountId
          title
          status
        }
        userErrors { field message }
      }
    }
  `;

  const response = await fetch(
    `https://${opts.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": opts.accessToken,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          automaticAppDiscount: {
            title: `Promo Engine - Offer ${opts.offerId.slice(0, 8)}`,
            functionId: opts.functionId,
            combinesWith: {
              orderDiscounts: opts.combinesWithOrderDiscounts,
              shippingDiscounts: opts.combinesWithShippingDiscounts,
              productDiscounts: opts.combinesWithProductDiscounts,
            },
            startsAt: opts.startsAt ?? new Date().toISOString(),
            endsAt: opts.endsAt ?? null,
          },
        },
      }),
    },
  );

  const data = (await response.json()) as {
    data: {
      discountAutomaticAppCreate: {
        automaticAppDiscount: { discountId: string } | null;
        userErrors: Array<{ message: string }>;
      };
    };
  };

  const errors = data.data.discountAutomaticAppCreate.userErrors;
  if (errors.length > 0) {
    throw new Error(`Failed to create discount: ${errors.map((e) => e.message).join(", ")}`);
  }

  return data.data.discountAutomaticAppCreate.automaticAppDiscount?.discountId ?? "";
}

/** Deactivate a Shopify discount when the offer is paused/archived. */
export async function deactivateDiscount(
  shopDomain: string,
  accessToken: string,
  discountGid: string,
): Promise<void> {
  const mutation = `
    mutation DiscountAutomaticDeactivate($id: ID!) {
      discountAutomaticDeactivate(id: $id) {
        userErrors { field message }
      }
    }
  `;

  await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: mutation, variables: { id: discountGid } }),
  });
}

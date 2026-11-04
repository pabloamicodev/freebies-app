export type SkioGraphQLProxy = <TData = unknown>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<{ data?: TData; errors?: Array<{ message: string }> }>;

const SKIO_API_URL = "https://graphql.skio.com/v1/graphql";

export function makeSkioGraphQLProxy(apiKey: string, timeoutMs = 15_000): SkioGraphQLProxy {
  return async <TData>(query: string, variables?: Record<string, unknown>) => {
    const response = await fetch(SKIO_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `API ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Skio API request failed: HTTP ${response.status} ${response.statusText}`);
    return response.json() as Promise<{ data?: TData; errors?: Array<{ message: string }> }>;
  };
}

function assertNoSkioErrors(result: { errors?: Array<{ message: string }> }, operation: string): void {
  if (result.errors?.length) {
    throw new Error(`${operation} failed: ${result.errors.map((error) => error.message).join(", ")}`);
  }
}

const LIST_ACTIVE_SUBSCRIPTIONS_QUERY = `
  query ListActiveSubscriptions($limit: Int!, $offset: Int!) {
    Subscriptions(limit: $limit, offset: $offset, where: { status: { _eq: "ACTIVE" } }, order_by: { id: asc }) {
      id
      status
      cyclesCompleted
      nextBillingDate
      deliveryPrice
      BillingPolicy { interval intervalCount }
      SubscriptionLines {
        priceWithoutDiscount
        quantity
        removedAt
        ProductVariant { platformId }
      }
    }
  }
`;

const GET_SUBSCRIPTION_QUERY = `
  query GetSkioSubscription($id: uuid!) {
    SubscriptionByPk(id: $id) {
      id
      status
      cyclesCompleted
      nextBillingDate
      deliveryPrice
      BillingPolicy { interval intervalCount }
      SubscriptionLines {
        priceWithoutDiscount
        quantity
        removedAt
        ProductVariant { platformId }
      }
    }
  }
`;

const VALIDATE_CONNECTION_QUERY = `
  query ValidateSkioConnection {
    Subscriptions(limit: 1) { id }
  }
`;

const SET_DELIVERY_PRICE_MUTATION = `
  mutation SetDeliveryPriceOverride($input: SetDeliveryPriceOverrideInput!) {
    setDeliveryPriceOverride(input: $input) { subscriptionId }
  }
`;

interface RawSkioSubscriptionLine {
  priceWithoutDiscount: number;
  quantity: number;
  removedAt: string | null;
  ProductVariant: { platformId: string };
}

export interface RawSkioSubscription {
  id: string;
  status: string;
  cyclesCompleted: number | null;
  nextBillingDate: string | null;
  deliveryPrice: number;
  BillingPolicy: { interval: string; intervalCount: number };
  SubscriptionLines: RawSkioSubscriptionLine[];
}

const PAGE_SIZE = 100;

export async function listActiveSkioSubscriptions(proxy: SkioGraphQLProxy): Promise<RawSkioSubscription[]> {
  const subscriptions: RawSkioSubscription[] = [];
  let offset = 0;
  for (;;) {
    const result = await proxy<{ Subscriptions: RawSkioSubscription[] }>(LIST_ACTIVE_SUBSCRIPTIONS_QUERY, {
      limit: PAGE_SIZE,
      offset,
    });
    assertNoSkioErrors(result, "ListActiveSubscriptions");
    const page = result.data?.Subscriptions ?? [];
    subscriptions.push(...page);
    if (page.length < PAGE_SIZE) return subscriptions;
    offset += PAGE_SIZE;
  }
}

export async function getSkioSubscriptionById(
  proxy: SkioGraphQLProxy,
  id: string,
): Promise<RawSkioSubscription | null> {
  const result = await proxy<{ SubscriptionByPk: RawSkioSubscription | null }>(GET_SUBSCRIPTION_QUERY, { id });
  assertNoSkioErrors(result, "GetSkioSubscription");
  return result.data?.SubscriptionByPk ?? null;
}

export async function setSkioDeliveryPriceOverride(
  proxy: SkioGraphQLProxy,
  subscriptionId: string,
  deliveryPrice: number,
): Promise<void> {
  const result = await proxy<{ setDeliveryPriceOverride: { subscriptionId: string } | null }>(
    SET_DELIVERY_PRICE_MUTATION,
    { input: { subscriptionId, deliveryPrice } },
  );
  assertNoSkioErrors(result, "SetDeliveryPriceOverride");
  if (!result.data?.setDeliveryPriceOverride?.subscriptionId) {
    throw new Error("SetDeliveryPriceOverride returned no result and no error.");
  }
}

export function intervalToDurationMonths(policy: { interval: string; intervalCount: number }): number | null {
  return policy.interval === "DAY" ? Math.round(policy.intervalCount / 30) : null;
}

export function subscriptionSubtotal(subscription: RawSkioSubscription): number {
  return subscription.SubscriptionLines
    .filter((line) => !line.removedAt)
    .reduce((sum, line) => sum + line.priceWithoutDiscount * line.quantity, 0);
}

export function subscriptionProductVariantIds(subscription: RawSkioSubscription): string[] {
  return subscription.SubscriptionLines
    .filter((line) => !line.removedAt)
    .map((line) => line.ProductVariant.platformId);
}

export async function validateSkioApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await makeSkioGraphQLProxy(apiKey)<{ Subscriptions: Array<{ id: string }> }>(
      VALIDATE_CONNECTION_QUERY,
    );
    assertNoSkioErrors(result, "ValidateSkioConnection");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Skio connection failed." };
  }
}

const GET_CUSTOMER_CREDIT_BALANCE_QUERY = `
  query getCustomerCreditBalance($input: GetCustomerCreditBalanceInput!) {
    getCustomerCreditBalance(input: $input) {
      credits
      siteCurrencyValue
      siteCurrencyStringValue
    }
  }
`;

export interface SkioCreditBalance {
  credits: number;
  siteCurrencyValue: number;
  siteCurrencyStringValue: string;
}

export type SkioCustomerRef = { platformId: string } | { storefrontUserId: string };

/** Loyalty points balance; null when Skio has no such customer for this shop's key. */
export async function getSkioCreditBalance(proxy: SkioGraphQLProxy, customer: SkioCustomerRef): Promise<SkioCreditBalance | null> {
  const result = await proxy<{ getCustomerCreditBalance: SkioCreditBalance | null }>(GET_CUSTOMER_CREDIT_BALANCE_QUERY, {
    input: customer,
  });
  if (result.errors?.some((error) => /no customer found/i.test(JSON.stringify(error)))) return null;
  assertNoSkioErrors(result, "getCustomerCreditBalance");
  return result.data?.getCustomerCreditBalance ?? null;
}

const GET_STOREFRONT_USER_QUERY = `
  query GetStorefrontUser($id: uuid!) {
    StorefrontUserByPk(id: $id) { platformId }
  }
`;

/** Shopify customer GID of a Skio storefront user, scoped to this shop's Skio key. */
export async function getSkioStorefrontUserPlatformId(proxy: SkioGraphQLProxy, storefrontUserId: string): Promise<string | null> {
  const result = await proxy<{ StorefrontUserByPk: { platformId: string | null } | null }>(GET_STOREFRONT_USER_QUERY, { id: storefrontUserId });
  assertNoSkioErrors(result, "GetStorefrontUser");
  return result.data?.StorefrontUserByPk?.platformId ?? null;
}

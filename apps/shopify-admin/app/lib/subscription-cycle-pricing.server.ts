import { randomUUID } from "node:crypto";
import { shopifyGraphQL } from "./shopify-fetch.server.js";
import type {
  CycleDiscountValue,
  SubscriptionCyclePricingPlan,
  SubscriptionCyclePricingPlanInput,
} from "./subscription-cycle-pricing.js";
import { subscriptionCyclePricingPlanInputSchema } from "./subscription-cycle-pricing.js";

export interface CyclePricingClient {
  shopDomain: string;
  accessToken: string;
}

export interface SellingPlanGroupUserError {
  field: string[] | null;
  message: string;
}

export function parseCyclePricingFormData(formData: FormData) {
  let productIds: unknown = [];
  try {
    productIds = JSON.parse(String(formData.get("productIds") ?? "[]"));
  } catch {
    productIds = [];
  }
  return subscriptionCyclePricingPlanInputSchema.safeParse({
    name: formData.get("name"),
    intervalUnit: formData.get("intervalUnit"),
    intervalCount: Number(formData.get("intervalCount")),
    totalCycles: Number(formData.get("totalCycles")),
    firstCycleDiscount: {
      type: formData.get("firstCycleDiscountType"),
      value: Number(formData.get("firstCycleDiscountValue")),
    },
    recurringDiscount: {
      type: formData.get("recurringDiscountType"),
      value: Number(formData.get("recurringDiscountValue")),
    },
    productIds,
  });
}

const MERCHANT_CODE_PREFIX = "freebies-cycle-pricing";
// hpn-scripts-migration (the app this replaces) used this prefix; keep listing
// and editing those plans so merchants aren't left with orphaned selling plans.
const LEGACY_MERCHANT_CODE_PREFIX = "hpn-cycle-pricing";
const GROUP_OPTION_NAME = "Subscription plan";

const GROUP_FRAGMENT = `
  id
  name
  merchantCode
  sellingPlans(first: 1) {
    nodes {
      id
      name
      billingPolicy {
        ... on SellingPlanRecurringBillingPolicy { interval intervalCount maxCycles }
      }
      pricingPolicies {
        ... on SellingPlanFixedPricingPolicy {
          adjustmentType
          adjustmentValue {
            ... on SellingPlanPricingPolicyPercentageValue { percentage }
            ... on MoneyV2 { amount }
          }
        }
        ... on SellingPlanRecurringPricingPolicy {
          afterCycle
          adjustmentType
          adjustmentValue {
            ... on SellingPlanPricingPolicyPercentageValue { percentage }
            ... on MoneyV2 { amount }
          }
        }
      }
    }
  }
  products(first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes { id title }
  }
`;

const LIST_QUERY = `
  query ListCyclePricingPlans($first: Int!, $after: String) {
    sellingPlanGroups(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${GROUP_FRAGMENT} }
    }
  }
`;

const GROUP_PRODUCTS_QUERY = `
  query CyclePricingPlanProducts($id: ID!, $first: Int!, $after: String) {
    sellingPlanGroup(id: $id) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id title }
      }
    }
  }
`;

const CREATE_MUTATION = `
  mutation CreateCyclePricingPlan($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup { ${GROUP_FRAGMENT} }
      userErrors { field message }
    }
  }
`;

const UPDATE_MUTATION = `
  mutation UpdateCyclePricingPlan($id: ID!, $input: SellingPlanGroupInput!) {
    sellingPlanGroupUpdate(id: $id, input: $input) {
      sellingPlanGroup { id }
      userErrors { field message }
    }
  }
`;

const ADD_PRODUCTS_MUTATION = `
  mutation AddCyclePricingPlanProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

const REMOVE_PRODUCTS_MUTATION = `
  mutation RemoveCyclePricingPlanProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

const DELETE_MUTATION = `
  mutation DeleteCyclePricingPlan($id: ID!) {
    sellingPlanGroupDelete(id: $id) {
      deletedSellingPlanGroupId
      userErrors { field message }
    }
  }
`;

interface RawPricingPolicy {
  afterCycle?: number;
  adjustmentType: "PERCENTAGE" | "FIXED_AMOUNT" | "PRICE";
  adjustmentValue: { percentage?: number; amount?: string } | null;
}

interface RawGroup {
  id: string;
  name: string;
  merchantCode: string | null;
  sellingPlans: {
    nodes: Array<{
      id: string;
      name: string;
      billingPolicy: {
        interval?: SubscriptionCyclePricingPlanInput["intervalUnit"];
        intervalCount?: number;
        maxCycles?: number | null;
      } | null;
      pricingPolicies: RawPricingPolicy[];
    }>;
  };
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ id: string; title: string }>;
  };
}

function graphQL<T>(client: CyclePricingClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  return shopifyGraphQL<T>({ ...client, query, variables });
}

function missingPayload(operation: string): SellingPlanGroupUserError {
  return { field: null, message: `${operation} returned no result and no error — treating as failed.` };
}

function adjustmentType(discount: CycleDiscountValue): "PERCENTAGE" | "FIXED_AMOUNT" {
  return discount.type === "percentage" ? "PERCENTAGE" : "FIXED_AMOUNT";
}

function adjustmentValue(discount: CycleDiscountValue): { percentage: number } | { fixedValue: number } {
  return discount.type === "percentage" ? { percentage: discount.value } : { fixedValue: discount.value };
}

function sellingPlanInput(input: SubscriptionCyclePricingPlanInput, existingSellingPlanId?: string) {
  const recurring = { interval: input.intervalUnit, intervalCount: input.intervalCount };
  return {
    ...(existingSellingPlanId ? { id: existingSellingPlanId } : {}),
    name: input.name,
    options: [input.name],
    category: "SUBSCRIPTION",
    billingPolicy: { recurring: { ...recurring, maxCycles: input.totalCycles } },
    deliveryPolicy: { recurring },
    pricingPolicies: [
      {
        fixed: {
          adjustmentType: adjustmentType(input.firstCycleDiscount),
          adjustmentValue: adjustmentValue(input.firstCycleDiscount),
        },
      },
      {
        recurring: {
          afterCycle: 1,
          adjustmentType: adjustmentType(input.recurringDiscount),
          adjustmentValue: adjustmentValue(input.recurringDiscount),
        },
      },
    ],
  };
}

function parseDiscount(policy: RawPricingPolicy): CycleDiscountValue | null {
  if (policy.adjustmentType === "PERCENTAGE") {
    return { type: "percentage", value: Number(policy.adjustmentValue?.percentage ?? 0) };
  }
  if (policy.adjustmentType === "FIXED_AMOUNT") {
    return { type: "fixed_amount", value: Number(policy.adjustmentValue?.amount ?? 0) };
  }
  return null;
}

function parseGroup(node: RawGroup): SubscriptionCyclePricingPlan | null {
  const plan = node.sellingPlans.nodes[0];
  if (!plan?.billingPolicy?.interval) return null;
  const fixed = plan.pricingPolicies.find((policy) => policy.afterCycle === undefined);
  const recurring = plan.pricingPolicies.find((policy) => policy.afterCycle !== undefined);
  if (!fixed || !recurring) return null;
  const firstCycleDiscount = parseDiscount(fixed);
  const recurringDiscount = parseDiscount(recurring);
  if (!firstCycleDiscount || !recurringDiscount) return null;
  const productTitlesById = Object.fromEntries(node.products.nodes.map((product) => [product.id, product.title]));
  return {
    id: node.id,
    sellingPlanId: plan.id,
    name: plan.name,
    intervalUnit: plan.billingPolicy.interval,
    intervalCount: plan.billingPolicy.intervalCount ?? 1,
    totalCycles: plan.billingPolicy.maxCycles ?? 2,
    firstCycleDiscount,
    recurringDiscount,
    productIds: Object.keys(productTitlesById),
    productTitlesById,
  };
}

async function listAllGroupProducts(
  client: CyclePricingClient,
  id: string,
): Promise<Array<{ id: string; title: string }> | null> {
  const products: Array<{ id: string; title: string }> = [];
  let after: string | null = null;
  do {
    const data: {
      sellingPlanGroup: {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{ id: string; title: string }>;
        };
      } | null;
    } = await graphQL(client, GROUP_PRODUCTS_QUERY, { id, first: 100, after });
    if (!data.sellingPlanGroup) return null;
    products.push(...data.sellingPlanGroup.products.nodes);
    after = data.sellingPlanGroup.products.pageInfo.hasNextPage
      ? data.sellingPlanGroup.products.pageInfo.endCursor
      : null;
  } while (after);
  return products;
}

export async function listCyclePricingPlans(client: CyclePricingClient): Promise<SubscriptionCyclePricingPlan[]> {
  const plans: SubscriptionCyclePricingPlan[] = [];
  let after: string | null = null;
  do {
    const data: {
      sellingPlanGroups: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawGroup[];
      };
    } = await graphQL(client, LIST_QUERY, { first: 50, after });
    for (const node of data.sellingPlanGroups.nodes) {
      const isOwned =
        node.merchantCode?.startsWith(MERCHANT_CODE_PREFIX) ||
        node.merchantCode?.startsWith(LEGACY_MERCHANT_CODE_PREFIX);
      if (!isOwned) continue;
      const plan = parseGroup(node);
      if (plan) plans.push(plan);
    }
    after = data.sellingPlanGroups.pageInfo.hasNextPage
      ? data.sellingPlanGroups.pageInfo.endCursor
      : null;
  } while (after);
  return plans;
}

export async function getCyclePricingPlan(client: CyclePricingClient, id: string): Promise<SubscriptionCyclePricingPlan | null> {
  const plans = await listCyclePricingPlans(client);
  const plan = plans.find((candidate) => candidate.id === id);
  if (!plan) return null;
  const products = await listAllGroupProducts(client, id);
  if (!products) return null;
  return {
    ...plan,
    productIds: products.map((product) => product.id),
    productTitlesById: Object.fromEntries(products.map((product) => [product.id, product.title])),
  };
}

export async function createCyclePricingPlan(
  client: CyclePricingClient,
  input: SubscriptionCyclePricingPlanInput,
): Promise<{ id: string | null; userErrors: SellingPlanGroupUserError[] }> {
  const data = await graphQL<{
    sellingPlanGroupCreate: { sellingPlanGroup: RawGroup | null; userErrors: SellingPlanGroupUserError[] } | null;
  }>(client, CREATE_MUTATION, {
    input: {
      name: `[Freebies] ${input.name}`,
      merchantCode: `${MERCHANT_CODE_PREFIX}-${randomUUID()}`,
      options: [GROUP_OPTION_NAME],
      sellingPlansToCreate: [sellingPlanInput(input)],
    },
    resources: { productIds: [...new Set(input.productIds)] },
  });
  const payload = data.sellingPlanGroupCreate;
  if (!payload) return { id: null, userErrors: [missingPayload("CreateCyclePricingPlan")] };
  const id = payload.sellingPlanGroup?.id ?? null;
  if (!id && payload.userErrors.length === 0) {
    return { id: null, userErrors: [missingPayload("CreateCyclePricingPlan")] };
  }
  return { id, userErrors: payload.userErrors };
}

export async function updateCyclePricingPlan(
  client: CyclePricingClient,
  existing: SubscriptionCyclePricingPlan,
  input: SubscriptionCyclePricingPlanInput,
): Promise<{ userErrors: SellingPlanGroupUserError[] }> {
  // Always reconcile against the complete, current Shopify association set.
  // The list screen intentionally fetches only a preview page, so trusting the
  // caller's productIds here could silently detach products after item 100.
  const currentProducts = await listAllGroupProducts(client, existing.id);
  if (!currentProducts) return { userErrors: [missingPayload("ListCyclePricingPlanProducts")] };

  const updated = await graphQL<{
    sellingPlanGroupUpdate: { sellingPlanGroup: { id: string } | null; userErrors: SellingPlanGroupUserError[] } | null;
  }>(client, UPDATE_MUTATION, {
    id: existing.id,
    input: {
      name: `[Freebies] ${input.name}`,
      options: [GROUP_OPTION_NAME],
      sellingPlansToUpdate: [sellingPlanInput(input, existing.sellingPlanId)],
    },
  });
  const updatePayload = updated.sellingPlanGroupUpdate;
  if (!updatePayload) return { userErrors: [missingPayload("UpdateCyclePricingPlan")] };
  if (updatePayload.userErrors.length) return { userErrors: updatePayload.userErrors };
  if (!updatePayload.sellingPlanGroup) return { userErrors: [missingPayload("UpdateCyclePricingPlan")] };

  const currentProductIds = currentProducts.map((product) => product.id);
  const currentIds = new Set(currentProductIds);
  const nextIds = [...new Set(input.productIds)];
  const nextSet = new Set(nextIds);
  const toAdd = nextIds.filter((id) => !currentIds.has(id));
  const toRemove = currentProductIds.filter((id) => !nextSet.has(id));
  const userErrors: SellingPlanGroupUserError[] = [];

  if (toAdd.length) {
    const added = await graphQL<{
      sellingPlanGroupAddProducts: { userErrors: SellingPlanGroupUserError[] } | null;
    }>(client, ADD_PRODUCTS_MUTATION, { id: existing.id, productIds: toAdd });
    userErrors.push(...(added.sellingPlanGroupAddProducts?.userErrors ?? [missingPayload("AddCyclePricingPlanProducts")]));
  }
  if (toRemove.length) {
    const removed = await graphQL<{
      sellingPlanGroupRemoveProducts: { userErrors: SellingPlanGroupUserError[] } | null;
    }>(client, REMOVE_PRODUCTS_MUTATION, { id: existing.id, productIds: toRemove });
    userErrors.push(...(removed.sellingPlanGroupRemoveProducts?.userErrors ?? [missingPayload("RemoveCyclePricingPlanProducts")]));
  }
  return { userErrors };
}

export async function deleteCyclePricingPlan(
  client: CyclePricingClient,
  id: string,
): Promise<{ userErrors: SellingPlanGroupUserError[] }> {
  const data = await graphQL<{
    sellingPlanGroupDelete: { deletedSellingPlanGroupId: string | null; userErrors: SellingPlanGroupUserError[] } | null;
  }>(client, DELETE_MUTATION, { id });
  const payload = data.sellingPlanGroupDelete;
  if (!payload) return { userErrors: [missingPayload("DeleteCyclePricingPlan")] };
  if (!payload.deletedSellingPlanGroupId && payload.userErrors.length === 0) {
    return { userErrors: [missingPayload("DeleteCyclePricingPlan")] };
  }
  return { userErrors: payload.userErrors };
}

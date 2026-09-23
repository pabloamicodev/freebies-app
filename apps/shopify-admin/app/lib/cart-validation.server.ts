import { shopifyGraphQL } from "./shopify-fetch.server.js";
import type { CompiledOffer } from "./sync/compile-config.js";

const VALIDATION_TITLE = "Promo Engine Cart Protection";
const VALIDATION_FUNCTION_HANDLE = "promo-engine-cart-validation";
const VALIDATION_METAFIELD_NAMESPACE = "promo_engine";
const VALIDATION_METAFIELD_KEY = "validation_config";
const MAX_VALIDATION_CONFIG_BYTES = 9_500;

export interface GiftRewardValidationRule {
  maxQuantity: number;
  variantIds: string[];
}

export interface GiftOfferValidationRule {
  version: number;
  maxQuantity: number;
  rewards: Record<string, GiftRewardValidationRule>;
}

export interface CartValidationConfig {
  offerRules: Record<string, GiftOfferValidationRule>;
  /** Kept for carts created by older storefront-runtime bundles. */
  offerMaxQuantities: Record<string, number>;
  /** Kept for carts created by older storefront-runtime bundles. */
  allowedGiftVariantIds: string[];
  cloneProductIds: string[];
  cloneMinPriceCents: number;
}

export function buildCartValidationConfig(compiledOffers: CompiledOffer[]): CartValidationConfig {
  const offerRules: Record<string, GiftOfferValidationRule> = {};
  const offerMaxQuantities: Record<string, number> = {};
  const allowedGiftVariantIds = new Set<string>();
  const cloneProductIds = new Set<string>();

  for (const offer of compiledOffers) {
    if (offer.giftRewards.length === 0) continue;

    const rewards: Record<string, GiftRewardValidationRule> = {};
    let offerMaxQuantity = 0;

    for (const reward of offer.giftRewards) {
      const variantIds = [...new Set(reward.targetVariantIds)].sort();
      const maxQuantity = Math.max(1, Math.trunc(reward.maxQuantity));
      rewards[reward.id] = { maxQuantity, variantIds };
      offerMaxQuantity += maxQuantity;
      for (const variantId of variantIds) allowedGiftVariantIds.add(variantId);
      for (const productId of reward.targetProductIds) cloneProductIds.add(productId);
    }

    offerRules[offer.id] = {
      version: Math.max(1, Math.trunc(offer.version)),
      maxQuantity: offerMaxQuantity,
      rewards,
    };
    offerMaxQuantities[offer.id] = offerMaxQuantity;
  }

  return {
    offerRules,
    offerMaxQuantities,
    allowedGiftVariantIds: [...allowedGiftVariantIds].sort(),
    cloneProductIds: [...cloneProductIds].sort(),
    cloneMinPriceCents: 100,
  };
}

interface ExistingValidation {
  id: string;
  shopifyFunction: { handle: string };
  metafield: { id: string } | null;
}

interface ValidationMutationResult {
  validation: { id: string } | null;
  userErrors: Array<{ field: string[] | null; message: string }>;
}

export async function syncCartValidation(
  shopDomain: string,
  accessToken: string,
  config: CartValidationConfig,
): Promise<string> {
  const value = JSON.stringify(config);
  const sizeBytes = new TextEncoder().encode(value).byteLength;
  if (sizeBytes > MAX_VALIDATION_CONFIG_BYTES) {
    throw new Error(
      `Cart validation config is ${sizeBytes}B, exceeding the safe ${MAX_VALIDATION_CONFIG_BYTES}B limit. Pause or simplify active gift offers before publishing.`,
    );
  }

  const existingData = await shopifyGraphQL<{
    validations: { nodes: ExistingValidation[] };
  }>({
    shopDomain,
    accessToken,
    query: `query FindPromoEngineCartValidation {
      validations(first: 25) {
        nodes {
          id
          shopifyFunction { handle }
          metafield(namespace: "${VALIDATION_METAFIELD_NAMESPACE}", key: "${VALIDATION_METAFIELD_KEY}") { id }
        }
      }
    }`,
  });

  const existing = existingData.validations.nodes.find(
    (validation) => validation.shopifyFunction.handle === VALIDATION_FUNCTION_HANDLE,
  );
  const metafield = {
    ...(existing?.metafield?.id ? { id: existing.metafield.id } : {}),
    namespace: VALIDATION_METAFIELD_NAMESPACE,
    key: VALIDATION_METAFIELD_KEY,
    type: "json",
    value,
  };

  if (existing) {
    const data = await shopifyGraphQL<{ validationUpdate: ValidationMutationResult }>({
      shopDomain,
      accessToken,
      query: `mutation UpdatePromoEngineCartValidation($id: ID!, $validation: ValidationUpdateInput!) {
        validationUpdate(id: $id, validation: $validation) {
          validation { id }
          userErrors { field message }
        }
      }`,
      variables: {
        id: existing.id,
        validation: {
          title: VALIDATION_TITLE,
          enable: true,
          blockOnFailure: true,
          metafields: [metafield],
        },
      },
    });
    return assertValidationMutation("validationUpdate", data.validationUpdate);
  }

  const data = await shopifyGraphQL<{ validationCreate: ValidationMutationResult }>({
    shopDomain,
    accessToken,
    query: `mutation CreatePromoEngineCartValidation($validation: ValidationCreateInput!) {
      validationCreate(validation: $validation) {
        validation { id }
        userErrors { field message }
      }
    }`,
    variables: {
      validation: {
        title: VALIDATION_TITLE,
        functionHandle: VALIDATION_FUNCTION_HANDLE,
        enable: true,
        blockOnFailure: true,
        metafields: [metafield],
      },
    },
  });
  return assertValidationMutation("validationCreate", data.validationCreate);
}

function assertValidationMutation(operation: string, result: ValidationMutationResult): string {
  if (result.userErrors.length > 0) {
    throw new Error(`${operation} failed: ${result.userErrors.map((error) => error.message).join(", ")}`);
  }
  if (!result.validation?.id) throw new Error(`${operation} returned no validation id`);
  return result.validation.id;
}

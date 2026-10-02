import { ShopifyOutcomeUnknownError, shopifyGraphQL } from "./shopify-fetch.server.js";
import type { CompiledOffer } from "./sync/compile-config.js";

const VALIDATION_TITLE = "Promo Engine Cart Protection";
export const VALIDATION_FUNCTION_HANDLE = "promo-engine-cart-validation";
export const VALIDATION_METAFIELD_NAMESPACE = "promo_engine";
export const VALIDATION_APP_METAFIELD_NAMESPACE = "$app:promo_engine";
export const VALIDATION_METAFIELD_KEY = "validation_config";
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
  /** Legacy, read by the Function only when `offerRules` is empty. Always empty: every gift variant
   * id is stored once, under its reward, which keeps the metafield half the size. */
  offerMaxQuantities: Record<string, number>;
  /** Legacy, see `offerMaxQuantities`. */
  allowedGiftVariantIds: string[];
  cloneProductIds: string[];
  cloneMinPriceCents: number;
}

export function buildCartValidationConfig(compiledOffers: CompiledOffer[]): CartValidationConfig {
  const offerRules: Record<string, GiftOfferValidationRule> = {};
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
      for (const productId of reward.targetProductIds) cloneProductIds.add(productId);
    }

    offerRules[offer.id] = {
      version: Math.max(1, Math.trunc(offer.version)),
      maxQuantity: offerMaxQuantity,
      rewards,
    };
  }

  return {
    offerRules,
    offerMaxQuantities: {},
    allowedGiftVariantIds: [],
    cloneProductIds: [...cloneProductIds].sort(),
    cloneMinPriceCents: 100,
  };
}

interface ExistingValidation {
  id: string;
  shopifyFunction: { handle: string };
  metafield: { id: string; namespace: string } | null;
  appMetafield?: { id: string; namespace: string } | null;
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

  const findExisting = async () => {
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
          metafield(namespace: "${VALIDATION_METAFIELD_NAMESPACE}", key: "${VALIDATION_METAFIELD_KEY}") { id namespace }
          appMetafield: metafield(namespace: "${VALIDATION_APP_METAFIELD_NAMESPACE}", key: "${VALIDATION_METAFIELD_KEY}") { id namespace }
        }
      }
    }`,
    });
    return existingData.validations.nodes.find(
      (validation) => validation.shopifyFunction.handle === VALIDATION_FUNCTION_HANDLE,
    );
  };
  // Dual-write until every deployed cart-validation Function reads the $app namespace (see RUNBOOK).
  const metafieldsFor = (existing: ExistingValidation | undefined) => [
    {
      ...(existing?.metafield?.id ? { id: existing.metafield.id } : {}),
      namespace: existing?.metafield?.namespace ?? VALIDATION_METAFIELD_NAMESPACE,
      key: VALIDATION_METAFIELD_KEY,
      type: "json",
      value,
    },
    {
      ...(existing?.appMetafield?.id ? { id: existing.appMetafield.id } : {}),
      // validationUpdate rejects the $app alias together with an existing ID.
      // Reuse Shopify's resolved namespace; the alias is valid for creation.
      namespace: existing?.appMetafield?.namespace ?? VALIDATION_APP_METAFIELD_NAMESPACE,
      key: VALIDATION_METAFIELD_KEY,
      type: "json",
      value,
    },
  ];
  const update = async (existing: ExistingValidation) => {
    const data = await shopifyGraphQL<{ validationUpdate: ValidationMutationResult }>({
      shopDomain,
      accessToken,
      retryable: true,
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
          blockOnFailure: false,
          metafields: metafieldsFor(existing),
        },
      },
    });
    return assertValidationMutation("validationUpdate", data.validationUpdate);
  };

  const existing = await findExisting();
  if (existing) return update(existing);

  const create = () =>
    shopifyGraphQL<{ validationCreate: ValidationMutationResult }>({
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
          blockOnFailure: false,
          metafields: metafieldsFor(undefined),
        },
      },
    });
  try {
    const data = await create();
    return assertValidationMutation("validationCreate", data.validationCreate);
  } catch (err) {
    // A timed-out create may have landed: look before sending it again.
    if (!(err instanceof ShopifyOutcomeUnknownError)) throw err;
    const landed = await findExisting();
    if (landed) return update(landed);
    const data = await create();
    return assertValidationMutation("validationCreate", data.validationCreate);
  }
}

function assertValidationMutation(operation: string, result: ValidationMutationResult): string {
  if (result.userErrors.length > 0) {
    throw new Error(`${operation} failed: ${result.userErrors.map((error) => error.message).join(", ")}`);
  }
  if (!result.validation?.id) throw new Error(`${operation} returned no validation id`);
  return result.validation.id;
}

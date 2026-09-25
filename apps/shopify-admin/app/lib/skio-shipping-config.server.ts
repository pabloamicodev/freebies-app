import { shopifyGraphQL } from "./shopify-fetch.server.js";
import {
  skioShippingTierSchema,
  skioShippingTiersConfigSchema,
  type SkioShippingTier,
  type SkioShippingTiersConfig,
} from "./skio-shipping-tiers.js";

export interface ShopifyAdminCredentials {
  shopDomain: string;
  accessToken: string;
}

export interface LoadedSkioShippingConfig {
  config: SkioShippingTiersConfig;
  configValid: boolean;
  configError: string | null;
}

interface UserError {
  field: string[] | null;
  message: string;
}

const EMPTY_CONFIG: SkioShippingTiersConfig = { tiers: [] };
const METAFIELD_KEY = "skio_shipping_tiers";

const GET_CONFIG_QUERY = `
  query GetSkioShippingTiersConfig {
    shop {
      id
      config: metafield(namespace: "$app", key: "skio_shipping_tiers") { jsonValue }
    }
  }
`;

const GET_SHOP_ID_QUERY = `query GetShopId { shop { id } }`;

const SET_CONFIG_MUTATION = `
  mutation SetSkioShippingTiersConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

export async function loadSkioShippingConfig(
  client: ShopifyAdminCredentials,
): Promise<LoadedSkioShippingConfig> {
  const data = await shopifyGraphQL<{
    shop: { id: string; config: { jsonValue: unknown } | null };
  }>({ ...client, query: GET_CONFIG_QUERY });
  if (!data.shop.config) return { config: EMPTY_CONFIG, configValid: true, configError: null };

  const parsed = skioShippingTiersConfigSchema.safeParse(data.shop.config.jsonValue);
  if (parsed.success) return { config: parsed.data, configValid: true, configError: null };
  return {
    config: EMPTY_CONFIG,
    configValid: false,
    configError: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" "),
  };
}

export async function saveSkioShippingConfig(
  client: ShopifyAdminCredentials,
  config: SkioShippingTiersConfig,
): Promise<{ userErrors: UserError[] }> {
  const validated = skioShippingTiersConfigSchema.parse(config);
  const shopData = await shopifyGraphQL<{ shop: { id: string } }>({ ...client, query: GET_SHOP_ID_QUERY });
  const data = await shopifyGraphQL<{
    metafieldsSet: { metafields: Array<{ id: string }> | null; userErrors: UserError[] };
  }>({
    ...client,
    query: SET_CONFIG_MUTATION,
    variables: {
      metafields: [{
        ownerId: shopData.shop.id,
        key: METAFIELD_KEY,
        type: "json",
        value: JSON.stringify(validated),
      }],
    },
  });
  return { userErrors: data.metafieldsSet.userErrors ?? [] };
}

export function upsertSkioShippingTier(
  config: SkioShippingTiersConfig,
  tier: SkioShippingTier,
): SkioShippingTiersConfig {
  const validated = skioShippingTierSchema.parse(tier);
  const existing = config.tiers.some((candidate) => candidate.id === validated.id);
  return {
    tiers: existing
      ? config.tiers.map((candidate) => candidate.id === validated.id ? validated : candidate)
      : [...config.tiers, validated],
  };
}

// Create-only variant for the wizard: never silently overwrites an existing tier.
export function addSkioShippingTier(
  config: SkioShippingTiersConfig,
  tier: SkioShippingTier,
): { config: SkioShippingTiersConfig } | { error: string } {
  if (config.tiers.some((candidate) => candidate.id === tier.id)) {
    return { error: `A Skio shipping tier with ID "${tier.id}" already exists.` };
  }
  return { config: upsertSkioShippingTier(config, tier) };
}

export function deleteSkioShippingTier(
  config: SkioShippingTiersConfig,
  tierId: string,
): SkioShippingTiersConfig {
  return { tiers: config.tiers.filter((tier) => tier.id !== tierId) };
}

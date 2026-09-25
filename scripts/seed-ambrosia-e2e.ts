/**
 * Idempotently mirrors Ambrosia's verified hpn-scripts-migration rules into
 * the authorised hpn-test-store development tenant.
 *
 * The script never contacts or mutates the Ambrosia shop. It maps production
 * catalog IDs to dedicated development fixtures, preserves source rule state,
 * and publishes active offers through the same publisher used by the app.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import type { LegacyStorePreset } from "../apps/shopify-admin/app/lib/legacy-store-presets.server.js";

const DEV_SHOP = "hpn-test-store.myshopify.com";
const AMBROSIA_SHOP = "ambrosia-nutraceuticals.myshopify.com";
const DISABLED_SOURCE_RULES = new Set([
  "sitewide-free-shipping-mtt2zu2r",
  "landing-free-shipping-mtt5s7nx",
]);

interface FixtureCatalog {
  anchorProductId: string;
  anchorVariantId: string;
  frotherProductId: string;
  otgProductId: string;
  giftCardProductId: string;
  thirdGiftProductId: string;
  shirtVariantIds: string[];
  sellingPlanId: string;
}

export interface SeedOffer {
  key: string;
  internalName: string;
  publicTitle: string;
  description: string;
  type: LegacyStorePreset["offers"][number]["type"];
  priority: number;
  status: "active" | "draft";
  conditions: LegacyStorePreset["offers"][number]["conditions"];
  rewards: LegacyStorePreset["offers"][number]["rewards"];
}

export function mapAmbrosiaPresetToDev(
  preset: LegacyStorePreset,
  fixtures: FixtureCatalog,
): SeedOffer[] {
  if (preset.shopDomain !== AMBROSIA_SHOP) {
    throw new Error(`Expected the Ambrosia preset, received ${preset.shopDomain}.`);
  }
  if (fixtures.shirtVariantIds.length !== 4) {
    throw new Error("The Ambrosia E2E shirt fixture must expose exactly four variants.");
  }

  const productIds = new Map([
    ["gid://shopify/Product/7533558595669", fixtures.frotherProductId],
    ["gid://shopify/Product/7416485609557", fixtures.otgProductId],
    ["gid://shopify/Product/6564143956053", fixtures.giftCardProductId],
    ["gid://shopify/Product/6564118429781", fixtures.thirdGiftProductId],
  ]);
  const shirtVariantIds = new Map([
    ["gid://shopify/ProductVariant/42872167202901", fixtures.shirtVariantIds[0]],
    ["gid://shopify/ProductVariant/42872167235669", fixtures.shirtVariantIds[1]],
    ["gid://shopify/ProductVariant/42872167268437", fixtures.shirtVariantIds[2]],
    ["gid://shopify/ProductVariant/42872167301205", fixtures.shirtVariantIds[3]],
  ]);

  const mapProducts = (ids: unknown): unknown =>
    Array.isArray(ids) ? ids.map((id) => productIds.get(String(id)) ?? String(id)) : ids;
  const mapVariants = (ids: unknown): unknown =>
    Array.isArray(ids)
      ? ids.map((id) => shirtVariantIds.get(String(id)) ?? fixtures.anchorVariantId)
      : ids;

  return preset.offers.map((offer) => ({
    ...structuredClone(offer),
    internalName: `[Ambrosia E2E] ${offer.key}`,
    description: `${offer.description} Development-store parity fixture; source state: ${DISABLED_SOURCE_RULES.has(offer.key) ? "disabled" : "active"}.`,
    status: DISABLED_SOURCE_RULES.has(offer.key) ? "draft" : "active",
    conditions: structuredClone(offer.conditions),
    rewards: offer.rewards.map((reward) => {
      const target = structuredClone(reward.target);
      if ("productIds" in target) target.productIds = mapProducts(target.productIds);
      if ("productId" in target && typeof target.productId === "string") {
        target.productId = productIds.get(target.productId) ?? target.productId;
      }
      if ("variantIds" in target) target.variantIds = mapVariants(target.variantIds);
      if ("variantId" in target && typeof target.variantId === "string") {
        target.variantId = shirtVariantIds.get(target.variantId) ?? fixtures.anchorVariantId;
      }
      if ("requiredAnchorVariantIds" in target) {
        const original = Array.isArray(target.requiredAnchorVariantIds)
          ? target.requiredAnchorVariantIds
          : [];
        target.requiredAnchorVariantIds = original.length > 0 ? [fixtures.anchorVariantId] : [];
      }
      return { ...structuredClone(reward), target };
    }),
  }));
}

async function loadEnvironment(): Promise<void> {
  for (const file of [".env", ".env.local"]) {
    try {
      process.loadEnvFile(resolve(file));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code !== "ENOENT") throw error;
    }
  }
}

async function main(): Promise<void> {
  await loadEnvironment();
  const [
    { and, eq },
    {
      closeDb,
      appSettings,
      getDb,
      offerCombinationPolicies,
      offerConditions,
      offerRewards,
      offers,
      shops,
      shopifySessions,
    },
    { getLegacyStorePreset, validateLegacyStorePreset },
    { validateConditionValue, validateRewardPayload },
    { shopifyGraphQL },
    { publishOffersForShop },
  ] = await Promise.all([
    import("drizzle-orm"),
    import("@promo/db"),
    import("../apps/shopify-admin/app/lib/legacy-store-presets.server.js"),
    import("@promo/shared-types"),
    import("../apps/shopify-admin/app/lib/shopify-fetch.server.js"),
    import("../apps/shopify-admin/app/lib/sync/offer-publisher.server.js"),
  ]);

  const db = getDb();
  try {
    const [shop] = await db
      .select()
      .from(shops)
      .where(eq(shops.myshopifyDomain, DEV_SHOP))
      .limit(1);
    if (!shop || !shop.isActive) {
      throw new Error(`The authorised development tenant ${DEV_SHOP} is not active.`);
    }
    const [session] = await db
      .select({ accessToken: shopifySessions.accessToken, scope: shopifySessions.scope })
      .from(shopifySessions)
      .where(and(eq(shopifySessions.shop, DEV_SHOP), eq(shopifySessions.isOnline, false)))
      .limit(1);
    if (!session?.accessToken)
      throw new Error("No offline Shopify session exists for the development store.");

    const admin = <T>(query: string, variables: Record<string, unknown> = {}) =>
      shopifyGraphQL<T>({
        shopDomain: DEV_SHOP,
        accessToken: session.accessToken!,
        query,
        variables,
      });

    const installation = await admin<{
      currentAppInstallation: { accessScopes: Array<{ handle: string }> };
    }>(`#graphql
      query CurrentInstallationScopes {
        currentAppInstallation { accessScopes { handle } }
      }
    `);
    const requiredScopes = ["write_products", "write_purchase_options"];
    const grantedScopes = new Set(
      installation.currentAppInstallation.accessScopes.map((scope) => scope.handle),
    );
    const missingScopes = requiredScopes.filter((scope) => !grantedScopes.has(scope));
    if (missingScopes.length > 0) {
      throw new Error(
        `The development installation is missing required scopes: ${missingScopes.join(", ")}.`,
      );
    }

    const getProduct = async (handle: string) => {
      const data = await admin<{
        products: {
          nodes: Array<{
            id: string;
            handle: string;
            status: string;
            variants: { nodes: Array<{ id: string; title: string }> };
            sellingPlanGroups: {
              nodes: Array<{
                id: string;
                sellingPlans: { nodes: Array<{ id: string; name: string }> };
              }>;
            };
          }>;
        };
      }>(
        `#graphql
        query FixtureProduct($query: String!) {
          products(first: 2, query: $query) {
            nodes {
              id
              handle
              status
              variants(first: 20) { nodes { id title } }
              sellingPlanGroups(first: 10) {
                nodes { id sellingPlans(first: 10) { nodes { id name } } }
              }
            }
          }
        }
      `,
        { query: `handle:${handle}` },
      );
      return data.products.nodes.find((product) => product.handle === handle) ?? null;
    };

    const requireProduct = async (handle: string) => {
      const product = await getProduct(handle);
      if (!product)
        throw new Error(`Required development fixture product ${handle} was not found.`);
      if (product.status !== "ACTIVE") throw new Error(`Fixture product ${handle} is not active.`);
      const variant = product.variants.nodes[0];
      if (!variant) throw new Error(`Fixture product ${handle} has no variants.`);
      return { product, variant };
    };

    let shirt = await getProduct("ambrosia-e2e-athletic-club-shirt");
    if (!shirt) {
      const created = await admin<{
        productSet: {
          product: {
            id: string;
            handle: string;
            status: string;
            variants: { nodes: Array<{ id: string; title: string }> };
            sellingPlanGroups: { nodes: [] };
          } | null;
          userErrors: Array<{ code?: string | null; field?: string[] | null; message: string }>;
        };
      }>(
        `#graphql
        mutation CreateAmbrosiaFixture($input: ProductSetInput!, $synchronous: Boolean!) {
          productSet(input: $input, synchronous: $synchronous) {
            product {
              id
              handle
              status
              variants(first: 20) { nodes { id title } }
              sellingPlanGroups(first: 1) { nodes { id } }
            }
            userErrors { code field message }
          }
        }
      `,
        {
          synchronous: true,
          input: {
            title: "Ambrosia E2E Athletic Club T-Shirt",
            handle: "ambrosia-e2e-athletic-club-shirt",
            status: "ACTIVE",
            productOptions: [
              {
                name: "Size",
                position: 1,
                values: [{ name: "S" }, { name: "M" }, { name: "L" }, { name: "XL" }],
              },
            ],
            variants: ["S", "M", "L", "XL"].map((size) => ({
              optionValues: [{ optionName: "Size", name: size }],
              price: "20.00",
            })),
          },
        },
      );
      if (created.productSet.userErrors.length > 0 || !created.productSet.product) {
        throw new Error(
          `Unable to create the shirt fixture: ${JSON.stringify(created.productSet.userErrors)}`,
        );
      }
      shirt = created.productSet.product;
    }
    if (shirt.variants.nodes.length !== 4) {
      throw new Error(
        `The shirt fixture has ${shirt.variants.nodes.length} variants; expected exactly four.`,
      );
    }

    const [{ product: anchorProduct, variant: anchorVariant }, frother, otg, giftCard] =
      await Promise.all([
        requireProduct("test-product"),
        requireProduct("test-gift-product"),
        requireProduct("test-bundle-product"),
        requireProduct("test-volume-product"),
      ]);

    let sellingPlanId = anchorProduct.sellingPlanGroups.nodes
      .flatMap((group) => group.sellingPlans.nodes)
      .at(0)?.id;
    if (!sellingPlanId) {
      const result = await admin<{
        sellingPlanGroupCreate: {
          sellingPlanGroup: {
            id: string;
            sellingPlans: { nodes: Array<{ id: string; name: string }> };
          } | null;
          userErrors: Array<{ code?: string | null; field?: string[] | null; message: string }>;
        };
      }>(
        `#graphql
        mutation CreateFixtureSellingPlan(
          $input: SellingPlanGroupInput!,
          $resources: SellingPlanGroupResourceInput
        ) {
          sellingPlanGroupCreate(input: $input, resources: $resources) {
            sellingPlanGroup {
              id
              sellingPlans(first: 5) { nodes { id name } }
            }
            userErrors { code field message }
          }
        }
      `,
        {
          input: {
            name: "Ambrosia E2E subscription",
            merchantCode: "ambrosia-e2e-monthly",
            options: ["Delivery every"],
            position: 1,
            description: "Test-only monthly subscription used to verify Ambrosia parity.",
            sellingPlansToCreate: [
              {
                name: "Monthly subscription",
                options: ["1 month"],
                position: 1,
                category: "SUBSCRIPTION",
                billingPolicy: { recurring: { interval: "MONTH", intervalCount: 1 } },
                deliveryPolicy: { recurring: { interval: "MONTH", intervalCount: 1 } },
                inventoryPolicy: { reserve: "ON_FULFILLMENT" },
              },
            ],
          },
          resources: { productIds: [anchorProduct.id], productVariantIds: [] },
        },
      );
      if (result.sellingPlanGroupCreate.userErrors.length > 0) {
        throw new Error(
          `Unable to create the selling plan fixture: ${JSON.stringify(result.sellingPlanGroupCreate.userErrors)}`,
        );
      }
      sellingPlanId = result.sellingPlanGroupCreate.sellingPlanGroup?.sellingPlans.nodes[0]?.id;
    }
    if (!sellingPlanId) throw new Error("The anchor product has no usable selling plan.");

    const sourcePreset = getLegacyStorePreset(AMBROSIA_SHOP);
    if (!sourcePreset) throw new Error("The Ambrosia migration preset is not registered.");
    validateLegacyStorePreset(sourcePreset);
    const mapped = mapAmbrosiaPresetToDev(sourcePreset, {
      anchorProductId: anchorProduct.id,
      anchorVariantId: anchorVariant.id,
      frotherProductId: frother.product.id,
      otgProductId: otg.product.id,
      giftCardProductId: giftCard.product.id,
      thirdGiftProductId: shirt.id,
      shirtVariantIds: shirt.variants.nodes.map((variant) => variant.id),
      sellingPlanId,
    });
    for (const offer of mapped) {
      for (const condition of offer.conditions) {
        const validation = validateConditionValue(condition.conditionType, condition.value);
        if (!validation.success) {
          throw new Error(`Invalid mapped condition for ${offer.key}: ${validation.error.message}`);
        }
      }
      for (const reward of offer.rewards) {
        const validation = validateRewardPayload(
          reward.rewardType,
          reward.discountType,
          reward.value,
          reward.target,
        );
        if (!validation.success) {
          throw new Error(`Invalid mapped reward for ${offer.key}: ${validation.error.message}`);
        }
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .update(offers)
        .set({ status: "paused", updatedBy: "ambrosia-e2e-seeder", updatedAt: new Date() })
        .where(and(eq(offers.shopId, shop.id), eq(offers.internalName, "E2E Gift Offer")));

      for (const presetOffer of mapped) {
        const [existing] = await tx
          .select({ id: offers.id })
          .from(offers)
          .where(and(eq(offers.shopId, shop.id), eq(offers.internalName, presetOffer.internalName)))
          .limit(1);
        const offerId =
          existing?.id ??
          (
            await tx
              .insert(offers)
              .values({
                shopId: shop.id,
                type: presetOffer.type,
                status: presetOffer.status,
                internalName: presetOffer.internalName,
                publicTitle: presetOffer.publicTitle,
                description: presetOffer.description,
                priority: presetOffer.priority,
                discountTags: ["ambrosia-e2e"],
                createdBy: "ambrosia-e2e-seeder",
                updatedBy: "ambrosia-e2e-seeder",
              })
              .returning({ id: offers.id })
          )[0]?.id;
        if (!offerId) throw new Error(`Failed to upsert ${presetOffer.key}.`);

        if (existing) {
          await tx
            .update(offers)
            .set({
              type: presetOffer.type,
              status: presetOffer.status,
              publicTitle: presetOffer.publicTitle,
              description: presetOffer.description,
              priority: presetOffer.priority,
              compiledConfig: null,
              discountTags: ["ambrosia-e2e"],
              updatedBy: "ambrosia-e2e-seeder",
              updatedAt: new Date(),
            })
            .where(and(eq(offers.shopId, shop.id), eq(offers.id, offerId)));
          await Promise.all([
            tx
              .delete(offerConditions)
              .where(
                and(eq(offerConditions.shopId, shop.id), eq(offerConditions.offerId, offerId)),
              ),
            tx
              .delete(offerRewards)
              .where(and(eq(offerRewards.shopId, shop.id), eq(offerRewards.offerId, offerId))),
            tx
              .delete(offerCombinationPolicies)
              .where(
                and(
                  eq(offerCombinationPolicies.shopId, shop.id),
                  eq(offerCombinationPolicies.offerId, offerId),
                ),
              ),
          ]);
        }

        if (presetOffer.conditions.length > 0) {
          await tx.insert(offerConditions).values(
            presetOffer.conditions.map((condition, index) => ({
              shopId: shop.id,
              offerId,
              scope: "main" as const,
              conditionType: condition.conditionType,
              operator: condition.operator,
              value: condition.value,
              sortOrder: index,
              isEnabled: true,
            })),
          );
        }
        await tx.insert(offerRewards).values(
          presetOffer.rewards.map((reward, index) => ({
            shopId: shop.id,
            offerId,
            rewardType: reward.rewardType,
            discountType: reward.discountType,
            value: reward.value,
            target: reward.target,
            quantity: reward.quantity ?? null,
            isAutoAdd: reward.isAutoAdd ?? false,
            isCustomerSelectable: reward.isCustomerSelectable ?? false,
            trackMode: "variant",
            sortOrder: index,
            label: reward.label,
          })),
        );
        await tx.insert(offerCombinationPolicies).values({
          shopId: shop.id,
          offerId,
          combinesWithOrderDiscounts: true,
          combinesWithProductDiscounts: true,
          combinesWithShippingDiscounts: true,
          combinesWithOtherAppOffers: true,
        });
      }

      await tx
        .insert(appSettings)
        .values({
          shopId: shop.id,
          key: "ambrosia_e2e_fixture",
          value: JSON.stringify({
            anchorProductId: anchorProduct.id,
            anchorVariantId: anchorVariant.id,
            sellingPlanId,
            shirtProductId: shirt.id,
            shirtVariantIds: shirt.variants.nodes.map((variant) => variant.id),
            handles: {
              anchor: anchorProduct.handle,
              frother: frother.product.handle,
              otg: otg.product.handle,
              giftCard: giftCard.product.handle,
              shirt: shirt.handle,
            },
          }),
        })
        .onConflictDoUpdate({
          target: [appSettings.shopId, appSettings.key],
          set: {
            value: JSON.stringify({
              anchorProductId: anchorProduct.id,
              anchorVariantId: anchorVariant.id,
              sellingPlanId,
              shirtProductId: shirt.id,
              shirtVariantIds: shirt.variants.nodes.map((variant) => variant.id),
              handles: {
                anchor: anchorProduct.handle,
                frother: frother.product.handle,
                otg: otg.product.handle,
                giftCard: giftCard.product.handle,
                shirt: shirt.handle,
              },
            }),
            updatedAt: new Date(),
          },
        });
    });

    await publishOffersForShop(shop.id, DEV_SHOP);

    console.info(
      JSON.stringify(
        {
          shop: DEV_SHOP,
          sourceInventory: sourcePreset.offers.length,
          activeOffers: mapped.filter((offer) => offer.status === "active").length,
          draftOffers: mapped.filter((offer) => offer.status === "draft").length,
          anchor: {
            productHandle: anchorProduct.handle,
            productId: anchorProduct.id,
            variantId: anchorVariant.id,
            sellingPlanId,
          },
          shirt: {
            productHandle: shirt.handle,
            productId: shirt.id,
            variantIds: shirt.variants.nodes.map((variant) => variant.id),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDb();
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

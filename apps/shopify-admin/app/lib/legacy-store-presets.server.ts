import { and, eq, inArray } from "drizzle-orm";
import {
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  type Db,
} from "@promo/db";
import { validateConditionValue, validateRewardPayload } from "@promo/shared-types";

type ConditionPreset = {
  conditionType: string;
  operator: "eq" | "gte" | "all";
  value: Record<string, unknown>;
};

type RewardPreset = {
  rewardType: "product_gift" | "shipping_discount" | "product_discount";
  discountType: "percentage" | "fixed_price" | "free";
  value: Record<string, unknown>;
  target: Record<string, unknown>;
  quantity?: number;
  isAutoAdd?: boolean;
  isCustomerSelectable?: boolean;
  label: string;
};

export interface LegacyOfferPreset {
  key: string;
  internalName: string;
  publicTitle: string;
  description: string;
  type: "gift" | "discount";
  priority: number;
  conditions: ConditionPreset[];
  rewards: RewardPreset[];
}

export interface LegacyStorePreset {
  shopDomain: string;
  sourceName: string;
  offers: LegacyOfferPreset[];
  notes: string[];
}

const landingTarget = (
  target: Record<string, unknown>,
  source: string,
  anchorIds: string[],
  anchorQuantity: number,
  requiresSubscription = false,
) => ({
  ...target,
  scopeMode: "landing",
  requiredLineAttributeKey: "__landing_source",
  requiredLineAttributeValue: source,
  requiredAnchorVariantIds: anchorIds,
  requiredAnchorMinQuantity: anchorQuantity,
  requiresAnchorSubscription: requiresSubscription,
});

const HPN_PRESET: LegacyStorePreset = {
  shopDomain: "hpn-supplements.myshopify.com",
  sourceName: "HPN Supplements",
  notes: [],
  offers: [
    {
      key: "pa7-cross-sell",
      internalName: "[HPN preset] PA7 cross-sell",
      publicTitle: "Congratulations! 10% Off (when purchased with PA7)",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 100,
      conditions: [
        {
          conditionType: "specific_product",
          operator: "all",
          value: {
            requirements: [
              {
                productId: "gid://shopify/Product/1313973239892",
                trackMode: "product",
                minQuantity: 1,
              },
            ],
          },
        },
      ],
      rewards: [
        {
          rewardType: "product_discount",
          discountType: "percentage",
          value: { amount: 10, currencyCode: "USD" },
          target: {
            scopeMode: "sitewide",
            productIds: [
              "gid://shopify/Product/1319321763924",
              "gid://shopify/Product/1313557741652",
            ],
            lineQuantityEquals: 1,
            subscriptionMode: "any",
          },
          label: "PA7 cross-sell",
        },
      ],
    },
    {
      key: "nad3-single-planta-samples",
      internalName: "[HPN preset] NAD3 single Planta samples",
      publicTitle: "Free Planta Samples - NAD3 Subscription",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 101,
      conditions: [
        {
          conditionType: "specific_product",
          operator: "all",
          value: {
            requirements: [
              {
                variantId: "gid://shopify/ProductVariant/21174522675284",
                trackMode: "variant",
                minQuantity: 1,
              },
              {
                variantId: "gid://shopify/ProductVariant/40608348438665",
                trackMode: "variant",
                minQuantity: 1,
              },
              {
                variantId: "gid://shopify/ProductVariant/40608348373129",
                trackMode: "variant",
                minQuantity: 1,
              },
            ],
          },
        },
      ],
      rewards: [
        {
          rewardType: "product_discount",
          discountType: "free",
          value: { amount: 100, currencyCode: "USD" },
          target: {
            scopeMode: "sitewide",
            variantIds: [
              "gid://shopify/ProductVariant/40608348438665",
              "gid://shopify/ProductVariant/40608348373129",
            ],
            maxUnitsTotal: 2,
            subscriptionMode: "any",
          },
          label: "Free Planta samples",
        },
      ],
    },
    {
      key: "nad3-240-pouches",
      internalName: "[HPN preset] NAD3 240 free pouches",
      publicTitle: "Free 1-Week Pouches - NAD3 240 Bundle",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 102,
      conditions: [
        {
          conditionType: "specific_product",
          operator: "all",
          value: {
            requirements: [
              {
                productId: "gid://shopify/Product/6784435060873",
                trackMode: "product",
                minQuantity: 1,
              },
              {
                variantId: "gid://shopify/ProductVariant/44633124995209",
                trackMode: "variant",
                minQuantity: 1,
              },
              {
                variantId: "gid://shopify/ProductVariant/44633124864137",
                trackMode: "variant",
                minQuantity: 1,
              },
            ],
          },
        },
      ],
      rewards: [
        {
          rewardType: "product_discount",
          discountType: "free",
          value: { amount: 100, currencyCode: "USD" },
          target: {
            scopeMode: "sitewide",
            variantIds: [
              "gid://shopify/ProductVariant/44633124995209",
              "gid://shopify/ProductVariant/44633124864137",
            ],
            maxUnitsTotal: 2,
            subscriptionMode: "any",
          },
          label: "Free one-week pouches",
        },
      ],
    },
  ],
};

const ONE_SOL_VARIANTS = [
  "gid://shopify/ProductVariant/42477833322735",
  "gid://shopify/ProductVariant/44045687324911",
  "gid://shopify/ProductVariant/46171937145071",
  "gid://shopify/ProductVariant/46171936981231",
];

const ONE_SOL_PRESET: LegacyStorePreset = {
  shopDomain: "onesolsupps.myshopify.com",
  sourceName: "One Sol",
  notes: [],
  offers: [
    {
      key: "acai-unicorn-onetime-25-off",
      internalName: "[HPN preset] Acai and Unicorn one-time 25% off",
      publicTitle: "25% off Acai Berry Blast / Unicorn Milkshake",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 100,
      conditions: [],
      rewards: [
        {
          rewardType: "product_discount",
          discountType: "percentage",
          value: { amount: 25, currencyCode: "USD" },
          target: {
            scopeMode: "sitewide",
            variantIds: ONE_SOL_VARIANTS,
            subscriptionMode: "one_time_only",
          },
          label: "One-time purchase discount",
        },
      ],
    },
  ],
};

const AMBROSIA_ANCHORS = [
  "gid://shopify/ProductVariant/39328106578005",
  "gid://shopify/ProductVariant/7623220887605",
  "gid://shopify/ProductVariant/41064870707285",
  "gid://shopify/ProductVariant/40818314149973",
  "gid://shopify/ProductVariant/22546471419989",
  "gid://shopify/ProductVariant/40451298263125",
];

const AMBROSIA_PLANTA_ANCHORS = [
  "gid://shopify/ProductVariant/42536493613141",
  "gid://shopify/ProductVariant/12796283650101",
  "gid://shopify/ProductVariant/32940576014421",
  "gid://shopify/ProductVariant/40815124316245",
  "gid://shopify/ProductVariant/21053881581653",
  "gid://shopify/ProductVariant/21240149803093",
  "gid://shopify/ProductVariant/22546599379029",
  "gid://shopify/ProductVariant/31701929885781",
  "gid://shopify/ProductVariant/32444848275541",
  "gid://shopify/ProductVariant/39908414029909",
  "gid://shopify/ProductVariant/21236091813973",
  "gid://shopify/ProductVariant/21240149770325",
  "gid://shopify/ProductVariant/21281942110293",
  "gid://shopify/ProductVariant/32900793827413",
];

const AMBROSIA_TARGET_FROTHER = "gid://shopify/Product/7533558595669";
const AMBROSIA_TARGET_OTG = "gid://shopify/Product/7416485609557";
const AMBROSIA_TARGET_GIFT_CARD = "gid://shopify/Product/6564143956053";
const AMBROSIA_TARGET_THIRD_GIFT = "gid://shopify/Product/6564118429781";

function ambrosiaLandingOffer(
  key: string,
  title: string,
  source: string,
  targetProductIds: string[],
  anchorVariantIds: string[],
  anchorQuantity = 1,
  requiresSubscription = true,
  priority = 100,
): LegacyOfferPreset {
  return {
    key,
    internalName: `[Ambrosia migration] ${key}`,
    publicTitle: title,
    description:
      "Imported from the verified active hpn-scripts-migration configuration. Created as a draft for review.",
    type: "discount",
    priority,
    conditions: [],
    rewards: [
      {
        rewardType: "product_discount",
        discountType: "free",
        value: { amount: 100, currencyCode: "USD" },
        target: landingTarget(
          { productIds: targetProductIds, subscriptionMode: "any" },
          source,
          anchorVariantIds,
          anchorQuantity,
          requiresSubscription,
        ),
        label: title,
      },
    ],
  };
}

const AMBROSIA_PRESET: LegacyStorePreset = {
  shopDomain: "ambrosia-nutraceuticals.myshopify.com",
  sourceName: "Ambrosia",
  notes: [
    "Snapshot verified against the active Ambrosia app discount on 2026-09-24.",
    "The two shipping rules were disabled in the source and are imported as drafts with that fact recorded in their descriptions.",
  ],
  offers: [
    ambrosiaLandingOffer(
      "nektar-glp1-shaker-gift",
      "Nektar GLP-1 Starter Kit",
      "nektar-glp1-sk",
      [AMBROSIA_TARGET_FROTHER],
      AMBROSIA_ANCHORS,
      1,
      true,
      100,
    ),
    ambrosiaLandingOffer(
      "landing-nektar-skin-v2",
      "Frother and Gift Card unlocked!",
      "nektar-skin-v2",
      [AMBROSIA_TARGET_FROTHER],
      AMBROSIA_ANCHORS,
      1,
      true,
      101,
    ),
    {
      key: "cart-subtotal-free-gift-mtrcmr6l",
      internalName: "[Ambrosia migration] cart-subtotal-free-gift-mtrcmr6l",
      publicTitle: "Labor Day Sale | FREE Ambrosia Athletic Club T-Shirt",
      description:
        "Imported from the verified active hpn-scripts-migration configuration. Created as a draft for review.",
      type: "gift",
      priority: 102,
      conditions: [
        {
          conditionType: "cart_value",
          operator: "gte",
          value: { thresholdCents: 8500, currencyCode: "USD", includeGiftValues: false },
        },
      ],
      rewards: [
        {
          rewardType: "product_gift",
          discountType: "free",
          value: { amount: 100, currencyCode: "USD" },
          target: {
            variantIds: [
              "gid://shopify/ProductVariant/42872167202901",
              "gid://shopify/ProductVariant/42872167235669",
              "gid://shopify/ProductVariant/42872167268437",
              "gid://shopify/ProductVariant/42872167301205",
            ],
          },
          quantity: 1,
          isAutoAdd: false,
          isCustomerSelectable: true,
          label: "Labor Day Sale | FREE Ambrosia Athletic Club T-Shirt",
        },
      ],
    },
    {
      key: "sitewide-free-shipping-mtt2zu2r",
      internalName: "[Ambrosia migration] sitewide-free-shipping-mtt2zu2r",
      publicTitle: "Shipping discount!",
      description:
        "Disabled in the verified Ambrosia source configuration. Imported as a draft for parity and future review.",
      type: "discount",
      priority: 103,
      conditions: [],
      rewards: [
        {
          rewardType: "shipping_discount",
          discountType: "percentage",
          value: {
            amount: 100,
            currencyCode: "USD",
            tiers: [
              {
                minimumSubtotalCents: 5000,
                discountType: "percentage",
                discountValue: 50,
                appliesWhen: "has_subscription",
              },
              {
                minimumSubtotalCents: 8000,
                discountType: "percentage",
                discountValue: 100,
                appliesWhen: "has_subscription",
              },
              {
                minimumSubtotalCents: 9000,
                discountType: "percentage",
                discountValue: 50,
                appliesWhen: "one_time_only",
              },
            ],
          },
          target: {
            deliveryGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"],
            scopeMode: "sitewide",
          },
          label: "Shipping discount!",
        },
      ],
    },
    {
      key: "landing-free-shipping-mtt5s7nx",
      internalName: "[Ambrosia migration] landing-free-shipping-mtt5s7nx",
      publicTitle: "Congrats! 50% shipping discount",
      description:
        "Disabled in the verified Ambrosia source configuration. The stored tier grants 25%; imported as a draft without changing that source behavior.",
      type: "discount",
      priority: 104,
      conditions: [],
      rewards: [
        {
          rewardType: "shipping_discount",
          discountType: "percentage",
          value: {
            amount: 100,
            currencyCode: "USD",
            tiers: [
              {
                minimumSubtotalCents: 2500,
                discountType: "percentage",
                discountValue: 25,
                appliesWhen: "has_subscription",
              },
            ],
          },
          target: landingTarget(
            { deliveryGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"] },
            "nektar-glp1-sk",
            ["gid://shopify/ProductVariant/7623220887605"],
            1,
            true,
          ),
          label: "Congrats! 50% shipping discount",
        },
      ],
    },
    ambrosiaLandingOffer(
      "landing-kinetic-sk-otg-freegifts",
      'Kinetic "on the go" Kit Gifts!',
      "kinetic-sk-otg",
      [AMBROSIA_TARGET_GIFT_CARD, AMBROSIA_TARGET_OTG],
      [
        "gid://shopify/ProductVariant/40818313003093",
        "gid://shopify/ProductVariant/39575663738965",
        "gid://shopify/ProductVariant/39500842565717",
        "gid://shopify/ProductVariant/39500842532949",
      ],
      1,
      true,
      105,
    ),
    ambrosiaLandingOffer(
      "landing-atlas-sk-otg-freegifts",
      'Atlas "on the go" Kit Gifts!',
      "atlas-sk-otg",
      [AMBROSIA_TARGET_GIFT_CARD, AMBROSIA_TARGET_OTG, AMBROSIA_TARGET_THIRD_GIFT],
      [],
      1,
      true,
      106,
    ),
    ambrosiaLandingOffer(
      "landing-nektar-sk-otg-freegifts",
      'Nektar "on the go" Kit Gifts!',
      "nektar-sk-otg",
      [AMBROSIA_TARGET_OTG],
      AMBROSIA_ANCHORS,
      1,
      true,
      107,
    ),
    ambrosiaLandingOffer(
      "landing-planta-sk-otg-freegifts",
      'Planta "on the go" Kit Gifts!',
      "planta-sk-otg",
      [AMBROSIA_TARGET_OTG],
      AMBROSIA_PLANTA_ANCHORS,
      1,
      true,
      108,
    ),
    ambrosiaLandingOffer(
      "landing-scoped-product-mtvt54kq",
      "Planta+Atlas Combo Gifts!",
      "planta-atlas-combo-sk",
      [AMBROSIA_TARGET_OTG, AMBROSIA_TARGET_GIFT_CARD],
      [
        "gid://shopify/ProductVariant/42536493613141",
        "gid://shopify/ProductVariant/42465588576341",
        "gid://shopify/ProductVariant/42465588609109",
        ...AMBROSIA_PLANTA_ANCHORS.slice(1),
      ],
      2,
      false,
      109,
    ),
    ambrosiaLandingOffer(
      "landing-nektar-sk-special-nfgc10kit",
      "Congratulations! Free Gifts added",
      "nektar-sk-special-offer",
      [AMBROSIA_TARGET_FROTHER],
      AMBROSIA_ANCHORS,
      1,
      true,
      110,
    ),
  ],
};

const TRU_VARIANTS = [
  "gid://shopify/ProductVariant/31358533206097",
  "gid://shopify/ProductVariant/31358533140561",
  "gid://shopify/ProductVariant/39594543808593",
  "gid://shopify/ProductVariant/31358533271633",
  "gid://shopify/ProductVariant/31927032250449",
  "gid://shopify/ProductVariant/32642048393297",
  "gid://shopify/ProductVariant/31358533468241",
  "gid://shopify/ProductVariant/32773556240465",
];
const TRU_SOURCE = "protein-complete-lp";

function truLandingGift(
  key: string,
  title: string,
  productId: string,
  minimumQuantity: number,
): LegacyOfferPreset {
  return {
    key,
    internalName: `[HPN preset] ${title}`,
    publicTitle: "Protein Complete Bundle",
    description: "Imported from hpn-scripts-migration. Created as a draft for review.",
    type: "discount",
    priority: 110 + minimumQuantity,
    conditions: [],
    rewards: [
      {
        rewardType: "product_discount",
        discountType: "free",
        value: { amount: 100, currencyCode: "USD" },
        target: landingTarget(
          { productIds: [productId], subscriptionMode: "any" },
          TRU_SOURCE,
          TRU_VARIANTS,
          minimumQuantity,
        ),
        label: title,
      },
    ],
  };
}

const GETTRU_PRESET: LegacyStorePreset = {
  shopDomain: "gettrusupps.myshopify.com",
  sourceName: "GetTru Supplements",
  notes: [
    "Swell reward records are retained as a migration note only: the legacy app also leaves them as no-ops because a Shopify Function cannot securely validate Swell redemption tokens without the Swell secret.",
  ],
  offers: [
    {
      key: "protein-landing-subscription-tiers",
      internalName: "[HPN preset] Protein landing subscription tiers",
      publicTitle: "Protein Complete Bundle",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 100,
      conditions: [],
      rewards: [
        {
          rewardType: "product_discount",
          discountType: "fixed_price",
          value: { amount: 0, currencyCode: "USD" },
          target: landingTarget(
            {
              variantIds: TRU_VARIANTS,
              subscriptionMode: "subscription_only",
              priceTiers: [
                { quantity: 1, targetPricePerUnit: 45 },
                { quantity: 2, targetPricePerUnit: 38.25 },
                { quantity: 3, targetPricePerUnit: 36 },
                { quantity: 4, targetPricePerUnit: 33.75 },
              ],
            },
            TRU_SOURCE,
            [],
            1,
          ),
          label: "Subscription price tiers",
        },
      ],
    },
    {
      key: "protein-landing-onetime-tiers",
      internalName: "[HPN preset] Protein landing one-time tiers",
      publicTitle: "Protein Complete Bundle",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 101,
      conditions: [],
      rewards: [
        {
          rewardType: "product_discount",
          discountType: "fixed_price",
          value: { amount: 0, currencyCode: "USD" },
          target: landingTarget(
            {
              variantIds: TRU_VARIANTS,
              subscriptionMode: "one_time_only",
              priceTiers: [
                { quantity: 1, targetPricePerUnit: 49.99 },
                { quantity: 2, targetPricePerUnit: 42.49 },
                { quantity: 3, targetPricePerUnit: 39.99 },
                { quantity: 4, targetPricePerUnit: 37.49 },
              ],
            },
            TRU_SOURCE,
            [],
            1,
          ),
          label: "One-time price tiers",
        },
      ],
    },
    truLandingGift(
      "protein-landing-recipe-ebook",
      "Protein landing recipe ebook",
      "gid://shopify/Product/15083050828144",
      1,
    ),
    truLandingGift(
      "protein-landing-shaker",
      "Protein landing shaker",
      "gid://shopify/Product/15030069100912",
      3,
    ),
    truLandingGift(
      "protein-landing-resistance-bands",
      "Protein landing resistance bands",
      "gid://shopify/Product/7461732286545",
      4,
    ),
    {
      key: "protein-landing-free-shipping",
      internalName: "[HPN preset] Protein landing free shipping",
      publicTitle: "Protein Complete Bundle",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 120,
      conditions: [],
      rewards: [
        {
          rewardType: "shipping_discount",
          discountType: "free",
          value: { amount: 100, currencyCode: "USD" },
          target: {
            deliveryGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"],
            ...landingTarget({}, TRU_SOURCE, TRU_VARIANTS, 2),
          },
          label: "Free shipping",
        },
      ],
    },
    {
      key: "quiz-bundle-price-match",
      internalName: "[HPN preset] Quiz bundle price match",
      publicTitle: "Product Quiz Bundle",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 130,
      conditions: [],
      rewards: [
        {
          rewardType: "product_discount",
          discountType: "fixed_price",
          value: { amount: 0, currencyCode: "USD" },
          target: { scopeMode: "quiz_bundle", scope: "cart", discountPercentageOnGifts: 100 },
          label: "Quiz bundle price match",
        },
      ],
    },
    {
      key: "quiz-bundle-free-shipping",
      internalName: "[HPN preset] Quiz bundle free shipping",
      publicTitle: "Product Quiz Bundle",
      description: "Imported from hpn-scripts-migration. Created as a draft for review.",
      type: "discount",
      priority: 131,
      conditions: [],
      rewards: [
        {
          rewardType: "shipping_discount",
          discountType: "free",
          value: { amount: 100, currencyCode: "USD" },
          target: {
            deliveryGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"],
            scopeMode: "quiz_bundle",
          },
          label: "Quiz bundle free shipping",
        },
      ],
    },
  ],
};

const PRESETS: Record<string, LegacyStorePreset> = Object.fromEntries(
  [HPN_PRESET, ONE_SOL_PRESET, AMBROSIA_PRESET, GETTRU_PRESET].map((preset) => [
    preset.shopDomain,
    preset,
  ]),
);

export function getLegacyStorePreset(shopDomain: string): LegacyStorePreset | null {
  return PRESETS[shopDomain.toLowerCase()] ?? null;
}

export function validateLegacyStorePreset(preset: LegacyStorePreset): void {
  for (const offer of preset.offers) {
    for (const condition of offer.conditions) {
      const parsed = validateConditionValue(condition.conditionType, condition.value);
      if (!parsed.success) {
        throw new Error(
          `Invalid condition in preset ${offer.key}: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
        );
      }
    }
    for (const reward of offer.rewards) {
      const parsed = validateRewardPayload(
        reward.rewardType,
        reward.discountType,
        reward.value,
        reward.target,
      );
      if (!parsed.success) {
        throw new Error(
          `Invalid reward in preset ${offer.key}: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
        );
      }
    }
  }
}

export async function inspectLegacyPreset(db: Db, shopId: string, preset: LegacyStorePreset) {
  const names = preset.offers.map((offer) => offer.internalName);
  const existing =
    names.length === 0
      ? []
      : await db
          .select({ internalName: offers.internalName })
          .from(offers)
          .where(and(eq(offers.shopId, shopId), inArray(offers.internalName, names)));
  const existingNames = new Set(existing.map((offer) => offer.internalName));
  return preset.offers.map((offer) => ({
    ...offer,
    alreadyImported: existingNames.has(offer.internalName),
  }));
}

export async function importLegacyPreset(db: Db, shopId: string, preset: LegacyStorePreset) {
  validateLegacyStorePreset(preset);
  const inspected = await inspectLegacyPreset(db, shopId, preset);
  const pending = inspected.filter((offer) => !offer.alreadyImported);
  let created = 0;

  for (const presetOffer of pending) {
    await db.transaction(async (tx) => {
      const [createdOffer] = await tx
        .insert(offers)
        .values({
          shopId,
          type: presetOffer.type,
          status: "draft",
          internalName: presetOffer.internalName,
          publicTitle: presetOffer.publicTitle,
          description: presetOffer.description,
          priority: presetOffer.priority,
          createdBy: "legacy-preset-importer",
          updatedBy: "legacy-preset-importer",
        })
        .returning({ id: offers.id });
      if (!createdOffer) throw new Error(`Failed to create ${presetOffer.internalName}.`);

      if (presetOffer.conditions.length > 0)
        await tx.insert(offerConditions).values(
          presetOffer.conditions.map((condition, index) => ({
            shopId,
            offerId: createdOffer.id,
            scope: "main" as const,
            conditionType: condition.conditionType,
            operator: condition.operator,
            value: condition.value,
            sortOrder: index,
            isEnabled: true,
          })),
        );
      await tx.insert(offerRewards).values(
        presetOffer.rewards.map((reward, index) => ({
          shopId,
          offerId: createdOffer.id,
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
      await tx.insert(offerCombinationPolicies).values({ shopId, offerId: createdOffer.id });
    });
    created += 1;
  }

  return { created, skipped: inspected.length - created, total: inspected.length };
}

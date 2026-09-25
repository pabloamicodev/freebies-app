/**
 * Read-only verification for the Ambrosia parity fixture in hpn-test-store.
 *
 * It cross-checks the relational source of truth, the compiled per-offer
 * payloads, both Shopify automatic-discount metafields, and the development
 * catalog used by browser tests. It never mutates Shopify or the database.
 */

import assert from "node:assert/strict";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { mapAmbrosiaPresetToDev } from "./seed-ambrosia-e2e.js";

const DEV_SHOP = "hpn-test-store.myshopify.com";
const AMBROSIA_SHOP = "ambrosia-nutraceuticals.myshopify.com";
const PREFIX = "[Ambrosia E2E] ";

interface FixtureSetting {
  anchorProductId: string;
  anchorVariantId: string;
  sellingPlanId: string;
  shirtProductId: string;
  shirtVariantIds: string[];
  handles: {
    anchor: string;
    frother: string;
    otg: string;
    giftCard: string;
    shirt: string;
  };
}

interface CompiledConfig {
  offers: Array<{ id: string; [key: string]: unknown }>;
  shippingOffers: unknown[];
  version: string;
  compiledAt: string;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}

function assertJsonEqual(actual: unknown, expected: unknown, context: string): void {
  assert.ok(
    isDeepStrictEqual(actual, expected),
    `${context} mismatch.\nExpected: ${sortedJson(expected)}\nActual: ${sortedJson(actual)}`,
  );
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
    { and, asc, eq, inArray, like },
    {
      appSettings,
      closeDb,
      getDb,
      offerCombinationPolicies,
      offerConditions,
      offerRewards,
      offers,
      shops,
      shopifySessions,
    },
    { getLegacyStorePreset },
    { shopifyGraphQL },
  ] = await Promise.all([
    import("drizzle-orm"),
    import("@promo/db"),
    import("../apps/shopify-admin/app/lib/legacy-store-presets.server.js"),
    import("../apps/shopify-admin/app/lib/shopify-fetch.server.js"),
  ]);

  const db = getDb();
  try {
    const [shop] = await db
      .select()
      .from(shops)
      .where(and(eq(shops.myshopifyDomain, DEV_SHOP), eq(shops.isActive, true)))
      .limit(1);
    assert.ok(shop, `Active development tenant ${DEV_SHOP} was not found.`);
    assert.ok(shop.discountId, "The cart-lines automatic discount is not registered.");
    assert.ok(shop.deliveryDiscountId, "The delivery automatic discount is not registered.");

    const [session] = await db
      .select({ accessToken: shopifySessions.accessToken })
      .from(shopifySessions)
      .where(and(eq(shopifySessions.shop, DEV_SHOP), eq(shopifySessions.isOnline, false)))
      .limit(1);
    assert.ok(session?.accessToken, "The development tenant has no offline Shopify session.");

    const [fixtureRow] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(and(eq(appSettings.shopId, shop.id), eq(appSettings.key, "ambrosia_e2e_fixture")))
      .limit(1);
    assert.ok(fixtureRow, "The Ambrosia E2E fixture setting is missing.");
    const fixture = JSON.parse(fixtureRow.value) as FixtureSetting;
    assert.equal(fixture.shirtVariantIds.length, 4, "The shirt fixture must have four variants.");

    const admin = <T>(query: string, variables: Record<string, unknown> = {}) =>
      shopifyGraphQL<T>({
        shopDomain: DEV_SHOP,
        accessToken: session.accessToken!,
        query,
        variables,
      });

    const fetchProduct = async (handle: string) => {
      const data = await admin<{
        products: {
          nodes: Array<{
            id: string;
            handle: string;
            status: string;
            onlineStoreUrl: string | null;
            variants: { nodes: Array<{ id: string; title: string }> };
            sellingPlanGroups: { nodes: Array<{ sellingPlans: { nodes: Array<{ id: string }> } }> };
          }>;
        };
      }>(
        `#graphql
        query VerifyFixtureProduct($query: String!) {
          products(first: 2, query: $query) {
            nodes {
              id handle status onlineStoreUrl
              variants(first: 20) { nodes { id title } }
              sellingPlanGroups(first: 10) { nodes { sellingPlans(first: 10) { nodes { id } } } }
            }
          }
        }
      `,
        { query: `handle:${handle}` },
      );
      const product = data.products.nodes.find((candidate) => candidate.handle === handle);
      assert.ok(product, `Shopify product ${handle} is missing.`);
      assert.equal(product.status, "ACTIVE", `Shopify product ${handle} is not active.`);
      return product;
    };

    const [anchor, frother, otg, giftCard, shirt] = await Promise.all([
      fetchProduct(fixture.handles.anchor),
      fetchProduct(fixture.handles.frother),
      fetchProduct(fixture.handles.otg),
      fetchProduct(fixture.handles.giftCard),
      fetchProduct(fixture.handles.shirt),
    ]);
    assert.equal(anchor.id, fixture.anchorProductId);
    assert.ok(anchor.variants.nodes.some((variant) => variant.id === fixture.anchorVariantId));
    assert.ok(
      anchor.sellingPlanGroups.nodes
        .flatMap((group) => group.sellingPlans.nodes)
        .some((plan) => plan.id === fixture.sellingPlanId),
      "The configured subscription selling plan is not attached to the anchor product.",
    );
    assert.equal(shirt.id, fixture.shirtProductId);
    assert.deepEqual(
      shirt.variants.nodes.map((variant) => variant.id),
      fixture.shirtVariantIds,
    );

    const preset = getLegacyStorePreset(AMBROSIA_SHOP);
    assert.ok(preset, "The verified Ambrosia preset is not registered.");
    const expected = mapAmbrosiaPresetToDev(preset, {
      anchorProductId: anchor.id,
      anchorVariantId: fixture.anchorVariantId,
      frotherProductId: frother.id,
      otgProductId: otg.id,
      giftCardProductId: giftCard.id,
      thirdGiftProductId: shirt.id,
      shirtVariantIds: fixture.shirtVariantIds,
      sellingPlanId: fixture.sellingPlanId,
    });

    const rows = await db
      .select()
      .from(offers)
      .where(and(eq(offers.shopId, shop.id), like(offers.internalName, `${PREFIX}%`)))
      .orderBy(asc(offers.priority));
    assert.equal(rows.length, 11, "The database must contain exactly eleven Ambrosia E2E offers.");
    const offerIds = rows.map((row) => row.id);
    const [conditions, rewards, policies] = await Promise.all([
      db
        .select()
        .from(offerConditions)
        .where(and(eq(offerConditions.shopId, shop.id), inArray(offerConditions.offerId, offerIds)))
        .orderBy(asc(offerConditions.sortOrder)),
      db
        .select()
        .from(offerRewards)
        .where(and(eq(offerRewards.shopId, shop.id), inArray(offerRewards.offerId, offerIds)))
        .orderBy(asc(offerRewards.sortOrder)),
      db
        .select()
        .from(offerCombinationPolicies)
        .where(
          and(
            eq(offerCombinationPolicies.shopId, shop.id),
            inArray(offerCombinationPolicies.offerId, offerIds),
          ),
        ),
    ]);

    for (const expectedOffer of expected) {
      const row = rows.find((candidate) => candidate.internalName === expectedOffer.internalName);
      assert.ok(row, `Database offer ${expectedOffer.key} is missing.`);
      assert.equal(row.status, expectedOffer.status, `${expectedOffer.key} status`);
      assert.equal(row.type, expectedOffer.type, `${expectedOffer.key} type`);
      assert.equal(row.priority, expectedOffer.priority, `${expectedOffer.key} priority`);
      assert.equal(row.publicTitle, expectedOffer.publicTitle, `${expectedOffer.key} title`);
      assert.equal(
        policies.filter((policy) => policy.offerId === row.id).length,
        1,
        `${expectedOffer.key} policy count`,
      );

      const actualConditions = conditions
        .filter((condition) => condition.offerId === row.id)
        .map((condition) => ({
          conditionType: condition.conditionType,
          operator: condition.operator,
          value: condition.value,
        }));
      assertJsonEqual(
        actualConditions,
        expectedOffer.conditions,
        `${expectedOffer.key} conditions`,
      );
      const actualRewards = rewards
        .filter((reward) => reward.offerId === row.id)
        .map((reward) => ({
          rewardType: reward.rewardType,
          discountType: reward.discountType,
          value: reward.value,
          target: reward.target,
          quantity: reward.quantity,
          isAutoAdd: reward.isAutoAdd,
          isCustomerSelectable: reward.isCustomerSelectable,
          label: reward.label ?? "",
        }));
      const expectedRewards = expectedOffer.rewards.map((reward) => ({
        rewardType: reward.rewardType,
        discountType: reward.discountType,
        value: reward.value,
        target: reward.target,
        quantity: reward.quantity ?? null,
        isAutoAdd: reward.isAutoAdd ?? false,
        isCustomerSelectable: reward.isCustomerSelectable ?? false,
        label: reward.label,
      }));
      assertJsonEqual(actualRewards, expectedRewards, `${expectedOffer.key} rewards`);
      if (row.status === "active")
        assert.ok(row.compiledConfig, `${expectedOffer.key} was not compiled.`);
      else
        assert.equal(
          row.compiledConfig,
          null,
          `${expectedOffer.key} is a draft but has compiled config.`,
        );
    }

    const remote = await admin<{
      nodes: Array<null | {
        id: string;
        metafield: null | { value: string };
        automaticDiscount: null | {
          title: string;
          status: string;
        };
      }>;
    }>(
      `#graphql
      query VerifyAmbrosiaDiscounts($ids: [ID!]!) {
        nodes(ids: $ids) {
          id
          ... on DiscountAutomaticNode {
            metafield(namespace: "promo_engine", key: "function_config") { value }
            automaticDiscount {
              ... on DiscountAutomaticApp {
                title status
              }
            }
          }
        }
      }
    `,
      { ids: [shop.discountId, shop.deliveryDiscountId] },
    );
    assert.equal(remote.nodes.length, 2);
    const configs = remote.nodes.map((node) => {
      assert.ok(
        node?.automaticDiscount,
        `Shopify discount node ${node?.id ?? "unknown"} is missing.`,
      );
      assert.equal(
        node.automaticDiscount.status,
        "ACTIVE",
        `${node.automaticDiscount.title} is not active.`,
      );
      assert.ok(node.metafield?.value, `${node.automaticDiscount.title} has no function config.`);
      return JSON.parse(node.metafield.value) as CompiledConfig;
    });
    assertJsonEqual(configs[0], configs[1], "Cart and delivery discount metafields");

    const published = configs[0]!;
    assert.equal(published.version, "1");
    assert.ok(
      !Number.isNaN(Date.parse(published.compiledAt)),
      "compiledAt is not an ISO timestamp.",
    );
    assert.deepEqual(
      published.shippingOffers,
      [],
      "Disabled Ambrosia shipping rules must not be published.",
    );
    const activeRows = rows.filter((row) => row.status === "active");
    const draftRows = rows.filter((row) => row.status === "draft");
    assert.equal(activeRows.length, 9);
    assert.equal(draftRows.length, 2);
    for (const row of activeRows) {
      const compiled = published.offers.find((offer) => offer.id === row.id);
      assert.ok(compiled, `${row.internalName} is absent from Shopify's published config.`);
      assertJsonEqual(
        compiled,
        row.compiledConfig,
        `${row.internalName} published compiled config`,
      );
    }
    for (const row of draftRows) {
      assert.ok(
        !published.offers.some((offer) => offer.id === row.id),
        `${row.internalName} draft leaked into Shopify config.`,
      );
    }

    const storefrontResponse = await fetch(
      `https://${DEV_SHOP}/products/${fixture.handles.anchor}`,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const storefrontLocation = storefrontResponse.headers.get("location");
    const storefrontBlocked =
      storefrontResponse.status >= 300 &&
      storefrontResponse.status < 400 &&
      storefrontLocation?.includes("/password") === true;
    if (process.argv.includes("--require-storefront")) {
      assert.ok(
        !storefrontBlocked,
        "The development storefront redirects to /password; browser E2E cannot run.",
      );
    }

    console.info(
      JSON.stringify(
        {
          shop: DEV_SHOP,
          database: { total: rows.length, active: activeRows.length, draft: draftRows.length },
          shopify: {
            automaticDiscounts: remote.nodes.map((node) => ({
              id: node?.id,
              title: node?.automaticDiscount?.title,
              status: node?.automaticDiscount?.status,
            })),
            publishedOfferCount: published.offers.length,
            ambrosiaPublishedOfferCount: activeRows.length,
            publishedShippingOfferCount: published.shippingOffers.length,
          },
          fixtures: {
            anchor: {
              handle: anchor.handle,
              onlineStoreUrl: anchor.onlineStoreUrl,
              sellingPlanId: fixture.sellingPlanId,
            },
            shirt: {
              handle: shirt.handle,
              onlineStoreUrl: shirt.onlineStoreUrl,
              variants: shirt.variants.nodes.length,
            },
          },
          storefront: {
            status: storefrontResponse.status,
            redirectLocation: storefrontLocation,
            passwordProtected: storefrontBlocked,
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

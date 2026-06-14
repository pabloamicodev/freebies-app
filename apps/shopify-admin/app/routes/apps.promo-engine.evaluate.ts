import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import {
  offers,
  offerConditions,
  offerRewards,
  offerCombinationPolicies,
} from "@promo/db";
import { EvaluationInputSchema, type EvaluationInput } from "@promo/shared-types";
import { evaluate, type OfferDefinition } from "@promo/rule-engine";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";

export function loader(_args: LoaderFunctionArgs) {
  throw new Response("Method not allowed", { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  const signedShop = await getSignedShop(request);
  const signedShopDomain = signedShop.shopDomain;
  const body = await request.json().catch(() => null);
  const parsed = EvaluationInputSchema.safeParse({
    ...(body ?? {}),
    shopDomain: signedShopDomain,
  });

  if (!parsed.success) {
    return Response.json({ error: "Invalid evaluation payload" }, { status: 400 });
  }

  const { db } = signedShop;

  const activeOffers = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, signedShop.id), eq(offers.status, "active")))
    .orderBy(offers.priority);

  const offerIds = activeOffers.map((offer) => offer.id);
  const [conditions, rewards, policies] = offerIds.length > 0
    ? await Promise.all([
        db.select().from(offerConditions).where(and(eq(offerConditions.shopId, signedShop.id), inArray(offerConditions.offerId, offerIds))),
        db.select().from(offerRewards).where(and(eq(offerRewards.shopId, signedShop.id), inArray(offerRewards.offerId, offerIds))),
        db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, signedShop.id), inArray(offerCombinationPolicies.offerId, offerIds))),
      ])
    : [[], [], []];

  const policyByOffer = new Map(policies.map((policy) => [policy.offerId, policy]));
  const offerDefinitions: OfferDefinition[] = activeOffers.map((offer) => {
    const policy = policyByOffer.get(offer.id);
    return {
      id: offer.id,
      version: 1,
      type: offer.type,
      priority: offer.priority,
      stopLowerPriority: policy?.stopLowerPriority ?? false,
      startsAt: offer.startsAt,
      endsAt: offer.endsAt,
      conditions: conditions
        .filter((condition) => condition.offerId === offer.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((condition) => ({
          id: condition.id,
          scope: condition.scope,
          conditionType: condition.conditionType,
          operator: condition.operator,
          value: condition.value,
          isEnabled: condition.isEnabled,
          sortOrder: condition.sortOrder,
        })),
      rewards: rewards
        .filter((reward) => reward.offerId === offer.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((reward) => ({
          id: reward.id,
          rewardType: reward.rewardType,
          discountType: reward.discountType,
          value: reward.value,
          target: reward.target,
          quantity: reward.quantity,
          isAutoAdd: reward.isAutoAdd,
          isCustomerSelectable: reward.isCustomerSelectable,
          trackMode: reward.trackMode as "product" | "variant",
          sortOrder: reward.sortOrder,
          label: reward.label,
        })),
      combinationPolicy: {
        combinesWithOrderDiscounts: policy?.combinesWithOrderDiscounts ?? true,
        combinesWithProductDiscounts: policy?.combinesWithProductDiscounts ?? true,
        combinesWithShippingDiscounts: policy?.combinesWithShippingDiscounts ?? true,
        stopLowerPriority: policy?.stopLowerPriority ?? false,
        maxApplicationsPerCart: policy?.maxApplicationsPerCart ?? null,
        maxApplicationsPerCustomer: policy?.maxApplicationsPerCustomer ?? null,
      },
      giftValueCountsForOtherOffers: policy?.giftValueCountsForOtherOffers ?? false,
    };
  });

  const input: EvaluationInput = {
    ...parsed.data,
    shopDomain: signedShopDomain,
  };

  const result = await evaluate(input, {
    offers: offerDefinitions,
    oneUseStates: [],
    now: new Date(),
    shopCurrencyCode: signedShop.currencyCode ?? undefined,
  });

  return Response.json(result);
}

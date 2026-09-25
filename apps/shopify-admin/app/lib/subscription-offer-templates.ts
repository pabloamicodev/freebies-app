// Subscription "offers" are not rows in `offers`: cycle pricing lives in Shopify
// Selling Plan Groups and Skio shipping in an app-owned shop metafield. This
// catalog drives the create modal, the wizard route and the offers-list shortcuts.
export const SUBSCRIPTION_OFFER_TEMPLATES = [
  {
    slug: "cycle-pricing",
    name: "Subscription cycle pricing",
    desc: "e.g. 20% off the first shipment, then $2 off from cycle 2 onward.",
    badge: "Shopify selling plan",
    manageTo: "/app/subscription-pricing",
  },
  {
    slug: "skio-shipping",
    name: "Skio shipping per cycle",
    desc: "e.g. Free delivery on the first box, $1.99 from cycle 2.",
    badge: "Skio subscriptions",
    manageTo: "/app/skio-shipping",
  },
] as const;

export type SubscriptionOfferTemplate = (typeof SUBSCRIPTION_OFFER_TEMPLATES)[number];
export type SubscriptionOfferTemplateSlug = SubscriptionOfferTemplate["slug"];

export function resolveSubscriptionTemplate(slug: string | undefined): SubscriptionOfferTemplate | null {
  return SUBSCRIPTION_OFFER_TEMPLATES.find((template) => template.slug === slug) ?? null;
}

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import { runTool } from "../server.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  skioShippingConnect,
  skioShippingConnectInput,
  skioShippingDisconnect,
  skioShippingDisconnectInput,
  skioShippingStatus,
  skioShippingStatusInput,
  skioShippingSync,
  skioShippingSyncInput,
  skioShippingTierDelete,
  skioShippingTierDeleteInput,
  skioShippingTierSet,
  skioShippingTierSetInput,
  subscriptionOfferCreate,
  subscriptionOfferCreateInput,
  subscriptionPricingDelete,
  subscriptionPricingDeleteInput,
  subscriptionPricingGet,
  subscriptionPricingGetInput,
  subscriptionPricingList,
  subscriptionPricingListInput,
  subscriptionPricingSet,
  subscriptionPricingSetInput,
} from "./subscription.server.js";

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const NOTE = " dryRun:true previews without writing. Writes Shopify selling plans / the app's shop metafield / Skio; Shopify caps selling plan groups at 31 per product and 250 selling plans per group.";

/** Subscription cycle pricing (Shopify selling plans) and Skio shipping tools. Every operator can call every tool. */
export function registerSubscriptionTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "subscription_pricing_list",
    {
      title: "List subscription cycle-pricing plans",
      description: 'Lists the cycle-pricing selling plans created by this app in a shop (first-shipment and recurring discounts, cadence, products). Example: { shop: "onesolsupps" }.',
      inputSchema: subscriptionPricingListInput,
      annotations: READ,
    },
    (args) => runTool(() => subscriptionPricingList(ctx, args)),
  );

  server.registerTool(
    "subscription_pricing_get",
    {
      title: "Get a subscription cycle-pricing plan",
      description: 'One cycle-pricing plan with its full product list. Example: { shop: "onesolsupps", planId: "gid://shopify/SellingPlanGroup/123" }.',
      inputSchema: subscriptionPricingGetInput,
      annotations: READ,
    },
    (args) => runTool(() => subscriptionPricingGet(ctx, args)),
  );

  server.registerTool(
    "subscription_pricing_set",
    {
      title: "Create or update a subscription cycle-pricing plan",
      description: `Creates (no planId) or updates a Shopify selling plan group with one price for the first shipment and another from cycle 2: same rules and messages as the admin Subscription pricing page. Example: { shop: "onesolsupps", plan: { name: "Monthly", intervalUnit: "MONTH", intervalCount: 1, totalCycles: 12, firstCycleDiscount: { type: "percentage", value: 20 }, recurringDiscount: { type: "fixed_amount", value: 2 }, productIds: ["gid://shopify/Product/123"] } }.${NOTE}`,
      inputSchema: subscriptionPricingSetInput,
      annotations: WRITE,
    },
    (args, extra) => subscriptionPricingSet(ctx, call(extra), args),
  );

  server.registerTool(
    "subscription_pricing_delete",
    {
      title: "Delete a subscription cycle-pricing plan",
      description: `Deletes a cycle-pricing plan created by this app (other apps' selling plans are refused).${NOTE}`,
      inputSchema: subscriptionPricingDeleteInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => subscriptionPricingDelete(ctx, call(extra), args),
  );

  server.registerTool(
    "subscription_offer_create",
    {
      title: "Create a subscription offer",
      description: `What the admin "New subscription offer" wizard does. template cycle-pricing creates a selling plan (needs plan); template skio-shipping adds a Skio delivery-price tier (needs tier; an existing id is refused). Example: { shop: "onesolsupps", template: "cycle-pricing", plan: { ... } }.${NOTE}`,
      inputSchema: subscriptionOfferCreateInput,
      annotations: WRITE,
    },
    (args, extra) => subscriptionOfferCreate(ctx, call(extra), args),
  );

  server.registerTool(
    "skio_shipping_status",
    {
      title: "Skio shipping status",
      description: 'Whether Skio is connected (never the key), the stored shipping tiers and whether the stored config is valid. Example: { shop: "onesolsupps" }.',
      inputSchema: skioShippingStatusInput,
      annotations: READ,
    },
    (args) => runTool(() => skioShippingStatus(ctx, args)),
  );

  server.registerTool(
    "skio_shipping_tier_set",
    {
      title: "Create or replace a Skio shipping tier",
      description: `Upserts one Skio shipping tier by id in the app's shop metafield (the Skio shipping page's Save tier).${NOTE}`,
      inputSchema: skioShippingTierSetInput,
      annotations: WRITE,
    },
    (args, extra) => skioShippingTierSet(ctx, call(extra), args),
  );

  server.registerTool(
    "skio_shipping_tier_delete",
    {
      title: "Delete a Skio shipping tier",
      description: `Removes one Skio shipping tier by id.${NOTE}`,
      inputSchema: skioShippingTierDeleteInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => skioShippingTierDelete(ctx, call(extra), args),
  );

  server.registerTool(
    "skio_shipping_sync",
    {
      title: "Run the Skio shipping sync",
      description: `Evaluates every active Skio subscription against the tiers and sets the delivery price override where it differs (verified after each write). Requires Skio to be connected.${NOTE}`,
      inputSchema: skioShippingSyncInput,
      annotations: WRITE,
    },
    (args, extra) => skioShippingSync(ctx, call(extra), args),
  );

  server.registerTool(
    "skio_shipping_connect",
    {
      title: "Connect Skio",
      description: `Validates a Skio private API key against Skio and stores it encrypted; replaces a stored key. Write-only: no tool ever returns the key.${NOTE}`,
      inputSchema: skioShippingConnectInput,
      annotations: WRITE,
    },
    (args, extra) => skioShippingConnect(ctx, call(extra), args),
  );

  server.registerTool(
    "skio_shipping_disconnect",
    {
      title: "Disconnect Skio",
      description: `Deletes the stored Skio API key; syncs stop until Skio is connected again.${NOTE}`,
      inputSchema: skioShippingDisconnectInput,
      annotations: DESTRUCTIVE,
    },
    (args, extra) => skioShippingDisconnect(ctx, call(extra), args),
  );
}

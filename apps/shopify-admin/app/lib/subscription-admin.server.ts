import { eq } from "drizzle-orm";
import { shops, type Db } from "@promo/db";
import { makeSkioGraphQLProxy, validateSkioApiKey } from "./skio-api.server.js";
import { deleteSkioApiKey, getSkioApiKey, saveSkioApiKey } from "./skio-credentials.server.js";
import {
  addSkioShippingTier,
  deleteSkioShippingTier,
  loadSkioShippingConfig,
  saveSkioShippingConfig,
  upsertSkioShippingTier,
  type LoadedSkioShippingConfig,
  type ShopifyAdminCredentials,
} from "./skio-shipping-config.server.js";
import { runSkioShippingSync, type SyncedSubscriptionResult } from "./skio-shipping-runner.server.js";
import { skioShippingTierSchema, type SkioShippingTier } from "./skio-shipping-tiers.js";
import {
  createCyclePricingPlan,
  deleteCyclePricingPlan,
  getCyclePricingPlan,
  listCyclePricingPlans,
  updateCyclePricingPlan,
  type CyclePricingClient,
} from "./subscription-cycle-pricing.server.js";
import { subscriptionCyclePricingPlanInputSchema, type SubscriptionCyclePricingPlan, type SubscriptionCyclePricingPlanInput } from "./subscription-cycle-pricing.js";
import { decryptToken } from "./token-crypto.server.js";

/**
 * Typed services behind the subscription cycle-pricing and Skio shipping admin pages. The route actions
 * (FormData adapters) and the MCP tools both call these, so validation messages and write paths are shared.
 */

export type SubscriptionAdminResult<T> = { ok: true; value: T } | { ok: false; error: string };

const PLAN_GID_PREFIX = "gid://shopify/SellingPlanGroup/";
const joinErrors = (errors: { message: string }[]) => errors.map((issue) => issue.message).join(" ");

/** Admin API credentials of a shop, for callers that have no Shopify session (MCP). */
export async function loadShopAdminClient(db: Db, shopId: string): Promise<ShopifyAdminCredentials | null> {
  const [row] = await db
    .select({ domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!row?.token) return null;
  return { shopDomain: row.domain, accessToken: await decryptToken(row.token) };
}

export function isPlanGid(id: string): boolean {
  return id.startsWith(PLAN_GID_PREFIX);
}

export async function listPlans(client: CyclePricingClient): Promise<SubscriptionCyclePricingPlan[]> {
  return listCyclePricingPlans(client);
}

export async function getPlan(client: CyclePricingClient, planId: string): Promise<SubscriptionCyclePricingPlan | null> {
  if (!isPlanGid(planId)) return null;
  return getCyclePricingPlan(client, planId);
}

/** Creates a plan, or updates `planId` (which must be one of this app's plans). Returns the plan id. */
export async function setCyclePricingPlan(
  client: CyclePricingClient,
  input: { planId?: string; plan: unknown },
): Promise<SubscriptionAdminResult<{ planId: string | null; created: boolean }>> {
  const parsed = subscriptionCyclePricingPlanInputSchema.safeParse(input.plan);
  return applyCyclePricingPlan(client, input.planId, parsed);
}

/** Same as setCyclePricingPlan for an already-parsed zod result (the FormData adapters parse first). */
export async function applyCyclePricingPlan(
  client: CyclePricingClient,
  planId: string | undefined,
  parsed: { success: true; data: SubscriptionCyclePricingPlanInput } | { success: false; error: { issues: { message: string }[] } },
): Promise<SubscriptionAdminResult<{ planId: string | null; created: boolean }>> {
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid plan." };
  if (planId === undefined) {
    const result = await createCyclePricingPlan(client, parsed.data);
    if (result.userErrors.length) return { ok: false, error: joinErrors(result.userErrors) };
    return { ok: true, value: { planId: result.id, created: true } };
  }
  if (!isPlanGid(planId)) return { ok: false, error: "Invalid Selling Plan Group ID." };
  const existing = await getCyclePricingPlan(client, planId);
  if (!existing) return { ok: false, error: "That plan was not created by this app and cannot be edited here." };
  const result = await updateCyclePricingPlan(client, existing, parsed.data);
  if (result.userErrors.length) return { ok: false, error: joinErrors(result.userErrors) };
  return { ok: true, value: { planId, created: false } };
}

/** getCyclePricingPlan only returns plans carrying this app's (or the legacy app's) prefix, so other apps' plans can never be deleted here. */
export async function deleteOwnedCyclePricingPlan(client: CyclePricingClient, planId: string): Promise<SubscriptionAdminResult<null>> {
  if (!isPlanGid(planId)) return { ok: false, error: "Invalid Selling Plan Group ID." };
  const owned = await getCyclePricingPlan(client, planId);
  if (!owned) return { ok: false, error: "That plan was not created by this app and cannot be deleted here." };
  const result = await deleteCyclePricingPlan(client, planId);
  if (result.userErrors.length) return { ok: false, error: joinErrors(result.userErrors) };
  return { ok: true, value: null };
}

export type SkioStatus = LoadedSkioShippingConfig & { apiKeyConnected: boolean };

/** Never includes the key itself, only whether one is stored. */
export async function loadSkioStatus(db: Db, shopId: string, client: ShopifyAdminCredentials): Promise<SkioStatus> {
  const [loaded, apiKey] = await Promise.all([loadSkioShippingConfig(client), getSkioApiKey(db, shopId)]);
  return { ...loaded, apiKeyConnected: Boolean(apiKey) };
}

/** Validates the key against Skio, then stores it encrypted. The key is never returned. */
export async function connectSkio(
  db: Db,
  shopId: string,
  rawKey: string,
  validate: (apiKey: string) => Promise<{ ok: boolean; error?: string }> = validateSkioApiKey,
): Promise<SubscriptionAdminResult<null>> {
  const apiKey = rawKey.trim();
  if (!apiKey) return { ok: false, error: "Enter a Skio API key." };
  if (apiKey.length > 4_096) return { ok: false, error: "Skio API key is too large." };
  const validation = await validate(apiKey);
  if (!validation.ok) return { ok: false, error: validation.error ?? "Skio rejected the API key." };
  await saveSkioApiKey(db, shopId, apiKey);
  return { ok: true, value: null };
}

export async function disconnectSkio(db: Db, shopId: string): Promise<void> {
  await deleteSkioApiKey(db, shopId);
}

/** Saves a shipping tier. `create` refuses to overwrite an existing tier id (the wizard); otherwise it upserts (the manager). */
export async function saveSkioTier(
  client: ShopifyAdminCredentials,
  rawTier: unknown,
  mode: "create" | "upsert",
): Promise<SubscriptionAdminResult<{ tier: SkioShippingTier }>> {
  const parsed = skioShippingTierSchema.safeParse(rawTier);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(" ") };
  const loaded = await loadSkioShippingConfig(client);
  if (!loaded.configValid) {
    return { ok: false, error: mode === "create" ? "Repair the stored Skio configuration before adding tiers." : "Repair the stored Skio configuration before making changes." };
  }
  let next;
  if (mode === "create") {
    const added = addSkioShippingTier(loaded.config, parsed.data);
    if ("error" in added) return { ok: false, error: added.error };
    next = added.config;
  } else {
    next = upsertSkioShippingTier(loaded.config, parsed.data);
  }
  const result = await saveSkioShippingConfig(client, next);
  if (result.userErrors.length) return { ok: false, error: joinErrors(result.userErrors) };
  return { ok: true, value: { tier: parsed.data } };
}

export async function deleteSkioTier(client: ShopifyAdminCredentials, tierId: string): Promise<SubscriptionAdminResult<null>> {
  const loaded = await loadSkioShippingConfig(client);
  if (!loaded.configValid) return { ok: false, error: "Repair the stored Skio configuration before making changes." };
  const result = await saveSkioShippingConfig(client, deleteSkioShippingTier(loaded.config, tierId));
  if (result.userErrors.length) return { ok: false, error: joinErrors(result.userErrors) };
  return { ok: true, value: null };
}

export async function syncSkio(
  db: Db,
  shopId: string,
  client: ShopifyAdminCredentials,
): Promise<SubscriptionAdminResult<{ evaluated: number; updated: number; results: SyncedSubscriptionResult[] }>> {
  const loaded = await loadSkioShippingConfig(client);
  if (!loaded.configValid) return { ok: false, error: "Repair the stored Skio configuration before making changes." };
  const apiKey = await getSkioApiKey(db, shopId);
  if (!apiKey) return { ok: false, error: "Connect Skio before running a sync." };
  const results = await runSkioShippingSync(makeSkioGraphQLProxy(apiKey), loaded.config);
  return { ok: true, value: { evaluated: results.length, updated: results.filter((result) => result.applied).length, results } };
}

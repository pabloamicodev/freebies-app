/**
 * One typed registry of every shop-level setting/flag the admin can change (settings index, inventory, POS, limits,
 * diagnostics flags, migration shadow mode, drift repair). Each entry delegates to the module that already owns the
 * flag; this file adds validation, defaults, descriptions and the republish rule. The MCP settings tools and the
 * settings routes share it.
 */
import { appSettings, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { insertAuditLog } from "./audit-log.server.js";
import { isDriftRepairPausedForShop, setDriftRepairPaused } from "./drift-repair-settings.server.js";
import { isFunctionCompactIdsEnabled, setFunctionCompactIdsEnabled } from "./function-compact-ids-flag.server.js";
import {
  isFunctionShardsEnabled,
  isShardDomainsEnabled,
  isShardInstructionBudgetEnabled,
  setFunctionShardsEnabled,
  setShardDomainsEnabled,
  setShardInstructionBudgetEnabled,
} from "./function-shards-flag.server.js";
import { canToggleLimits, isLimitsEnforced, setLimitsEnforced } from "./limits-enforced.server.js";
import { invalidateOfferDefinitions } from "./offer-definitions.server.js";
import { tryPublishShop, type ShopPublishFn } from "./offer-publish-flow.server.js";
import { listLimitedTitleCollisions } from "./offer-usage.server.js";
import { isRemoveUnfundedGiftsEnabled, setRemoveUnfundedGiftsEnabled } from "./remove-unfunded-gifts-flag.server.js";
import { isShadowModeEnabled, setShadowMode } from "./shadow-mode.server.js";
import { parseStoredJson } from "./offer-validation.server.js";

export class SettingError extends Error {
  constructor(
    readonly kind: "validation" | "publish_failed",
    message: string,
  ) {
    super(message);
    this.name = "SettingError";
  }
}

export type SettingContext = {
  db: Db;
  shopId: string;
  shopDomain: string;
  publish?: ShopPublishFn;
  performedBy?: string;
  auditExtra?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
};

export type SettingDef = {
  key: string;
  group: "settings_index" | "inventory" | "pos" | "limits" | "function" | "storefront" | "drift_repair" | "migration" | "installation";
  description: string;
  schema: z.ZodTypeAny;
  default: unknown;
  /** The flag changes the compiled Function config, so the shop is republished after a change. */
  republishAfter: boolean;
  readOnly?: boolean;
  /** write() republishes (and reverts) by itself; the batch publish skips it. */
  selfRepublishes?: boolean;
  read: (db: Db, shopId: string) => Promise<unknown>;
  write?: (ctx: SettingContext, value: unknown) => Promise<void>;
};

const PUBLISH_FAILED_REVERT = (message: string) => `Republishing to Shopify failed, so the setting was reverted: ${message}`;

export async function upsertSettingRaw(db: Db, shopId: string, key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ shopId, key, value })
    .onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value, updatedAt: new Date() } });
}

/** Stores JSON-encoded values, the format the settings pages read back with parseStoredJson. */
export async function upsertSettingsJson(db: Db, shopId: string, updates: Record<string, unknown>): Promise<void> {
  await Promise.all(Object.entries(updates).map(([key, value]) => upsertSettingRaw(db, shopId, key, JSON.stringify(value))));
}

async function readJsonSetting(db: Db, shopId: string, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, key)))
    .limit(1);
  return row ? parseStoredJson(row.value) : undefined;
}

const jsonSetting = (
  key: string,
  group: SettingDef["group"],
  description: string,
  schema: z.ZodTypeAny,
  fallback: unknown,
  opts: { coerce?: (stored: unknown) => unknown } = {},
): SettingDef => ({
  key,
  group,
  description,
  schema,
  default: fallback,
  republishAfter: false,
  read: async (db, shopId) => {
    const stored = await readJsonSetting(db, shopId, key);
    if (stored === undefined) return fallback;
    return opts.coerce ? opts.coerce(stored) : stored;
  },
  write: (ctx, value) => upsertSettingRaw(ctx.db, ctx.shopId, key, JSON.stringify(value)),
});

const bool = z.boolean();
const text = (max = 100) => z.string().trim().max(max);

/** Outcome of the limits toggle shared by Settings -> Limits and the registry. */
export type LimitsEnforcedResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: "not_allowed" | "collision" | "publish_failed"; error: string };

/**
 * Settings -> Limits behaviour: the LIMITS_TOGGLE_SHOPS allow-list, no shared-title collisions when turning on,
 * republish, and put the flag back when the publish fails.
 */
export async function changeLimitsEnforced(ctx: SettingContext, enabled: boolean): Promise<LimitsEnforcedResult> {
  if (!canToggleLimits(ctx.shopDomain, ctx.env)) return { ok: false, code: "not_allowed", error: "This setting is not available for this shop." };
  const previous = await isLimitsEnforced(ctx.db, ctx.shopId);
  if (enabled === previous) return { ok: true, changed: false };
  if (enabled) {
    const collisions = await listLimitedTitleCollisions(ctx.db, ctx.shopId);
    if (collisions.length > 0) {
      const list = collisions.map((c) => `"${c.title}": ${c.offers.join(", ")}`).join("; ");
      return { ok: false, code: "collision", error: `Limits cannot be enforced yet: limited automatic offers share a discount title (${list}). Give each a unique public title first.` };
    }
  }
  await setLimitsEnforced(ctx.db, ctx.shopId, enabled, ctx.performedBy, ctx.auditExtra);
  await invalidateOfferDefinitions(ctx.shopId);
  const failure = await (ctx.publish ?? tryPublishShop)(ctx.shopId, ctx.shopDomain);
  if (failure) {
    // The Function config is still the old one: put the flag back so the evaluator keeps matching it.
    await setLimitsEnforced(ctx.db, ctx.shopId, previous, ctx.performedBy, ctx.auditExtra);
    await invalidateOfferDefinitions(ctx.shopId);
    return { ok: false, code: "publish_failed", error: PUBLISH_FAILED_REVERT(failure.message) };
  }
  return { ok: true, changed: true };
}

/** Migration console: flip shadow mode and republish (the Function config is dropped while shadow is on). */
export async function changeShadowMode(ctx: SettingContext, enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  await setShadowMode(ctx.shopId, enabled);
  const failure = await (ctx.publish ?? tryPublishShop)(ctx.shopId, ctx.shopDomain);
  if (failure) return { ok: false, error: `Shadow mode saved, but republishing to Shopify failed: ${failure.message}` };
  return { ok: true };
}

const flag = (
  def: Pick<SettingDef, "key" | "group" | "description" | "default" | "republishAfter"> & {
    read: SettingDef["read"];
    set: (db: Db, shopId: string, value: boolean) => Promise<void>;
  },
): SettingDef => ({
  key: def.key,
  group: def.group,
  description: def.description,
  schema: bool,
  default: def.default,
  republishAfter: def.republishAfter,
  read: def.read,
  write: (ctx, value) => def.set(ctx.db, ctx.shopId, value as boolean),
});

const INDEX_DEFS: SettingDef[] = [
  jsonSetting("app.enabled", "settings_index", "Master switch: the app applies offers on the storefront.", bool, true),
  jsonSetting("gift.logic_mode", "settings_index", "How gifts are discounted. Only `function` exists.", z.literal("function"), "function"),
  jsonSetting("gift.auto_add", "settings_index", "Automatically add gifts to the cart when the offer qualifies.", bool, true),
  jsonSetting("gift.discount_by", "settings_index", "Which price a gift is discounted from: current_price or compare_price.", z.enum(["current_price", "compare_price"]), "current_price"),
  jsonSetting("gift.price_constraint", "settings_index", "Constrain the gift price.", bool, false),
  jsonSetting("gift.selection_limit", "settings_index", "Limit how many gifts a customer can pick.", bool, false),
  jsonSetting("gift.exclude_cart", "settings_index", "Exclude gift lines from cart-level conditions.", bool, false),
  jsonSetting("gift.remove_on_deactivate", "settings_index", "Remove gifts from carts when the offer stops applying.", bool, true),
  jsonSetting("gift.include_compare_price", "settings_index", "Include the compare-at price on gift lines.", bool, false),
  jsonSetting("gift.sku_format", "settings_index", "Gift SKU format: same_as_original, suffix_gift or blank.", z.enum(["same_as_original", "suffix_gift", "blank"]), "same_as_original"),
  jsonSetting("gift.barcode_format", "settings_index", "Gift barcode format: blank or same_as_original.", z.enum(["blank", "same_as_original"]), "blank"),
  jsonSetting("gift.title_format", "settings_index", "Gift title format: emoji_name_pct, name_pct or same_as_original.", z.enum(["emoji_name_pct", "name_pct", "same_as_original"]), "emoji_name_pct"),
  jsonSetting("gift.include_product_type", "settings_index", "Copy the product type onto gifts.", bool, false),
  jsonSetting("gift.include_tags", "settings_index", "Copy the product tags onto gifts.", bool, false),
  jsonSetting("inventory.method", "settings_index", "Cloned gift inventory: sync_auto, manual or unlimited.", z.enum(["sync_auto", "manual", "unlimited"]), "sync_auto"),
  jsonSetting("inventory.when_out", "settings_index", "When a gift is out of stock: stop the offers or keep selling.", z.enum(["stop", "continue"]), "stop"),
  jsonSetting("advanced.draft_order_api", "settings_index", "Use the draft order API.", bool, false),
  jsonSetting("app.timezone", "settings_index", "Shop timezone override (IANA name); empty uses the shop's own.", text(64), ""),
  jsonSetting("app.language", "settings_index", "Admin language: en, es or fr.", z.enum(["en", "es", "fr"]), "en"),
  {
    key: "fraud.cart_payment_rule",
    group: "settings_index",
    description: "Checkout validation (cart/payment rule). A security invariant: always on, not changeable.",
    schema: z.literal(true),
    default: true,
    republishAfter: false,
    readOnly: true,
    read: async () => true,
  },
];

const INVENTORY_DEFS: SettingDef[] = [
  jsonSetting("gift.oos_behavior", "inventory", "Out-of-stock gifts: hide, show_disabled or show_available (uses continue-selling policy).", z.enum(["hide", "show_disabled", "show_available"]), "hide"),
  jsonSetting("gift.auto_swap_enabled", "inventory", "Swap an out-of-stock gift for an in-stock alternative automatically.", bool, false, { coerce: Boolean }),
  jsonSetting("gift.hide_oos_gifts", "inventory", "Hide out-of-stock gifts from the picker.", bool, true, { coerce: Boolean }),
  jsonSetting("gift.continue_selling_enabled", "inventory", "Allow gifts to be added when stock is exhausted (continue selling).", bool, false, { coerce: Boolean }),
];

const FLAG_DEFS: SettingDef[] = [
  {
    key: "pos.enabled",
    group: "pos",
    description: "Apply promotions at Shopify POS checkout.",
    schema: bool,
    default: false,
    republishAfter: false,
    read: async (db, shopId) => {
      const [row] = await db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "pos.enabled")))
        .limit(1);
      return row?.value === "true";
    },
    write: (ctx, value) => upsertSettingRaw(ctx.db, ctx.shopId, "pos.enabled", String(value)),
  },
  {
    key: "limits.enforced",
    group: "limits",
    description:
      "Per-cart / per-customer offer limits are applied by the Functions. Only shops in LIMITS_TOGGLE_SHOPS can change it; turning it on is refused while limited automatic offers share a discount title. Republishes the shop; reverted if that fails.",
    schema: bool,
    default: false,
    republishAfter: true,
    selfRepublishes: true,
    read: isLimitsEnforced,
    write: async (ctx, value) => {
      const result = await changeLimitsEnforced(ctx, value as boolean);
      if (!result.ok) {
        const hint = result.code === "not_allowed" ? ` ${ctx.shopDomain} is not in LIMITS_TOGGLE_SHOPS (set it in the Vercel project and redeploy; the MCP never changes env).` : "";
        throw new SettingError(result.code === "publish_failed" ? "publish_failed" : "validation", result.error + hint);
      }
    },
  },
  flag({
    key: "function_shards.enabled",
    group: "function",
    description: "Split a heavy shop's offers over several discount nodes (sharding). Default on; false keeps the shop on one node (kill switch). The FUNCTION_SHARDS_DEFAULT=off env changes the default.",
    default: true,
    republishAfter: true,
    read: isFunctionShardsEnabled,
    set: setFunctionShardsEnabled,
  }),
  {
    key: "function_shards.combination_domains",
    group: "function",
    description:
      "Split nodes by combination group instead of one policy for all nodes. Default on; ignored (and refused) while the global FUNCTION_SHARD_DOMAINS=off switch is active. Republishes only when sharding is on; reverted if that fails.",
    schema: bool,
    default: true,
    republishAfter: true,
    selfRepublishes: true,
    read: isShardDomainsEnabled,
    write: async (ctx, value) => {
      const env = ctx.env ?? process.env;
      if (env["FUNCTION_SHARD_DOMAINS"] === "off") {
        throw new SettingError("validation", "Combination groups are switched off for every store, so this setting cannot be changed right now.");
      }
      const enabled = value as boolean;
      const previous = await isShardDomainsEnabled(ctx.db, ctx.shopId);
      if (enabled === previous) return;
      await setShardDomainsEnabled(ctx.db, ctx.shopId, enabled);
      if (!(await isFunctionShardsEnabled(ctx.db, ctx.shopId))) return;
      await invalidateOfferDefinitions(ctx.shopId);
      const failure = await (ctx.publish ?? tryPublishShop)(ctx.shopId, ctx.shopDomain);
      if (failure) {
        await setShardDomainsEnabled(ctx.db, ctx.shopId, previous);
        throw new SettingError("publish_failed", PUBLISH_FAILED_REVERT(failure.message));
      }
    },
  },
  flag({
    key: "function_shards.instruction_budget",
    group: "function",
    description: "Also keep each node under an estimated instruction budget, spreading a heavy shop over more nodes. Default on; only applies where sharding is on.",
    default: true,
    republishAfter: true,
    read: isShardInstructionBudgetEnabled,
    set: setShardInstructionBudgetEnabled,
  }),
  flag({
    key: "function_compact_ids.enabled",
    group: "function",
    description: "Functions read numeric ids instead of GIDs (smaller config). Default off until the Functions that read numeric ids are deployed; FUNCTION_COMPACT_IDS=off forces it off everywhere.",
    default: false,
    republishAfter: true,
    read: isFunctionCompactIdsEnabled,
    set: setFunctionCompactIdsEnabled,
  }),
  flag({
    key: "storefront.remove_unfunded_gifts",
    group: "storefront",
    description: "The storefront runtime removes a gift Shopify left at full price. Default off. Read by the storefront at runtime, so no republish.",
    default: false,
    republishAfter: false,
    read: isRemoveUnfundedGiftsEnabled,
    set: setRemoveUnfundedGiftsEnabled,
  }),
  {
    key: "drift_repair.paused",
    group: "drift_repair",
    description: "Pause automatic drift repair for this shop (detection and the Sentry signal stay on). Use during an emergency node deactivation. DRIFT_REPAIR_DISABLED=true pauses every shop.",
    schema: bool,
    default: false,
    republishAfter: false,
    read: (db, shopId) => isDriftRepairPausedForShop(shopId, db),
    write: (ctx, value) => setDriftRepairPaused(ctx.shopId, value as boolean),
  },
  {
    key: "shadow_mode.enabled",
    group: "migration",
    description: "Shadow mode: offers are evaluated and logged but nothing is applied and no Function config is active (migration parity). Republishes the shop.",
    schema: bool,
    default: false,
    republishAfter: true,
    selfRepublishes: true,
    read: (_db, shopId) => isShadowModeEnabled(shopId),
    write: async (ctx, value) => {
      const result = await changeShadowMode(ctx, value as boolean);
      if (!result.ok) throw new SettingError("publish_failed", result.error);
    },
  },
  {
    key: "app.embed_verified",
    group: "installation",
    description: "Whether the theme app embed was verified as enabled (read-only; set by the installation page and storefront checks). Empty means never verified.",
    schema: z.unknown(),
    default: null,
    republishAfter: false,
    readOnly: true,
    read: async (db, shopId) => (await readJsonSetting(db, shopId, "app.embed_verified")) ?? null,
  },
];

export const SETTING_REGISTRY: readonly SettingDef[] = [...INDEX_DEFS, ...INVENTORY_DEFS, ...FLAG_DEFS];
export const SETTING_KEYS: readonly string[] = SETTING_REGISTRY.map((d) => d.key);

const byKey = new Map(SETTING_REGISTRY.map((d) => [d.key, d]));

export function getSettingDef(key: string): SettingDef {
  const def = byKey.get(key);
  if (!def) throw new SettingError("validation", `Unknown setting "${key}". Valid keys: ${SETTING_KEYS.join(", ")}.`);
  return def;
}

export type SettingRead = { key: string; group: string; value: unknown; default: unknown; description: string; readOnly: boolean; republishAfter: boolean; lastChangedAt: Date | null };

export async function readSettings(db: Db, shopId: string, keys?: string[]): Promise<SettingRead[]> {
  const defs = keys?.length ? keys.map(getSettingDef) : [...SETTING_REGISTRY];
  const rows = await db.select({ key: appSettings.key, updatedAt: appSettings.updatedAt }).from(appSettings).where(eq(appSettings.shopId, shopId));
  const changed = new Map(rows.map((r) => [r.key, r.updatedAt]));
  return Promise.all(
    defs.map(async (def) => ({
      key: def.key,
      group: def.group,
      value: await def.read(db, shopId),
      default: def.default,
      description: def.description,
      readOnly: Boolean(def.readOnly),
      republishAfter: def.republishAfter,
      lastChangedAt: changed.get(def.key) ?? null,
    })),
  );
}

export type SettingChange = { key: string; before: unknown; after: unknown; changed: boolean; republish: boolean };

function parseValue(def: SettingDef, value: unknown): unknown {
  if (def.readOnly) throw new SettingError("validation", `${def.key} is read-only.`);
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    throw new SettingError("validation", `Invalid value for ${def.key}: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 200)}. ${def.description}`);
  }
  return parsed.data;
}

/** Validates every value against the registry and reports before/after plus whether a republish follows; writes nothing. */
export async function planSettings(db: Db, shopId: string, values: Record<string, unknown>): Promise<SettingChange[]> {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new SettingError("validation", "values is empty: pass at least one setting.");
  const parsed = entries.map(([key, value]) => {
    const def = getSettingDef(key);
    return { def, value: parseValue(def, value) };
  });
  return Promise.all(
    parsed.map(async ({ def, value }) => {
      const before = await def.read(db, shopId);
      const changed = JSON.stringify(before) !== JSON.stringify(value);
      return { key: def.key, before, after: value, changed, republish: def.republishAfter && changed };
    }),
  );
}

/**
 * Applies a partial record. Settings that republish by themselves (limits, combination groups, shadow mode) run after
 * the plain ones; flags that change the compiled config share one republish that reverts them all if it fails.
 */
export async function applySettings(ctx: SettingContext, values: Record<string, unknown>): Promise<{ changes: SettingChange[]; republished: boolean }> {
  const changes = await planSettings(ctx.db, ctx.shopId, values);
  const plain = changes.filter((c) => c.changed && !getSettingDef(c.key).selfRepublishes);
  const self = changes.filter((c) => c.changed && getSettingDef(c.key).selfRepublishes);
  const written: SettingChange[] = [];
  let republished = false;
  const revert = async () => {
    for (const c of [...written].reverse()) await getSettingDef(c.key).write!(ctx, c.before);
  };
  for (const c of plain) {
    await getSettingDef(c.key).write!(ctx, c.after);
    written.push(c);
  }
  if (plain.some((c) => c.republish)) {
    await invalidateOfferDefinitions(ctx.shopId);
    const failure = await (ctx.publish ?? tryPublishShop)(ctx.shopId, ctx.shopDomain);
    if (failure) {
      await revert();
      await invalidateOfferDefinitions(ctx.shopId);
      throw new SettingError("publish_failed", PUBLISH_FAILED_REVERT(failure.message));
    }
    republished = true;
  }
  for (const c of self) {
    await getSettingDef(c.key).write!(ctx, c.after);
    republished = true;
  }
  await audit(ctx, changes);
  return { changes, republished };
}

async function audit(ctx: SettingContext, changes: SettingChange[]): Promise<void> {
  const changed = changes.filter((c) => c.changed);
  if (changed.length === 0) return;
  await insertAuditLog(ctx.db, {
    shopId: ctx.shopId,
    entityType: "app_setting",
    entityId: changed.map((c) => c.key).join(","),
    action: "settings_changed",
    before: Object.fromEntries(changed.map((c) => [c.key, c.before])),
    after: { ...Object.fromEntries(changed.map((c) => [c.key, c.after])), ...ctx.auditExtra },
    performedBy: ctx.performedBy,
  });
}

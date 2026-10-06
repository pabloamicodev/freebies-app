/**
 * What the last successful publish put on Shopify, kept so drift (a merchant deleting or editing
 * one of our discount nodes or metafields in the Shopify admin) can be detected without recompiling
 * every offer. Stored per shop in `app_settings`; one entry per discount node / validation.
 */
import { createHash } from "node:crypto";
import { appSettings, getDb } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const PUBLISH_MANIFEST_SETTING = "publish_manifest.v1";

export type ManifestNodeKind = "cart" | "delivery" | "pool" | "code" | "code-delivery" | "code-b";

export interface ManifestNode {
  kind: ManifestNodeKind;
  /** sha256 of the canonical JSON of the pushed `function_config` value. */
  hash: string;
  /** False for nodes we deliberately expired / emptied (stale code offers). */
  active: boolean;
  /** What the node was last published with; absent means both (shared nodes always are). */
  appliesOnSubscription?: boolean;
  appliesOnOneTimePurchase?: boolean;
}

export interface PublishManifest {
  version: 1;
  updatedAt: string;
  nodes: Record<string, ManifestNode>;
  /** sha256 of the canonical cart-validation config, when a publish synced one. */
  validationHash?: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** Whitespace/key-order independent fingerprint of a JSON metafield value. */
export function configHash(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = json;
  }
  return createHash("sha256").update(JSON.stringify(canonical(parsed))).digest("hex");
}

/** Mutable collector a publish run fills as it pushes metafields. */
export class ManifestCollector {
  readonly nodes: Record<string, ManifestNode> = {};
  validationHash: string | undefined;

  record(
    id: string,
    kind: ManifestNodeKind,
    json: string,
    extra: { active?: boolean; purchaseTypes?: { appliesOnSubscription: boolean; appliesOnOneTimePurchase: boolean } } = {},
  ): void {
    this.nodes[id] = {
      kind,
      hash: configHash(json),
      active: extra.active ?? true,
      ...(extra.purchaseTypes ? extra.purchaseTypes : {}),
    };
  }

  build(): PublishManifest {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      nodes: this.nodes,
      ...(this.validationHash ? { validationHash: this.validationHash } : {}),
    };
  }
}

export async function writePublishManifest(shopId: string, manifest: PublishManifest): Promise<void> {
  const value = JSON.stringify(manifest);
  await getDb()
    .insert(appSettings)
    .values({ shopId, key: PUBLISH_MANIFEST_SETTING, value })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value, updatedAt: new Date() },
    });
}

export async function readPublishManifest(shopId: string): Promise<PublishManifest | null> {
  const [row] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, PUBLISH_MANIFEST_SETTING)))
    .limit(1);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as PublishManifest;
    return parsed?.version === 1 && parsed.nodes ? parsed : null;
  } catch {
    return null;
  }
}

import type { Db } from "@promo/db";
import { z } from "zod";
import { isShardDomainsEnabled, setShardDomainsEnabled } from "./function-shards-flag.server.js";

const formSchema = z.object({
  intent: z.literal("set_combination_domains"),
  enabled: z.enum(["true", "false"]),
});

export type CombinationDomainsResult = { success: true } | { error: string };

/**
 * Diagnostics toggle for combination groups. Refuses while the global FUNCTION_SHARD_DOMAINS=off switch is active
 * (the setting would have no effect), and puts the setting back if the republish fails.
 */
export async function changeCombinationDomains(
  db: Db,
  shopId: string,
  form: FormData,
  publish: () => Promise<string | null | undefined>,
): Promise<CombinationDomainsResult> {
  if (process.env["FUNCTION_SHARD_DOMAINS"] === "off") {
    return { error: "Combination groups are switched off for every store, so this setting cannot be changed right now." };
  }
  const parsed = formSchema.safeParse({ intent: form.get("intent"), enabled: form.get("enabled") });
  if (!parsed.success) return { error: "Unknown action." };
  const enabled = parsed.data.enabled === "true";
  const previous = await isShardDomainsEnabled(db, shopId);
  if (enabled === previous) return { success: true };
  await setShardDomainsEnabled(db, shopId, enabled);
  const publishError = await publish();
  if (publishError) {
    await setShardDomainsEnabled(db, shopId, previous);
    return { error: `Republishing to Shopify failed, so the setting was reverted: ${publishError}` };
  }
  return { success: true };
}

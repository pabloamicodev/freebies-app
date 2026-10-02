/**
 * CI guard: the theme extension serves the COMMITTED apps/shopify-admin/extensions/theme-extension/assets/promo-engine.js,
 * so a runtime source change without a rebuilt asset ships stale code. Rebuilds the runtime and diffs it.
 * Fix with: pnpm build:storefront
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
execSync("pnpm --filter @promo/storefront-runtime build", { stdio: "inherit", cwd: root });
const normalize = (buffer) => buffer.toString("utf8").replace(/\r\n/g, "\n");
const built = normalize(readFileSync(join(root, "packages/storefront-runtime/dist/promo-engine.js")));
const committed = normalize(readFileSync(join(root, "apps/shopify-admin/extensions/theme-extension/assets/promo-engine.js")));
if (built !== committed) {
  console.error(`[storefront-freshness] committed promo-engine.js is stale (built ${built.length} B, committed ${committed.length} B). Run: pnpm build:storefront and commit the asset.`);
  process.exit(1);
}
console.info("[storefront-freshness] ok");

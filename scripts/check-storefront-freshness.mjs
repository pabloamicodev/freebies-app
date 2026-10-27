/**
 * CI guard: the theme extension serves the COMMITTED assets (promo-engine.js and its gift-prompt and blocks chunks) under
 * apps/shopify-admin/extensions/theme-extension/assets, so a runtime source change without rebuilt assets ships stale code.
 * Rebuilds the runtime and diffs them. Fix with: pnpm build:storefront
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
execSync("pnpm --filter @promo/storefront-runtime build", { stdio: "inherit", cwd: root });
const normalize = (buffer) => buffer.toString("utf8").replace(/\r\n/g, "\n");
let stale = false;
for (const name of ["promo-engine.js", "promo-engine-gift-prompt.js", "promo-engine-blocks.js"]) {
  const built = normalize(readFileSync(join(root, "packages/storefront-runtime/dist", name)));
  const committed = normalize(readFileSync(join(root, "apps/shopify-admin/extensions/theme-extension/assets", name)));
  if (built !== committed) {
    console.error(`[storefront-freshness] committed ${name} is stale (built ${built.length} B, committed ${committed.length} B). Run: pnpm build:storefront and commit the asset.`);
    stale = true;
  }
}
if (stale) process.exit(1);
console.info("[storefront-freshness] ok");

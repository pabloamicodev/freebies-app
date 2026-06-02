/**
 * Build storefront runtime and copy output to theme extension assets.
 * Run: node scripts/build-storefront.mjs
 * Or via: pnpm build:storefront
 */

import { execSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const DIST = join(ROOT, "packages/storefront-runtime/dist");
const THEME_ASSETS = join(ROOT, "extensions/theme-extension/assets");

console.log("→ Building storefront runtime...");

try {
  execSync("pnpm --filter @promo/storefront-runtime build", {
    stdio: "inherit",
    cwd: ROOT,
  });
  console.log("✅ Build complete");
} catch (e) {
  console.error("❌ Build failed:", e.message);
  process.exit(1);
}

// Copy compiled JS to theme extension assets
const src = join(DIST, "promo-engine.js");
const dst = join(THEME_ASSETS, "promo-engine.js");

if (!existsSync(src)) {
  console.error(`❌ Build output not found: ${src}`);
  process.exit(1);
}

mkdirSync(THEME_ASSETS, { recursive: true });
copyFileSync(src, dst);
console.log(`✅ Copied → extensions/theme-extension/assets/promo-engine.js`);

// Also check size
const { statSync } = await import("fs");
const { gzipSync } = await import("zlib");
const { readFileSync } = await import("fs");
const content = readFileSync(dst);
const gzipped = gzipSync(content);
const kb = (gzipped.length / 1024).toFixed(1);
console.log(`📦 Bundle size: ${kb} KB gzipped (budget: 30 KB)`);
if (parseFloat(kb) > 30) {
  console.warn(`⚠️  Bundle exceeds 30 KB budget — optimize imports`);
}

console.log("\n✅ Storefront build complete. Deploy with: shopify app push");

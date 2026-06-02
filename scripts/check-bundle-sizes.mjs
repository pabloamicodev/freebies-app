/**
 * CI script: verify storefront widget bundle sizes stay within budget.
 * Run after `pnpm --filter @promo/storefront-runtime build`
 * Fails with exit code 1 if any budget is exceeded.
 */

import { statSync, existsSync } from "fs";
import { join } from "path";
import { gzipSync } from "zlib";
import { readFileSync } from "fs";

const DIST = join(process.cwd(), "packages/storefront-runtime/dist");

/** Budget table (gzipped KB) */
const BUDGETS = {
  "promo-engine.js": 30,          // core runtime
  "gift-slider.js": 15,           // gift slider Preact
  "bundle-builder.js": 50,        // bundle builder (lazy)
  "today-offer.js": 8,            // today offer Preact
  "progress-bar.js": 5,           // Web Component
  "cart-message.js": 5,           // Web Component
  "fbt.js": 12,                   // FBT widget
  "gift-icon.js": 4,              // Web Component
  "volume-discount.js": 5,        // Web Component
};

let failed = false;

console.log("📦 Storefront bundle size check\n");
console.log("File".padEnd(30), "Gzipped".padStart(10), "Budget".padStart(10), "Status".padStart(8));
console.log("─".repeat(62));

for (const [filename, budgetKb] of Object.entries(BUDGETS)) {
  const filePath = join(DIST, filename);
  if (!existsSync(filePath)) {
    console.log(filename.padEnd(30), "N/A".padStart(10), `${budgetKb}KB`.padStart(10), "⏭ SKIP".padStart(8));
    continue;
  }

  const content = readFileSync(filePath);
  const gzipped = gzipSync(content);
  const gzippedKb = (gzipped.length / 1024).toFixed(1);
  const ok = parseFloat(gzippedKb) <= budgetKb;

  if (!ok) failed = true;

  console.log(
    filename.padEnd(30),
    `${gzippedKb}KB`.padStart(10),
    `${budgetKb}KB`.padStart(10),
    (ok ? "✅ OK" : "❌ OVER").padStart(8),
  );
}

console.log("");
if (failed) {
  console.error("❌ Bundle size budget exceeded. Optimize before merging.");
  process.exit(1);
} else {
  console.log("✅ All bundle sizes within budget.");
}

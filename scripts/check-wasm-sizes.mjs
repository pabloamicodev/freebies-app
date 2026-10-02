/**
 * CI guard: every built Function wasm must stay <= 249000 B. Shopify's upload limit is 256 KB and the CLI adds a
 * ~13 KB trampoline, which is why the extensions' build commands use the same number (docs/DEPLOY.md).
 * Usage: node scripts/check-wasm-sizes.mjs   (after `pnpm shopify:build`)
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 249_000;
const root = join(process.cwd(), "apps/shopify-admin/extensions");
let found = 0;
let failed = false;
for (const extension of readdirSync(root, { withFileTypes: true })) {
  if (!extension.isDirectory()) continue;
  const releaseDir = join(root, extension.name, "target/wasm32-wasip1/release");
  if (!existsSync(releaseDir)) continue;
  for (const file of readdirSync(releaseDir).filter((name) => name.endsWith(".wasm"))) {
    const size = statSync(join(releaseDir, file)).size;
    found += 1;
    const ok = size <= LIMIT;
    if (!ok) failed = true;
    console.info(`[wasm-size] ${ok ? "ok  " : "OVER"} ${String(size).padStart(7)} / ${LIMIT} ${extension.name}/${file}`);
  }
}
if (found === 0) {
  console.error("[wasm-size] no built Function binaries found");
  process.exit(1);
}
if (failed) {
  console.error("[wasm-size] a Function exceeds the size budget. Do not remove a feature: split it into a separate extension.");
  process.exit(1);
}

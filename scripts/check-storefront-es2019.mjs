/**
 * The storefront bundle must run on Safari 13 / ES2019. Two checks on the committed asset:
 * 1. syntax: esbuild re-targeting to es2019 must be a no-op (any newer syntax would be lowered, changing the output);
 * 2. APIs: no post-ES2019 built-ins that esbuild does not polyfill.
 * Run: node scripts/check-storefront-es2019.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// esbuild is a dependency of the runtime package, not the root.
const { transform } = createRequire(join(process.cwd(), "packages/storefront-runtime/package.json"))("esbuild");

const file = join(process.cwd(), "apps/shopify-admin/extensions/theme-extension/assets/promo-engine.js");
const code = readFileSync(file, "utf8");
const problems = [];

const opts = { minify: false, loader: "js", legalComments: "none" };
try {
  const [asIs, lowered] = await Promise.all([
    transform(code, { ...opts, target: "esnext" }),
    transform(code, { ...opts, target: ["es2019", "safari13"] }),
  ]);
  if (asIs.code !== lowered.code) problems.push("syntax newer than es2019 (esbuild had to lower it)");
} catch (e) {
  problems.push(`syntax newer than es2019: ${e.errors?.[0]?.text ?? e.message}`);
}

const NEWER_APIS = [
  [/\.replaceAll\(/, "String.prototype.replaceAll (ES2021)"],
  [/\.matchAll\(/, "String.prototype.matchAll (ES2020)"],
  [/Object\.hasOwn\(/, "Object.hasOwn (ES2022)"],
  [/structuredClone\(/, "structuredClone"],
  [/Promise\.(allSettled|any)\(/, "Promise.allSettled/any"],
  [/\bglobalThis\b/, "globalThis (ES2020)"],
  [/\bBigInt\b/, "BigInt (ES2020)"],
  [/\.at\(-?\d/, "Array/String.prototype.at (ES2022)"],
  [/\.findLast(Index)?\(/, "findLast (ES2023)"],
  [/AbortSignal\.(timeout|any)\(/, "AbortSignal.timeout/any"],
];
for (const [re, label] of NEWER_APIS) if (re.test(code)) problems.push(`uses ${label}`);

if (problems.length) {
  console.error(`[storefront-es2019] FAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.info("[storefront-es2019] ok");

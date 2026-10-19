import * as esbuild from "esbuild";

const options = { bundle: true, platform: "browser", format: "iife", target: ["es2019", "safari13"] };

if (process.argv.includes("--dev")) {
  await esbuild.build({ ...options, entryPoints: ["src/theme.ts"], outfile: "dist/promo-engine.dev.js", sourcemap: true });
} else {
  // The always-loaded runtime, and the cart prompt it requests only once an evaluation returns a gift picker.
  await esbuild.build({ ...options, minify: true, entryPoints: { "promo-engine": "src/theme.ts", "promo-engine-gift-prompt": "src/gift-prompt-entry.ts" }, outdir: "dist" });
}

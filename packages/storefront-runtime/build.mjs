import * as esbuild from "esbuild";

// The blocks chunk reuses the main bundle's cart adapter, formatter, i18n and event bus (published on window.__pePreact).
const shareHostModules = (shim) => ({
  name: "share-host-modules",
  setup: (build) => build.onResolve({ filter: /^\.\.\/(cart-adapter|format|i18n|event-bus)\.js$/ }, () => ({ path: shim })),
});

const options = { bundle: true, platform: "browser", format: "iife", target: ["es2019", "safari13"] };

if (process.argv.includes("--dev")) {
  await esbuild.build({ ...options, entryPoints: ["src/theme.ts"], outfile: "dist/promo-engine.dev.js", sourcemap: true });
} else {
  // The always-loaded runtime, and the cart prompt it requests only once an evaluation returns a gift picker.
  await esbuild.build({ ...options, minify: true, entryPoints: { "promo-engine": "src/theme.ts", "promo-engine-gift-prompt": "src/gift-prompt-entry.ts" }, outdir: "dist" });
  // The FBT and bundle-builder blocks, requested by promo-engine.js when a block mounts. preact comes from the main bundle.
  const shim = new URL("./src/preact-shim.ts", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
  await esbuild.build({ ...options, minify: true, entryPoints: { "promo-engine-blocks": "src/blocks-entry.ts" }, outdir: "dist", alias: { preact: shim, "preact/hooks": shim, "preact/jsx-runtime": shim }, plugins: [shareHostModules(shim)] });
}

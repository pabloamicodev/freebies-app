// Lazy asset for the FBT and bundle-builder theme blocks. promo-engine.js requests it only when a block mounts.
// Built with preact aliased to preact-shim.ts, so it renders with the main bundle's preact instance.
import { initFbtWidget } from "./widgets/fbt.js";
import { initBundleBuilder } from "./widgets/bundle-builder.js";

window.__peBlocks = { initFbtWidget, initBundleBuilder };

/** Usage: node scripts/deploy-app.mjs <shopify.app*.toml>. Deploys one app with its own extension host, then restores the HPN default even on failure. */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const config = process.argv[2];
if (!config) throw new Error("usage: deploy-app.mjs <toml>");
const writer = join(dirname(fileURLToPath(import.meta.url)), "write-extension-app-url.mjs");
const write = (toml) => spawnSync(process.execPath, [writer, toml], { stdio: "inherit" });

let status = 1;
try {
  write(config);
  status =
    spawnSync("pnpm", ["--filter", "shopify-admin", "exec", "shopify", "app", "deploy", "--config", config], {
      stdio: "inherit",
      shell: true,
    }).status ?? 1;
} finally {
  write("shopify.app.toml");
}
process.exit(status);

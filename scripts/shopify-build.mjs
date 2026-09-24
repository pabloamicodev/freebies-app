import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const environment = { ...process.env };

// On Windows, standalone Rust installers can take precedence over rustup in
// PATH. Shopify Functions require rustup's wasm32-wasip1 target, so prefer the
// rustup shims whenever they are available.
if (process.platform === "win32" && environment.USERPROFILE) {
  const rustupBin = join(environment.USERPROFILE, ".cargo", "bin");
  if (existsSync(join(rustupBin, "rustup.exe"))) {
    const pathEntries = (environment.PATH ?? "").split(delimiter);
    environment.PATH = [
      rustupBin,
      ...pathEntries.filter(
        (entry) => entry.toLocaleLowerCase() !== rustupBin.toLocaleLowerCase(),
      ),
    ].join(delimiter);
  }
}

const command = process.platform === "win32" ? "shopify.cmd" : "shopify";
const appDirectory = join(import.meta.dirname, "..", "apps", "shopify-admin");
const result = spawnSync(
  command,
  ["app", "build", "--path", appDirectory, "--skip-dependencies-installation"],
  {
    cwd: appDirectory,
    env: environment,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

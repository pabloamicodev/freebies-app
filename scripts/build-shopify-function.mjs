import { spawnSync } from "node:child_process";
import { join } from "node:path";

const [wasmPath, maximumBytes = "262143"] = process.argv.slice(2);
if (!wasmPath) {
  throw new Error(
    "Usage: node scripts/build-shopify-function.mjs <output.wasm> [maximum-bytes]",
  );
}

const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const build = spawnSync(
  cargo,
  ["build", "--target=wasm32-wasip1", "--target-dir=target", "--release"],
  { env: process.env, stdio: "inherit", shell: false },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const optimize = spawnSync(
  process.execPath,
  [join(import.meta.dirname, "optimize-wasm.mjs"), wasmPath, maximumBytes],
  { env: process.env, stdio: "inherit", shell: false },
);
if (optimize.error) throw optimize.error;
process.exit(optimize.status ?? 1);

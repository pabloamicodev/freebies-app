import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import binaryen from "binaryen";

const [inputPath, maximumBytesArgument] = process.argv.slice(2);
if (!inputPath) {
  throw new Error("Usage: node scripts/optimize-wasm.mjs <input.wasm> [maximum-bytes]");
}

const maximumBytes = maximumBytesArgument ? Number(maximumBytesArgument) : null;
if (maximumBytes !== null && (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)) {
  throw new Error(`Invalid maximum byte size: ${maximumBytesArgument}`);
}

const absolutePath = resolve(inputPath);
const temporaryPath = resolve(dirname(absolutePath), `.${crypto.randomUUID()}.optimized.wasm`);
const source = await readFile(absolutePath);

binaryen.setOptimizeLevel(4);
binaryen.setShrinkLevel(2);
const module = binaryen.readBinary(source);
try {
  module.setFeatures(
    module.getFeatures()
      | binaryen.Features.MutableGlobals
      | binaryen.Features.NontrappingFPToInt
      | binaryen.Features.BulkMemory
      | binaryen.Features.SignExt
      | binaryen.Features.BulkMemoryOpt,
  );
  module.optimize();
  if (!module.validate()) throw new Error("Binaryen produced an invalid WebAssembly module");
  await writeFile(temporaryPath, module.emitBinary());
} finally {
  module.dispose();
}

const optimizedBytes = (await stat(temporaryPath)).size;
if (maximumBytes !== null && optimizedBytes > maximumBytes) {
  await rm(temporaryPath, { force: true });
  throw new Error(
    `Optimized WASM is ${optimizedBytes} bytes; maximum allowed is ${maximumBytes} bytes`,
  );
}

await rename(temporaryPath, absolutePath);
console.log(`Optimized ${source.byteLength} -> ${optimizedBytes} bytes: ${absolutePath}`);

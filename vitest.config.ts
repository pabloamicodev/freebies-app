import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "workers/**/*.test.ts",
      "apps/shopify-admin/app/lib/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["packages/*/src/**", "workers/*/src/**", "apps/shopify-admin/app/lib/*.server.ts"],
      thresholds: {
        statements: 47,
        branches: 71,
        functions: 59,
        lines: 47,
      },
    },
  },
  resolve: {
    alias: {
      "@promo/shared-types": resolve(__dirname, "packages/shared-types/src/index.ts"),
      "@promo/rule-engine": resolve(__dirname, "packages/rule-engine/src/index.ts"),
      "@promo/db": resolve(__dirname, "packages/db/src/index.ts"),
    },
  },
});

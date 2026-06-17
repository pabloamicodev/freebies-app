import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import type { Linter } from "eslint";

// All tsconfig.json files in the monorepo (excluding node_modules)
const tsProjects = [
  "./tsconfig.json",
  "./apps/shopify-admin/tsconfig.json",
  "./packages/db/tsconfig.json",
  "./packages/rule-engine/tsconfig.json",
  "./packages/shared-types/tsconfig.json",
  "./packages/storefront-runtime/tsconfig.json",
  "./workers/product-sync/tsconfig.json",
];

const config: Linter.Config[] = [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/target/**", "**/.shopify/**"],
  },
  // Type-aware rules for source files included in tsconfigs
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "**/*.config.ts",
      "**/tests/**",
      "**/test/**",
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: tsProjects,
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint as unknown as Linter.Plugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/await-thenable": "error",
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
  // Config files and test files — no type-aware rules (not in any tsconfig)
  {
    files: ["**/*.config.ts", "**/tests/**/*.ts", "**/test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint as unknown as Linter.Plugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
];

export default config;

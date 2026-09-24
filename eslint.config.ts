import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import type { Linter } from "eslint";

type FlatConfigPlugin = NonNullable<Linter.Config["plugins"]>[string];

// All tsconfig.json files in the monorepo (excluding node_modules)
const tsProjects = [
  "./tsconfig.json",
  "./apps/shopify-admin/tsconfig.json",
  "./packages/db/tsconfig.json",
  "./packages/rule-engine/tsconfig.json",
  "./packages/shared-types/tsconfig.json",
  "./packages/storefront-runtime/tsconfig.json",
];

const config: Linter.Config[] = [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/.shopify/**",
      "**/.react-router/**",
    ],
  },
  // Type-aware rules for source files included in tsconfigs
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "**/*.config.ts",
      "**/tests/**",
      "**/test/**",
      // UI extensions have dedicated tsconfigs with Shopify surface-specific
      // JSX types and are linted by the non-type-aware block below.
      "apps/shopify-admin/extensions/**",
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
      "@typescript-eslint": tseslint as unknown as FlatConfigPlugin,
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
  // Config files, test files, and UI extensions — no type-aware rules (not in any tsconfig)
  {
    files: [
      "**/*.config.ts",
      "**/tests/**/*.ts",
      "**/test/**/*.ts",
      "apps/shopify-admin/extensions/**/*.ts",
      "apps/shopify-admin/extensions/**/*.tsx",
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint as unknown as FlatConfigPlugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
];

export default config;

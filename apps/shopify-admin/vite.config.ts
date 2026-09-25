import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { sentryVitePlugin } from "@sentry/vite-plugin";

if (process.env["VERCEL"] && !process.env["SENTRY_AUTH_TOKEN"]) {
  console.warn("[sentry] SENTRY_AUTH_TOKEN is not available at build time; source maps will not be uploaded.");
}

export default defineConfig({
  plugins: [
    reactRouter(),
    tsconfigPaths(),
    // Uploads source maps on CI/Vercel builds only; must stay last.
    process.env["SENTRY_AUTH_TOKEN"] && sentryVitePlugin({
      org: process.env["SENTRY_ORG"],
      project: process.env["SENTRY_PROJECT"],
      authToken: process.env["SENTRY_AUTH_TOKEN"],
      release: { name: process.env["VERCEL_GIT_COMMIT_SHA"] || process.env["VERCEL_DEPLOYMENT_ID"] },
      sourcemaps: { filesToDeleteAfterUpload: ["./build/**/*.map"] },
      telemetry: false,
      debug: process.env["SENTRY_DEBUG"] === "1",
    }),
  ],
  build: {
    target: "esnext",
    sourcemap: "hidden",
    assetsInlineLimit: 0,
    rollupOptions: {
      external: ["pg-native", "cloudflare:sockets"],
    },
  },
  server: {
    port: 3000,
    host: "localhost",
  },
});

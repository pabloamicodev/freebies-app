import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    reactRouter(),
    tsconfigPaths(),
  ],
  build: {
    target: "esnext",
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

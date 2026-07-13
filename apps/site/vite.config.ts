import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Two static pages: the landing at / and the playground at /panel/.
  // No SPA fallback, so a bad URL 404s instead of serving the landing.
  appType: "mpa",
  resolve: {
    alias: {
      "@liquidlens/core": resolve(__dirname, "../../packages/core/src/index.ts"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "index.html"),
        panel: resolve(__dirname, "panel/index.html"),
      },
    },
  },
});

import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@liquidlens/core": resolve(__dirname, "../../packages/core/src/index.ts"),
    },
  },
});

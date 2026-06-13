import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: [
      "apps/extension/src/**/*.test.ts",
      "packages/shared/src/**/*.test.ts"
    ]
  },
  resolve: {
    alias: {
      "@describeops/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname
    }
  }
});

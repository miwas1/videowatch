import { defineConfig } from "vitest/config";

// jsdom's html-encoding-sniffer require()s the ESM-only @exodus/bytes, which
// Node < 22.12 rejects unless ESM-in-require is enabled. Vitest workers inherit
// this env var, so it applies to every pool without a manual CLI flag.
if (!process.env.NODE_OPTIONS?.includes("--experimental-require-module")) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --experimental-require-module`.trim();
}

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

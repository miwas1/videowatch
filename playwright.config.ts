import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["apps/extension/tests/e2e/**/*.spec.ts"],
  timeout: 30_000,
  use: {
    trace: "retain-on-failure"
  }
});

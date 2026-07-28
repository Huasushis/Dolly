import { defineConfig } from "vitest/config";

/**
 * Tests for the removed in-process orchestrator and its old extension model.
 * These tests remain available for migration work but are not release gates.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "tests/config.test.ts",
      "tests/core/**/*.test.ts",
      "tests/extensions/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/sdk/define-extension.test.ts",
    ],
    testTimeout: 30000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/conformance/**/*.test.ts", "tests/sdk/public-sdk.test.ts"],
    testTimeout: 30000,
    fileParallelism: false,
  },
});

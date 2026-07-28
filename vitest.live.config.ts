import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "tests/integration/forward-expand.test.ts",
      "tests/integration/image-ops.test.ts",
      "tests/integration/llm-conversation.test.ts",
      "tests/integration/memory-recall.test.ts",
    ],
    testTimeout: 120000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The runner tests drive real HTTP servers and a reconnection backoff,
    // so they need more than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});

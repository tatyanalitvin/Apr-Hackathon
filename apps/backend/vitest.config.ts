import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: false,
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every store test opens its own in-memory Postgres (PGlite) and applies the migrations to it.
    testTimeout: 20_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every store test opens its own in-memory Postgres (PGlite) and applies the migrations to it.
    testTimeout: 20_000,
    server: {
      deps: {
        // @x402/next imports "next/server" with no extension, which only a bundler resolves (Next has no exports map).
        inline: ["@x402/next"],
      },
    },
  },
});

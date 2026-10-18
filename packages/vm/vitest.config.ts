import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The browser tests need Chrome: they run on their own, with `pnpm --filter @app/vm test:browser`.
    exclude: ["test/browser/**", "node_modules/**"],
  },
});

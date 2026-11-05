import { defineConfig } from "vitest/config";

// Opt-in: these tests reach real services. The director's calls real models through the AI Gateway and spends money on
// the card; the store's runs on a Neon branch of its own. They never run in `pnpm test` or in CI: only with
// `pnpm --filter @app/web test:live`, with what each one names in the environment.
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    // The director takes 40 to 60 s.
    testTimeout: 180_000,
    fileParallelism: false,
  },
});

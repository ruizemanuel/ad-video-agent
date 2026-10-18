import { defineConfig } from "vitest/config";

// Opt-in: these tests call real models through the AI Gateway and spend money on the card. They never run in
// `pnpm test` or in CI: only with `pnpm --filter @app/web test:live`, with the gateway's credentials in the environment.
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    // The director takes 40 to 60 s.
    testTimeout: 180_000,
    fileParallelism: false,
  },
});

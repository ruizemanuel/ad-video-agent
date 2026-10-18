import { defineConfig } from "vitest/config";

// Opt-in: these tests drive a real Chrome (chrome-headless-shell, downloaded on the first run) against a local site.
export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
    // Taking the shots of a site at two sizes takes a while, and the first run downloads the browser.
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});

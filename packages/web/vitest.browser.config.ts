import { defineConfig } from 'vitest/config';

// Opt-in (`pnpm --filter @app/web test:browser`, never next to another suite): the page as a person sees it, in Chrome
// Headless Shell (the VM's, downloaded on the first run), against the app served by `next dev` on the fake adapters,
// with a stub wallet. Nothing the browser asks for leaves this machine, and no money moves.
export default defineConfig({
  test: {
    include: ['test/browser/**/*.test.ts'],
    // Next refuses a second `next dev` in the same folder: one file at a time, in a single fork, each starting its apps
    // one after the other.
    pool: 'forks',
    fileParallelism: false,
    // The first request to a page compiles it, which can take a minute; the first run also downloads the browser.
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});

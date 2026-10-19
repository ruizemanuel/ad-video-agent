import { workflow } from '@workflow/vitest';
import { defineConfig } from 'vitest/config';

// The order workflow from start to end, run in-process by the Workflow SDK's test world: its directives compiled, its
// steps on the fake adapters (AD_AGENT_ADAPTERS=fake, files in a temporary FAKE_DIR) and the VM played by the test, which
// resumes the task hooks. Nothing reaches the network, a model, the chain or a VM.
export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ['test/integration/**/*.integration.test.ts'],
    setupFiles: ['test/integration/core-resolve.ts'],
    // A run goes through a dozen steps and waits for the test to act as the VM.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

// Opt-in (`pnpm --filter @app/vm test:browser`). The worker runs through tsx, whose esbuild wraps the named functions
// in `__name(...)` calls, and the functions sent to the page (capture/extract.ts) go there with those calls inside. This
// runs them under tsx, which vitest does not: it fails if the page is not given what those calls need.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('the functions sent to the page, under tsx', () => {
  it('run in the page and read it', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'test/browser/support/read-page-under-tsx.ts'], { cwd: root, timeout: 120_000 });

    expect(stdout).toContain('SECTIONS ["Hello there"]');
  });
});

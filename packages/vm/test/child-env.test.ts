import { describe, expect, it } from 'vitest';
import { childEnv, takeSecret } from '../src/child-env';

describe('childEnv', () => {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/worker',
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    VM_TOKEN: 'tok_secret',
    API_BASE: 'https://api.example',
    SPEND_WALLET_PRIVATE_KEY: '0xdead',
    npm_config_user_agent: 'pnpm',
  };

  it('lets a child process see what it needs to run and nothing else', () => {
    const child = childEnv(env);

    expect(child).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/worker', LANG: 'C.UTF-8', TMPDIR: '/tmp' });
  });

  it('never carries the order token', () => {
    expect(JSON.stringify(childEnv(env))).not.toContain('tok_secret');
    expect(Object.keys(childEnv({ ...env, vm_token: 'x', Vm_Token: 'y' }))).not.toContain('VM_TOKEN');
  });

  it('keeps the variables Windows needs to start a program, whatever the case of their names', () => {
    const child = childEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\tmp', VM_TOKEN: 'x' });
    expect(child).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\tmp' });
  });
});

describe('takeSecret', () => {
  it('reads a variable once and takes it out of the environment, so nothing started later can inherit it', () => {
    const env: NodeJS.ProcessEnv = { VM_TOKEN: 'tok_secret', API_BASE: 'https://api.example' };

    expect(takeSecret(env, 'VM_TOKEN')).toBe('tok_secret');

    expect(env).toEqual({ API_BASE: 'https://api.example' });
    expect(takeSecret(env, 'VM_TOKEN')).toBeUndefined();
  });
});

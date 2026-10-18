// What the worker lets the programs it starts see of its environment. Chrome runs code from other people's sites and
// ffmpeg reads files they influence, so neither gets the order token (or anything else the worker was started with):
// only the few variables a program needs to run at all.

// By upper-cased name, because Windows spells them Path, SystemRoot... and the VM's Linux, PATH, HOME...
const ALLOWED = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
]);

/** The environment for a child process: the variables a program needs to run, and nothing else. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && ALLOWED.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}

/** Reads a secret from the environment once and takes it out, so a program started later cannot inherit it. */
export function takeSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  delete env[name];
  return value === '' ? undefined : value;
}

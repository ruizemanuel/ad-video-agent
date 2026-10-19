// The workflow test build bundles this app's own files, but leaves the workspace package @app/core to Node, which loads
// it from its TypeScript sources (Node strips the types). Those sources import each other without an extension, as a
// bundler allows and Node's loader does not: this hook tries the `.ts` file when such an import is not found. It only
// acts for imports made from a `.ts` file, and only after Node's own resolution failed.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      const fromTs = context.parentURL?.endsWith('.ts') ?? false;
      if (!relative || !fromTs || /\.[cm]?[jt]sx?$/.test(specifier) || (error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

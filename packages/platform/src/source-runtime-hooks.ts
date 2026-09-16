import { statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Preloaded (`--import`) into a private runner re-invoked from WTM's TypeScript source; see
 * `selfRuntimeInvocation`. Node strips the types itself. This adds only what the repository's
 * extensionless relative imports need: `./x` means `./x.ts`, or `./x/index.ts`.
 *
 * Synchronous and in-thread by design. No loader worker and no compiler child process is started,
 * so a detached anchor's process group holds nothing but the anchor and its task.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parentURL = context.parentURL;
      if (
        !isResolutionMiss(error)
        || !(specifier.startsWith('./') || specifier.startsWith('../'))
        || parentURL === undefined
        || !parentURL.startsWith('file:')
        || !/\.[cm]?ts$/.test(new URL(parentURL).pathname)
      ) throw error;
      for (const suffix of ['.ts', '/index.ts']) {
        const candidate = new URL(`${specifier}${suffix}`, parentURL);
        if (isFile(candidate)) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
});

function isResolutionMiss(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT';
}

function isFile(url: URL): boolean {
  try { return statSync(fileURLToPath(url)).isFile(); }
  catch { return false; }
}

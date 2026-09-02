import { isBuiltin, registerHooks } from 'node:module';

const moduleDeniedSentinel = 'WTM_ADAPTER_MODULE_DENIED';

export async function runAdapterChild(descriptor: number, executableBasename: string): Promise<number> {
  const descriptorPath = `/dev/fd/${descriptor}`;
  const entry = `file://${descriptorPath}`;
  const deny = (): never => {
    process.stderr.write(`${moduleDeniedSentinel}\n`);
    throw new Error('external adapter module dependency is not permitted');
  };
  const canonicalBuiltin = (specifier: unknown): string => typeof specifier === 'string'
    ? (specifier.startsWith('node:') ? specifier : `node:${specifier}`)
    : '';
  const isSupportedBuiltin = (specifier: unknown): boolean => {
    const canonical = canonicalBuiltin(specifier);
    return canonical !== 'node:module' && isBuiltin(canonical);
  };
  const getBuiltinModule = process.getBuiltinModule?.bind(process);
  if (getBuiltinModule !== undefined) {
    Object.defineProperty(process, 'getBuiltinModule', {
      configurable: false,
      enumerable: true,
      writable: false,
      value(specifier: string) {
        const canonical = canonicalBuiltin(specifier);
        if (isBuiltin(canonical) && !isSupportedBuiltin(canonical)) return deny();
        return getBuiltinModule(specifier);
      },
    });
  }
  Object.defineProperty(globalThis, 'module', {
    configurable: false,
    enumerable: false,
    get: deny,
  });
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // Short-circuited rather than handed to the default resolver, and this is a platform fact
      // rather than an optimisation. `finalizeResolution` calls `realpath` on every resolved file
      // path. On macOS `/dev/fd` is the `fdesc` filesystem and `realpath('/dev/fd/3')` returns
      // itself, so the default path worked. On Linux `/dev/fd` is `/proc/self/fd`, whose entries
      // are magic symlinks that read `"/tmp/.../adapter.mjs (deleted)"` once the file is unlinked
      // -- and the private copy this child executes is *always* unlinked, because being anonymous
      // is the guarantee. `stat` and `open` on that descriptor still work; only `realpath` fails,
      // with ENOENT on a path that has " (deleted)" glued to the end of it.
      //
      // Reproduced in node:24.18.0-bookworm: readlink reports the deleted suffix, statSync says
      // isFile, openSync succeeds, realpathSync throws. It cost 25 red tests in the first Linux CI
      // run, all of them reporting `External adapter request failed.` and nothing else.
      if (specifier === entry || specifier === descriptorPath) {
        return { url: entry, format: 'module', shortCircuit: true };
      }
      if (specifier.startsWith('node:') && isSupportedBuiltin(specifier)) return nextResolve(specifier, context);
      return deny();
    },
    load(url, context, nextLoad) {
      if (url === entry) return nextLoad(url, { ...context, format: 'module' });
      return nextLoad(url, context);
    },
  });
  process.argv[1] = executableBasename;
  try {
    await import(descriptorPath);
    return 0;
  } catch {
    return 1;
  }
}

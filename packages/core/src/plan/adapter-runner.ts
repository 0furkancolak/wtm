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
      if (specifier === entry || specifier === descriptorPath) return nextResolve(specifier, context);
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

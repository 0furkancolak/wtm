import { resolve } from 'node:path';

/** How WTM starts its own executable again for a private runner mode or the daemon service. */
export interface RuntimeInvocation {
  executable: string;
  prefixArgs: readonly string[];
}

/** The facts about the running process that decide its re-invocation. Injected by tests. */
export interface RuntimeInvocationHost {
  /** A Node single-executable application: the executable is WTM itself. */
  isSea: boolean;
  execPath: string;
  /** `process.argv[1]`, the entry script of a non-SEA process. */
  entry: string | undefined;
}

const typeScriptEntry = /\.[cm]?ts$/i;

/**
 * The re-invocation of the running WTM process (todo 50c).
 *
 * - A standalone executable re-invokes itself; there is no separate entry script.
 * - A built entry (`dist/cli/bin.js`) is re-invoked as `node <entry>`.
 * - A TypeScript source entry (`node --import tsx packages/cli/src/bin.ts`) is re-invoked as
 *   `node --import <source hooks> <entry>`. Without a loader the child cannot resolve the
 *   extensionless relative imports and every queued job failed with `RUNTIME_START_FAILED`.
 *
 * The parent's `process.execArgv` is deliberately *not* inherited. Its loader is the obvious
 * candidate and the wrong one: tsx's ESM loader starts a persistent `esbuild --service` child on a
 * cold transform cache. A private anchor is its own detached process group and waits for that
 * group to drain before it reports completion, while the esbuild service waits for the anchor to
 * exit — the job never completes. `--inspect*` flags would also collide on the parent's debug
 * port, and memory or warning flags are the parent's own tuning, not the anchor's. The source hooks
 * instead resolve extensionless `.ts` imports in-thread and leave the rest to Node's built-in type
 * stripping, so a source-launched private runner starts no compiler process at all. The private
 * runner graph therefore has to stay erasable TypeScript; `source-runtime-invocation.test.ts`
 * loads every private mode through this invocation to keep it so.
 */
export function selfRuntimeInvocation(host: RuntimeInvocationHost = currentRuntimeHost()): RuntimeInvocation {
  if (host.isSea) return { executable: host.execPath, prefixArgs: [] };
  if (host.entry === undefined) throw new Error('WTM CLI entry path is unavailable');
  const entry = resolve(host.entry);
  const executable = resolve(host.execPath);
  if (!typeScriptEntry.test(entry)) return { executable, prefixArgs: [entry] };
  return { executable, prefixArgs: ['--import', sourceRuntimeHooksUrl(), entry] };
}

/** The `--import` specifier of the in-thread resolver a TypeScript source entry is re-invoked with. */
export function sourceRuntimeHooksUrl(): string {
  // Evaluated only for a source entry: a bundle has no sibling hooks file, and never needs one.
  return new URL('./source-runtime-hooks.ts', import.meta.url).href;
}

function currentRuntimeHost(): RuntimeInvocationHost {
  return {
    isSea: process.getBuiltinModule?.('node:sea')?.isSea() === true,
    execPath: process.execPath,
    entry: process.argv[1],
  };
}

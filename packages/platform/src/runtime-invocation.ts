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
 * Which of the parent's `process.execArgv` entries reach the child *through argv* is the decision
 * this function exists to make, and the answer is *none of them*. Taken flag class by flag class:
 *
 * - `--inspect`, `--inspect-brk`, `--inspect-port`: never propagated. Each binds a fixed debug
 *   port, so a second process inheriting one either fails to start or steals the port from the
 *   daemon that is debugging. A private runner is spawned per job, so this is a guaranteed clash,
 *   not a rare one.
 * - `--max-old-space-size`, `--trace-*`, `--no-warnings` and friends: never propagated. They are
 *   the operator's tuning of *the daemon*, and an anchor that inherited them would silently size
 *   its heap or its diagnostics to a process it has nothing in common with.
 * - `--import <x>` / `--loader <x>`: the one class that looks like it should be inherited, and the
 *   reason this bug was filed. It is still not propagated — it is *replaced*. In development the
 *   loader is tsx, whose ESM hooks start a persistent `esbuild --service` child on a cold
 *   transform cache. A private anchor is its own detached process group and only reports
 *   completion once that group drains, while the esbuild service stays alive waiting for the
 *   anchor to exit: the job never completes. (`testkit/src/runtime-invocation.ts` records the same
 *   finding, which is why the tests had to pre-bundle a runner to get around it.)
 *
 * What replaces it is `source-runtime-hooks.ts`: an in-thread resolver for this repository's
 * extensionless relative imports, with type stripping left to Node's own. No loader worker and no
 * compiler child process, so the anchor's group holds nothing but the anchor and its task. The
 * price is that the private runner module graph must stay erasable TypeScript;
 * `cli/src/__tests__/source-runtime-invocation.test.ts` loads every private mode through this
 * invocation, and audits the child's `spawn` calls, to keep both properties true.
 *
 * Two things this decision does *not* reach, both worth knowing before trusting the paragraph
 * above:
 *
 * - `NODE_OPTIONS` is a second channel. Its entries show up in `process.execArgv` too, but they
 *   travel to the child in the environment, which `process-supervisor.ts` `spawnAnchor` passes
 *   through wholesale. A daemon started with `NODE_OPTIONS="--import tsx"` therefore still hands
 *   its anchor tsx, and gets exactly the esbuild-in-a-detached-group hang described above,
 *   whatever this function returns. Neutralising it belongs in the spawn, not here.
 * - `cli/src/main.ts` `daemonProgramArguments` builds the *service unit* argv from this same
 *   invocation. That graph is `bin.ts` -> `main.ts` -> the `@wtm/platform` barrel, which is not
 *   erasable today (`platform/src/service/errors.ts` uses a parameter property), so a source
 *   checkout's `wtm daemon install` still writes a unit that cannot start. That is not a
 *   regression — the previous argv failed too, earlier and for a different reason — but the
 *   erasability requirement below is about the private runner graph and does not cover it.
 *
 * `execPath` and `entry` are both made absolute because the anchor is spawned with `cwd` set to
 * the worktree (`process-supervisor.ts` `spawnAnchor`), not to the daemon's own directory. The
 * daemon previously used the bare `process.argv[1]`; a daemon launched by a relative path would
 * have handed the child an entry that does not exist from the worktree.
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

/**
 * The macOS spelling of the service lifecycle, kept for the test that proves macOS survived.
 *
 * There is almost nothing left here. The transactional publisher moved to `service-lifecycle.ts`,
 * which is platform-neutral, and everything that was actually about launchd -- the label, the
 * plist body, the `launchctl` argument vectors, the `LaunchAgents` directory, the `ps` reader and
 * the legacy `dev.wtm.daemon` migration -- moved to `@wtm/platform/service`. What remains is a
 * facade: `createLaunchdLifecycle` binds `darwinServiceBackend`, and `named` below renames one
 * field of the result.
 *
 * **The CLI no longer calls it.** An earlier draft of this header said the names were kept because
 * the CLI could not be edited, and that C1-7 was where the two spellings would become one. That is
 * now done, and differently from how it was predicted: `main.ts` builds its lifecycle with
 * `createServiceLifecycle({ backend: runtime.service })`, from the *selected* platform. It had to.
 * While the CLI called `createLaunchdLifecycle`, this file's hardcoded `darwinServiceBackend` made
 * the entire Linux service backend unreachable from the product -- `wtm daemon install` on Linux
 * would have driven `launchctl` argument vectors at a host with no `launchctl`, which is precisely
 * the "looks like Linux support and does not start" failure the increment was written to avoid.
 *
 * Nor did the two names become one. `plistPath` is a documented field of the `wtm daemon status`
 * envelope, and JSON output is a compatibility contract that may only grow, so the CLI *adds*
 * `definitionPath` and keeps `plistPath` beside it on macOS, dropping it on Linux where no plist
 * exists. C2 removes the macOS half once the deprecation has shipped in a release.
 *
 * So the only caller left is `__tests__/launchd.test.ts`, which names `createLaunchdLifecycle` 137
 * times and `plistPath` 102 times. That is the reason this facade is still here, and it is a good
 * one: that file being byte-unchanged through a 2580-line refactor is the strongest evidence the
 * increment has that macOS behaviour survived, and it is not worth spending on a rename no user
 * can observe. It goes when the test does, in C2.
 */
import { homedir } from 'node:os';
import { dirname } from 'node:path/posix';
import {
  ServiceLifecycleError,
  darwinServiceBackend,
  generateLaunchdPlist,
  launchdCommands,
  launchdLabelFor,
  legacyLaunchdLabel,
  sanitizeLaunchdPathEnvironment,
} from '@wtm/platform/service';
import type {
  LaunchdCommandSet,
  LaunchdPlistOptions,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceProcessInspection,
  ServiceProcessInspector,
} from '@wtm/platform/service';
import { createServiceLifecycle, servicePathsFor } from './service-lifecycle';
import type {
  ServiceInstallState,
  ServiceLifecycleOptions,
  ServicePaths,
  ServiceStatusState,
  ServiceTransactionPhase,
  ServiceUninstallState,
} from './service-lifecycle';

export {
  generateLaunchdPlist,
  launchdCommands,
  launchdLabelFor,
  legacyLaunchdLabel,
  sanitizeLaunchdPathEnvironment,
};
export type { LaunchdCommandSet, LaunchdPlistOptions };

/**
 * The error every lifecycle operation raises. It is `ServiceLifecycleError` now -- the class moved
 * with the publisher and is shared with the systemd backend -- and the export keeps its name
 * because `instanceof` checks and the CLI's code mapping both still read it that way.
 */
export { ServiceLifecycleError as LaunchdLifecycleError };
export type { ServiceLifecycleErrorCode as LaunchdLifecycleErrorCode } from '@wtm/platform/service';

export type LaunchdCommandResult = ServiceCommandResult;
export type LaunchdCommandRunner = ServiceCommandRunner;
export type LaunchdProcessInspection = ServiceProcessInspection;
export type LaunchdProcessInspector = ServiceProcessInspector;
export type LaunchdTransactionPhase = ServiceTransactionPhase;
export type LaunchdInstallState = ServiceInstallState;
export type LaunchdUninstallState = ServiceUninstallState;
export type LaunchdStatusState = ServiceStatusState;

export interface LaunchdLifecycleResult<State extends string> {
  action: 'install' | 'uninstall' | 'status';
  state: State;
  label: string;
  plistPath: string;
}

export interface LaunchdStatusResult extends LaunchdLifecycleResult<LaunchdStatusState> {
  /**
   * launchd's own word for the job: `running` while a process is alive, `not running` when
   * the job is loaded but idle, and `null` when launchd does not know the job at all.
   */
  runState: string | null;
}

export interface LaunchdLifecycle {
  install(): Promise<LaunchdLifecycleResult<LaunchdInstallState>>;
  uninstall(): Promise<LaunchdLifecycleResult<LaunchdUninstallState>>;
  status(): Promise<LaunchdStatusResult>;
}

export type LaunchdLifecycleOptions = Omit<ServiceLifecycleOptions, 'backend' | 'env'>;

/**
 * The macOS spelling of `ServicePaths`.
 *
 * The CLI's log reporter has moved onto `servicePathsFor(runtime.service, ...)`, so the callers
 * left are `launchd.test.ts` and the CLI's own macOS assertions -- both of which are about macOS
 * on purpose and both of which read `plistPath` off it.
 */
export interface LaunchdPaths extends ServicePaths {
  /** `~/Library`, which is the user's own and is deliberately not owner-only. */
  libraryDirectory: string;
  agentsDirectory: string;
  plistPath: string;
  /** Where an installation made before the label was derived left its definition. */
  legacyPlistPath: string;
}

export function launchdPaths(home = homedir()): LaunchdPaths {
  const paths = servicePathsFor(darwinServiceBackend, { home, env: {} });
  return {
    ...paths,
    libraryDirectory: dirname(paths.serviceDirectory),
    agentsDirectory: paths.serviceDirectory,
    plistPath: paths.definitionPath,
    legacyPlistPath: paths.legacyDefinitionPath as string,
  };
}

export function createLaunchdLifecycle(options: LaunchdLifecycleOptions): LaunchdLifecycle {
  const lifecycle = createServiceLifecycle({ ...options, backend: darwinServiceBackend, env: {} });
  return {
    install: async () => named(await lifecycle.install()),
    uninstall: async () => named(await lifecycle.uninstall()),
    status: async () => {
      const { runState, ...result } = await lifecycle.status();
      return { ...named(result), runState };
    },
  };
}

/**
 * One field renamed and nothing else. The result is rebuilt rather than spread over, so a
 * `definitionPath` key cannot reach a caller that was promised only `plistPath`.
 *
 * This is a *rename*, unlike the CLI envelope's *addition*, and the difference is who is on the
 * other side: here it is one test file inside this repository, there it is whatever a user has
 * written against a documented JSON contract.
 */
function named<State extends string>(
  result: { action: 'install' | 'uninstall' | 'status'; state: State; label: string; definitionPath: string },
): LaunchdLifecycleResult<State> {
  return { action: result.action, state: result.state, label: result.label, plistPath: result.definitionPath };
}

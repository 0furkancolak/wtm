import type { JsonEnvelope, WtmError, WtmErrorCode } from '@wtm/protocol';
import type { LaunchdLifecycle } from '@wtm/daemon/launchd';

export type DaemonLifecycleAction = 'install' | 'uninstall' | 'status';

export interface ForegroundDaemonRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface DaemonSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

export interface DaemonServeDependencies {
  runtimeFactory: () => Promise<ForegroundDaemonRuntime>;
  signals?: DaemonSignalSource;
  /**
   * Where a startup or shutdown failure is recorded. The daemon runs unattended, so its own
   * stderr is the only place the cause can survive; without it, launchd reports a healthy
   * service and every command against the dead daemon reads as an unexplained failure.
   */
  reportError?: (error: unknown) => void;
}

export interface DaemonServeResult {
  exitCode: number;
  envelope: JsonEnvelope<{ state: 'stopped'; signal: 'SIGINT' | 'SIGTERM' } | null>;
}

/** How long `install` waits for the daemon launchd just started to answer on its socket. */
const readinessDeadlineMs = 20_000;
const readinessIntervalMs = 100;

export async function runDaemonLifecycleCommand(
  action: DaemonLifecycleAction,
  lifecycle: LaunchdLifecycle,
  /**
   * Whether the daemon is answering. launchd reports a service as running the moment it forks,
   * so `install` used to return while the socket was not accepting yet and the very next
   * `wtm start` failed as unavailable — and `status` claimed it was running throughout.
   */
  reachable?: () => Promise<boolean>,
): Promise<JsonEnvelope<unknown>> {
  try {
    const data = await lifecycle[action]();
    if (action === 'uninstall' || reachable === undefined) return successEnvelope(`daemon ${action}`, data);
    const ready = action === 'install' ? await waitUntilReachable(reachable) : await reachable();
    return successEnvelope(`daemon ${action}`, { ...data as object, reachable: ready });
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command: `daemon ${action}`,
      data: null,
      warnings: [],
      errors: [launchdError(action, error)],
    };
  }
}

async function waitUntilReachable(reachable: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + readinessDeadlineMs;
  for (;;) {
    if (await reachable()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((settle) => { setTimeout(settle, readinessIntervalMs); });
  }
}

export async function serveDaemon(dependencies: DaemonServeDependencies): Promise<DaemonServeResult> {
  const signals = dependencies.signals ?? processSignalSource;
  const reportError = dependencies.reportError ?? defaultErrorReport;
  let settleSignal: ((signal: 'SIGINT' | 'SIGTERM') => void) | null = null;
  let settled = false;
  const termination = new Promise<'SIGINT' | 'SIGTERM'>((resolve) => { settleSignal = resolve; });
  const onSigint = () => {
    if (settled) return;
    settled = true;
    settleSignal?.('SIGINT');
  };
  const onSigterm = () => {
    if (settled) return;
    settled = true;
    settleSignal?.('SIGTERM');
  };
  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);

  let runtime: ForegroundDaemonRuntime | null = null;
  let closePromise: Promise<void> | null = null;
  const closeOnce = (): Promise<void> => {
    if (runtime === null) return Promise.resolve();
    closePromise ??= runtime.close();
    return closePromise;
  };
  try {
    try {
      runtime = await dependencies.runtimeFactory();
      await runtime.start();
    } catch (error) {
      reportError(error);
      await closeOnce().catch(() => {});
      return serveFailure('WTM daemon could not start.');
    }
    const signal = await termination;
    try {
      await closeOnce();
    } catch (error) {
      reportError(error);
      return serveFailure('WTM daemon could not close cleanly.');
    }
    return {
      exitCode: 0,
      envelope: successEnvelope('daemon serve', { state: 'stopped' as const, signal }),
    };
  } finally {
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    await closeOnce().catch(() => {});
  }
}

const processSignalSource: DaemonSignalSource = {
  on: (signal, listener) => { process.on(signal, listener); },
  off: (signal, listener) => { process.off(signal, listener); },
};

function successEnvelope<T>(command: string, data: T): JsonEnvelope<T> {
  return { schemaVersion: 1, ok: true, command, data, warnings: [], errors: [] };
}

/**
 * How long a condition already recorded is counted rather than written out again.
 *
 * Collapsing only *consecutive* repeats did nothing for the shape this log actually takes: a
 * pass reports the same handful of conditions once per repository, so no two consecutive
 * lines ever matched and six permanently missing directories filled a quarter of a megabyte.
 */
const repeatWindowMs = 10 * 60_000;
/** A bound on distinct remembered conditions, so a varied stream of one-offs cannot grow. */
const maxTrackedConditions = 256;

/**
 * Writes daemon failures to stderr, which launchd routes to the daemon's error log.
 *
 * Every line is stamped, because an unstamped log cannot answer the only question worth
 * asking of it: whether a condition is happening now or happened once at startup. Without the
 * stamps, a burst of timeouts while an external volume was still cold was indistinguishable
 * from a daemon that had been unable to read anything for hours -- and was read as the latter.
 */
export function createDaemonErrorReporter(
  write: (line: string) => void = (line) => { process.stderr.write(line); },
  clock: () => number = () => Date.now(),
): (error: unknown) => void {
  const seen = new Map<string, { since: number; suppressed: number }>();
  return (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const at = clock();
    const previous = seen.get(detail);
    if (previous !== undefined && at - previous.since < repeatWindowMs) {
      previous.suppressed += 1;
      return;
    }
    // Re-inserting keeps the map in least-recently-written order, so eviction drops the
    // condition that has gone quietest rather than an arbitrary one.
    seen.delete(detail);
    if (seen.size >= maxTrackedConditions) {
      const oldest = seen.keys().next();
      if (oldest.done !== true) seen.delete(oldest.value);
    }
    seen.set(detail, { since: at, suppressed: 0 });
    write(`${new Date(at).toISOString()} ${detail}${recurrence(previous)}\n`);
  };
}

function recurrence(previous: { since: number; suppressed: number } | undefined): string {
  if (previous === undefined || previous.suppressed === 0) return '';
  const times = previous.suppressed === 1 ? 'time' : 'times';
  return ` [also ${previous.suppressed} ${times} since ${new Date(previous.since).toISOString()}]`;
}

const defaultErrorReport = createDaemonErrorReporter();

/**
 * The envelope stays deliberately free of the cause: it is rendered to whoever ran the
 * command, while the full error goes to stderr through the reporter above.
 */
function serveFailure(message: string): DaemonServeResult {
  return {
    exitCode: 1,
    envelope: {
      schemaVersion: 1,
      ok: false,
      command: 'daemon serve',
      data: null,
      warnings: [],
      errors: [{
        code: 'WTM_DAEMON_REQUEST_FAILED',
        message,
        severity: 'error',
        context: { action: 'serve' },
      }],
    },
  };
}

function launchdError(action: DaemonLifecycleAction, error: unknown): WtmError {
  const launchdCode = stringProperty(error, 'code');
  const code: WtmErrorCode = launchdCode === 'LAUNCHD_DOMAIN_UNAVAILABLE'
    ? 'WTM_DAEMON_UNAVAILABLE'
    : launchdCode === 'UNSAFE_LAUNCHD_PATH'
      ? 'RESOURCE_PATH_DENIED'
      : launchdCode === 'INVALID_LAUNCHD_CONFIGURATION' || launchdCode === 'LAUNCHD_UNSUPPORTED_PLATFORM'
        ? 'WTM_CONFIG_INVALID'
        : 'WTM_DAEMON_REQUEST_FAILED';
  const message = launchdCode === 'LAUNCHD_DOMAIN_UNAVAILABLE'
    ? 'The launchd user domain is unavailable.'
    : launchdCode === 'UNSAFE_LAUNCHD_PATH'
      ? 'The launchd installation path is unsafe.'
      : launchdCode === 'LAUNCHD_UNSUPPORTED_PLATFORM'
        ? 'launchd is only available on macOS.'
        : launchdCode === 'INVALID_LAUNCHD_CONFIGURATION'
          ? 'The launchd configuration is invalid.'
          : 'The launchd operation failed.';
  return {
    code,
    message,
    severity: 'error',
    context: { action, ...safeContext(error) },
  };
}

function safeContext(error: unknown): Record<string, string | number | boolean | null> {
  if (typeof error !== 'object' || error === null || !('context' in error) || !isRecord(error.context)) return {};
  return Object.fromEntries(Object.entries(error.context).filter((entry): entry is [string, string | number | boolean | null] => {
    const value = entry[1];
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  }));
}

function stringProperty(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) return null;
  const property = value[key as keyof typeof value];
  return typeof property === 'string' ? property : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { assertDaemonSocketPathFits, publishedDaemonSocketPath } from '@wtm/core';
import { errorSeveritySchema, remediationSchema, wtmErrorCodeSchema } from '@wtm/protocol';
import type { JsonEnvelope, WtmError, WtmErrorCode } from '@wtm/protocol';
import { exitCodeForError } from '../exit-codes';
import { launchdPaths } from '@wtm/daemon/launchd';
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
  /**
   * The address the installed agent will publish. Measured before `install` publishes anything,
   * because an agent whose socket path cannot fit in a socket address will never answer: the
   * readiness poll below would spend its entire deadline on it and then report `reachable: false`
   * with nothing to explain it, which is the state this preflight replaces with the reason.
   */
  socketPath: string = publishedDaemonSocketPath(homedir()),
): Promise<JsonEnvelope<unknown>> {
  try {
    // Before anything is published: the refusal names the length, the limit and the path, and
    // it is the same preflight the daemon's own bind side runs, so the two cannot disagree.
    if (action === 'install') assertDaemonSocketPathFits(socketPath);
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
      errors: [codedError(error, action) ?? launchdError(action, error)],
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
      return serveFailure('WTM daemon could not start.', error);
    }
    const signal = await termination;
    try {
      await closeOnce();
    } catch (error) {
      reportError(error);
      return serveFailure('WTM daemon could not close cleanly.', error);
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
 *
 * Stderr gets the condition and nothing else. It is the daemon's log under launchd, but it is
 * a person's terminal whenever `wtm daemon serve` is run by hand, and that second audience is
 * why frames used to reach a user as a wall of `/Users/runner/.../sea-bin.cjs` -- paths from
 * the machine that built the release, which say nothing about the machine that ran it. The
 * frames are still kept; `retain` puts them in the daemon's own error log, which no one reads
 * by accident.
 */
export function createDaemonErrorReporter(
  write: (line: string) => void = (line) => { process.stderr.write(line); },
  clock: () => number = () => Date.now(),
  retain: (entry: string) => void = appendToDaemonErrorLog,
): (error: unknown) => void {
  const seen = new Map<string, { since: number; suppressed: number }>();
  return (error: unknown) => {
    const detail = reportableCondition(error);
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
    const stamp = new Date(at).toISOString();
    write(`${stamp} ${detail}${recurrence(previous)}\n`);
    const frames = error instanceof Error ? error.stack : undefined;
    if (frames !== undefined && frames !== '') retain(`${stamp} ${frames}\n`);
  };
}

/**
 * One line, whatever was thrown. A multi-line message is a stack in all but name -- child
 * process output and nested causes both arrive that way -- so only the first line is reported
 * and the truncation is marked rather than hidden. The whole value is in the retained entry.
 */
function reportableCondition(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  if (trimmed === '') return error instanceof Error && error.name !== '' ? error.name : 'An unnamed error was reported.';
  const firstBreak = trimmed.search(/[\r\n]/);
  return firstBreak === -1 ? trimmed : `${trimmed.slice(0, firstBreak).trimEnd()} [...]`;
}

/**
 * Where the frames go. Under launchd this is the same file stderr already lands in, so the
 * condition and its frames sit together; run in the foreground it is the only durable record
 * there is, which is a gain -- those frames used to exist only until the terminal scrolled.
 *
 * Best effort by design: a log that cannot be written is not a reason to fail, or to obscure,
 * the failure it was trying to describe.
 */
function appendToDaemonErrorLog(entry: string): void {
  try {
    const path = launchdPaths().stderrPath;
    // The same modes the daemon's managed logs are held at: a failure report names paths
    // inside the user's home and is no more public than the processes it describes.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, entry, { mode: 0o600 });
  } catch {
    // Deliberately silent: see above.
  }
}

function recurrence(previous: { since: number; suppressed: number } | undefined): string {
  if (previous === undefined || previous.suppressed === 0) return '';
  const times = previous.suppressed === 1 ? 'time' : 'times';
  return ` [also ${previous.suppressed} ${times} since ${new Date(previous.since).toISOString()}]`;
}

const defaultErrorReport = createDaemonErrorReporter();

/**
 * For an *uncoded* failure the envelope stays deliberately free of the cause: it is rendered to
 * whoever ran the command, while the full error goes to stderr through the reporter above. That
 * reasoning is unchanged — an arbitrary exception has no business in a stable contract, and this
 * file exists in its current shape because internal detail leaked out of one once.
 *
 * A failure that already carries a `WtmErrorCode` is a different kind of thing. It was written to
 * be read: `DaemonSocketPathTooLongError` names the measured length, the limit and the offending
 * path, and carries the remediation that fixes it. Flattening that to `WTM_DAEMON_REQUEST_FAILED`
 * and exit 1 discarded the only part of the report the user could act on, and left `daemon serve`
 * the one command whose envelope disagreed with every other command's for the same condition.
 */
function serveFailure(message: string, cause: unknown): DaemonServeResult {
  const coded = codedError(cause, 'serve');
  if (coded !== null) return { exitCode: startupFailureExitCode(coded.code), envelope: serveEnvelope(coded) };
  return {
    exitCode: 1,
    envelope: serveEnvelope({
      code: 'WTM_DAEMON_REQUEST_FAILED',
      message,
      severity: 'error',
      context: { action: 'serve' },
    }),
  };
}

function serveEnvelope(error: WtmError): DaemonServeResult['envelope'] {
  return {
    schemaVersion: 1,
    ok: false,
    command: 'daemon serve',
    data: null,
    warnings: [],
    errors: [error],
  };
}

/**
 * The exit status a failed `daemon serve` startup reports.
 *
 * `serve.action` in `main.ts` overrides the envelope-derived status with `result.exitCode`, so the
 * status has to be decided here. It is decided by the SAME table every other command uses
 * (`./exit-codes`), not a local copy: an error code's exit status is a property of the code, and
 * `daemon serve` answering differently from every other command for one condition is exactly the
 * defect this function exists to fix.
 */
function startupFailureExitCode(code: WtmErrorCode): number {
  return exitCodeForError(code);
}

/**
 * The envelope form of a thrown value that already describes itself in the error contract.
 *
 * Structural rather than `instanceof`: the property that matters is carrying a valid
 * `WtmErrorCode`, and a check on the code admits the next error written that way without this
 * function being edited again — while a value that merely happens to have a `code` (an `EINVAL`
 * from libuv, a `LAUNCHD_DOMAIN_UNAVAILABLE` from the lifecycle) does not parse and keeps its
 * existing handling. The context is filtered through `safeContext`, so an error carrying a rich
 * object does not push anything unserialisable into the envelope.
 */
function codedError(error: unknown, action: DaemonLifecycleAction | 'serve'): WtmError | null {
  const code = wtmErrorCodeSchema.safeParse(stringProperty(error, 'code'));
  if (!code.success) return null;
  const raw = stringProperty(error, 'message');
  const message = raw === null ? '' : raw.trim();
  if (message === '') return null;
  const severity = errorSeveritySchema.safeParse(stringProperty(error, 'severity'));
  const remediation = remediationSchema.array().safeParse(
    isRecord(error) ? error.remediation : undefined,
  );
  return {
    code: code.data,
    message,
    severity: severity.success ? severity.data : 'error',
    context: { action, ...safeContext(error) },
    ...(remediation.success && remediation.data.length > 0 ? { remediation: remediation.data } : {}),
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

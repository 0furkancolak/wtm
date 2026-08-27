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
}

export interface DaemonServeResult {
  exitCode: number;
  envelope: JsonEnvelope<{ state: 'stopped'; signal: 'SIGINT' | 'SIGTERM' } | null>;
}

export async function runDaemonLifecycleCommand(
  action: DaemonLifecycleAction,
  lifecycle: LaunchdLifecycle,
): Promise<JsonEnvelope<unknown>> {
  try {
    const data = await lifecycle[action]();
    return successEnvelope(`daemon ${action}`, data);
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

export async function serveDaemon(dependencies: DaemonServeDependencies): Promise<DaemonServeResult> {
  const signals = dependencies.signals ?? processSignalSource;
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
    } catch {
      await closeOnce().catch(() => {});
      return serveFailure('WTM daemon could not start.');
    }
    const signal = await termination;
    try {
      await closeOnce();
    } catch {
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

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  adapterRequestSchema,
  adapterMetadataResponseSchema,
  isProtocolVersionCompatible,
  parseAdapterResponse,
  protocolVersion,
  type AdapterContext,
  type AdapterOperation,
  type AdapterRequest,
  type AdapterResponse,
  type ProtocolVersion,
} from '@wtm/protocol';
import {
  AdapterTrustError,
  type AdapterTrustStore,
  openTrustedAdapterDescriptor,
  type TrustedAdapterDescriptor,
} from './adapter-trust';

const defaultTimeoutMs: Readonly<Record<AdapterOperation, number>> = {
  metadata: 1_000,
  detect: 2_000,
  plan: 5_000,
  doctor: 5_000,
  'cleanup-plan': 5_000,
};

const defaultMaxOutputBytes = 1_048_576;
const terminateGraceMs = 100;
const moduleDeniedSentinel = 'WTM_ADAPTER_MODULE_DENIED';

export interface ExternalAdapterInvocation {
  adapterId: string;
  executablePath: string;
  repositoryRoot: string;
  operation: AdapterOperation;
  context?: AdapterContext;
  trust: AdapterTrustStore;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runtimeInvocation?: RuntimeInvocation;
  hooks?: ExternalAdapterHooks;
}

export interface RuntimeInvocation {
  executable: string;
  prefixArgs: readonly string[];
}

export interface ExternalAdapterHooks {
  /** Runs after the verified bytes have an unlinked private descriptor. */
  afterVerification?(): Promise<void> | void;
  /** Compatibility test boundary; also runs after private descriptor creation. */
  beforeSpawn?(): Promise<void> | void;
  /** Internal test seam for deterministic spawn-error coverage. */
  runtimeExecutable?: string;
  afterDescriptorClose?(): Promise<void> | void;
  afterTerminalCleanup?(state: ExternalAdapterCleanupState): void;
}

export interface ExternalAdapterCleanupState {
  stdinDestroyed: boolean;
  stdoutDestroyed: boolean;
  stderrDestroyed: boolean;
  stdoutDataListeners: number;
  stderrDataListeners: number;
  childCloseListeners: number;
}

export class ExternalAdapterError extends Error {
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;

  constructor(
    readonly code: 'ADAPTER_NOT_TRUSTED' | 'ADAPTER_PROTOCOL_INCOMPATIBLE' | 'ADAPTER_TIMEOUT' | 'ADAPTER_INVALID_RESPONSE',
    message: string,
    context: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExternalAdapterError';
    this.context = context;
  }
}

export async function invokeExternalAdapter(input: ExternalAdapterInvocation): Promise<AdapterResponse> {
  const request = buildRequest(input);
  try {
    assertDescriptorExecutionSupported();
    const descriptor = await openTrustedAdapterDescriptor(input.trust, {
      adapterId: input.adapterId,
      executablePath: input.executablePath,
    });
    try {
      await input.hooks?.afterVerification?.();
      await input.hooks?.beforeSpawn?.();
      const stdout = await requestAdapter(descriptor, request, {
        adapterId: input.adapterId,
        operation: input.operation,
        timeoutMs: checkedTimeout(input.timeoutMs ?? defaultTimeoutMs[input.operation]),
        maxOutputBytes: checkedOutputLimit(input.maxOutputBytes ?? defaultMaxOutputBytes),
        runtimeInvocation: input.hooks?.runtimeExecutable === undefined
          ? (input.runtimeInvocation ?? defaultRuntimeInvocation())
          : { executable: input.hooks.runtimeExecutable, prefixArgs: [] },
        ...(input.hooks?.afterTerminalCleanup === undefined
          ? {}
          : { afterTerminalCleanup: input.hooks.afterTerminalCleanup }),
      });
      return parseResponse(input.adapterId, input.operation, stdout);
    } finally {
      await descriptor.close();
      try {
        await input.hooks?.afterDescriptorClose?.();
      } catch {
        // Hooks are test observers and must not affect terminal adapter errors.
      }
    }
  } catch (error) {
    if (error instanceof ExternalAdapterError) throw error;
    if (error instanceof AdapterTrustError) {
      throw new ExternalAdapterError('ADAPTER_NOT_TRUSTED', error.message, adapterContext(input));
    }
    throw new ExternalAdapterError('ADAPTER_INVALID_RESPONSE', 'External adapter request failed.', adapterContext(input));
  }
}

function buildRequest(input: ExternalAdapterInvocation): AdapterRequest {
  const raw = input.operation === 'metadata'
    ? { protocol: protocolVersion, operation: input.operation }
    : { protocol: protocolVersion, operation: input.operation, ...input.context };
  const parsed = adapterRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExternalAdapterError('ADAPTER_INVALID_RESPONSE', 'External adapter request is invalid.', adapterContext(input));
  }
  return parsed.data;
}

function requestAdapter(
  descriptor: TrustedAdapterDescriptor,
  request: AdapterRequest,
  input: {
    adapterId: string;
    operation: AdapterOperation;
    timeoutMs: number;
    maxOutputBytes: number;
    runtimeInvocation: RuntimeInvocation;
    afterTerminalCleanup?: (state: ExternalAdapterCleanupState) => void;
  },
): Promise<Buffer> {
  return new Promise<Buffer>((resolveRequest, rejectRequest) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrProbe = Buffer.alloc(0);
    let moduleDependencyDenied = false;
    const stdout: Buffer[] = [];
    let failure: ExternalAdapterError | null = null;
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(input.runtimeInvocation.executable, [
      ...input.runtimeInvocation.prefixArgs,
      '__wtm_internal_adapter',
      String(descriptor.childDescriptor),
      descriptor.executableBasename,
    ], {
      // A dedicated process group lets timeout cleanup terminate adapter descendants
      // without ever signalling WTM or its process group.
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', descriptor.parentDescriptor],
      windowsHide: true,
    });
    // These streams are non-null because the corresponding stdio entries above
    // are fixed to `pipe`; the additional inherited descriptor prevents the
    // generic spawn overload from expressing that invariant.
    const childStdin = child.stdin!;
    const childStdout = child.stdout!;
    const childStderr = child.stderr!;
    const onStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > input.maxOutputBytes) {
        stop(new ExternalAdapterError(
          'ADAPTER_INVALID_RESPONSE', 'External adapter returned an invalid response.', adapterContext(input),
        ));
        return;
      }
      stdout.push(chunk);
    };
    const onStderr = (chunk: Buffer) => {
      stderrBytes += chunk.length;
      const combined = Buffer.concat([stderrProbe, chunk]);
      moduleDependencyDenied ||= combined.includes(moduleDeniedSentinel);
      stderrProbe = combined.subarray(-(moduleDeniedSentinel.length - 1));
      if (stderrBytes > input.maxOutputBytes) {
        stop(new ExternalAdapterError(
          'ADAPTER_INVALID_RESPONSE', 'External adapter returned an invalid response.', adapterContext(input),
        ));
      }
    };
    const onStdinError = () => stop(new ExternalAdapterError(
      'ADAPTER_INVALID_RESPONSE', 'External adapter request failed.', adapterContext(input),
    ));
    const onError = () => finish(new ExternalAdapterError(
      'ADAPTER_INVALID_RESPONSE', 'External adapter request failed.', adapterContext(input),
    ));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (failure !== null) return finish(failure);
      if (moduleDependencyDenied) {
        return finish(new ExternalAdapterError(
          'ADAPTER_NOT_TRUSTED', 'External adapter module dependency is not permitted.', adapterContext(input),
        ));
      }
      if (code !== 0 || signal !== null) {
        return finish(new ExternalAdapterError(
          'ADAPTER_INVALID_RESPONSE', 'External adapter request failed.', adapterContext(input),
        ));
      }
      return finish();
    };
    const releaseChildResources = () => {
      clearTimeout(timeout);
      if (terminateTimer !== undefined) clearTimeout(terminateTimer);
      childStdin.off('error', onStdinError);
      childStdout.off('data', onStdout);
      childStderr.off('data', onStderr);
      child.off('error', onError);
      child.off('close', onClose);
      childStdin.destroy();
      childStdout.destroy();
      childStderr.destroy();
      child.unref();
      try {
        input.afterTerminalCleanup?.({
          stdinDestroyed: childStdin.destroyed,
          stdoutDestroyed: childStdout.destroyed,
          stderrDestroyed: childStderr.destroyed,
          stdoutDataListeners: childStdout.listenerCount('data'),
          stderrDataListeners: childStderr.listenerCount('data'),
          childCloseListeners: child.listenerCount('close'),
        });
      } catch {
        // Hooks are test observers and must not affect terminal adapter errors.
      }
    };
    const finish = (error?: ExternalAdapterError) => {
      if (settled) return;
      settled = true;
      if (failure !== null) signalAdapterProcessGroup(child, 'SIGKILL');
      releaseChildResources();
      if (error === undefined) resolveRequest(Buffer.concat(stdout));
      else rejectRequest(error);
    };
    const stop = (error: ExternalAdapterError) => {
      if (failure !== null) return;
      failure = error;
      signalAdapterProcessGroup(child, 'SIGTERM');
      childStdin.destroy();
      terminateTimer = setTimeout(() => {
        signalAdapterProcessGroup(child, 'SIGKILL');
        // Descendants can retain inherited pipes after the direct child is gone.
        // Settle after the grace period so they cannot hold the caller indefinitely.
        finish(error);
      }, terminateGraceMs);
    };
    const timeout = setTimeout(() => stop(new ExternalAdapterError(
      'ADAPTER_TIMEOUT', 'External adapter request timed out.', adapterContext(input),
    )), input.timeoutMs);
    childStdout.on('data', onStdout);
    childStderr.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
    childStdin.once('error', onStdinError);
    childStdin.end(JSON.stringify(request));
  });
}

function assertDescriptorExecutionSupported(): void {
  const nodeMajor = Number.parseInt(process.versions.node.split('.', 1)[0] ?? '', 10);
  if (process.platform === 'win32' || !Number.isSafeInteger(nodeMajor) || nodeMajor < 24) {
    throw new AdapterTrustError('External adapter descriptor execution is unsupported by this runtime.');
  }
}

function defaultRuntimeInvocation(): RuntimeInvocation {
  // Bun drives the unit suite but production WTM requires Node 24; use the
  // absolute Node runtime there so descriptor inheritance matches production.
  if (Object.hasOwn(process.versions, 'bun')) {
    return {
      executable: 'node',
      prefixArgs: [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../../../cli/src/bin.ts', import.meta.url)),
      ],
    };
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('WTM CLI entry path is unavailable');
  return { executable: process.execPath, prefixArgs: [entry] };
}

function signalAdapterProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // The process may already have exited; direct-child fallback is best effort.
  }
  child.kill(signal);
}

function parseResponse(adapterId: string, operation: AdapterOperation, stdout: Buffer): AdapterResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout));
  } catch {
    throw new ExternalAdapterError('ADAPTER_INVALID_RESPONSE', 'External adapter returned an invalid response.', { adapterId, operation });
  }
  if (operation === 'metadata') assertCompatibleMetadataProtocol(payload, adapterId);
  try {
    if (operation === 'metadata') {
      const response = adapterMetadataResponseSchema.parse(payload);
      if (response.adapter.id !== adapterId) throw new Error('adapter id mismatch');
      return response;
    }
    return parseAdapterResponse(operation, payload);
  } catch {
    throw new ExternalAdapterError('ADAPTER_INVALID_RESPONSE', 'External adapter returned an invalid response.', { adapterId, operation });
  }
}

function assertCompatibleMetadataProtocol(payload: unknown, adapterId: string): void {
  if (!isRecord(payload) || !isRecord(payload.protocol)) {
    throw new ExternalAdapterError('ADAPTER_INVALID_RESPONSE', 'External adapter returned an invalid response.', { adapterId, operation: 'metadata' });
  }
  const { major, minor } = payload.protocol;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || (minor as number) < 0) {
    throw new ExternalAdapterError('ADAPTER_INVALID_RESPONSE', 'External adapter returned an invalid response.', { adapterId, operation: 'metadata' });
  }
  const version: ProtocolVersion = { major: major as 1, minor: minor as number };
  if (!isProtocolVersionCompatible(version)) {
    throw new ExternalAdapterError('ADAPTER_PROTOCOL_INCOMPATIBLE', 'External adapter protocol is incompatible.', {
      adapterId,
      operation: 'metadata',
    });
  }
}

function checkedTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ExternalAdapterError('ADAPTER_INVALID_RESPONSE', 'External adapter request is invalid.', {});
  }
  return timeoutMs;
}

function checkedOutputLimit(maxOutputBytes: number): number {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new ExternalAdapterError('ADAPTER_INVALID_RESPONSE', 'External adapter request is invalid.', {});
  }
  return maxOutputBytes;
}

function adapterContext(input: { adapterId: string; operation: AdapterOperation }): Record<string, unknown> {
  return { adapterId: input.adapterId, operation: input.operation };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

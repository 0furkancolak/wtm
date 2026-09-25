import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import {
  FrameDecoder,
  defaultMaxIpcFrameBytes,
  encodeFrame,
  ipcResponseSchema,
  isProtocolVersionCompatible,
  protocolVersion,
  maxReadinessTimeoutMs,
  readinessLaunchAllowanceMs,
  type IpcRequest,
  type JsonEnvelope,
} from '@wtm/protocol';

const defaultTransportTimeoutMs = 5_000;

/**
 * How long `start()` waits between connect attempts the daemon refused. A daemon that is being
 * restarted removes its socket on the way out and binds it again only after recovering its
 * process records, and a command that lands in that gap used to fail outright. Nothing has been
 * sent at that point, so trying again cannot repeat an action. About a second in total: long
 * enough to cover a restart's rebind, short enough that a daemon that is simply not installed
 * is still reported promptly.
 */
const defaultConnectRetryDelaysMs: readonly number[] = [100, 300, 600];

/**
 * The daemon took the request and did not answer in time. Unlike an unreachable daemon, the
 * request may still be carried out -- a `start` waiting behind a previous run's exit, a `stop`
 * inside its grace period -- so the caller must not assume it failed.
 */
export class DaemonRequestTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`Daemon request timed out: ${command}`);
    this.name = 'DaemonRequestTimeoutError';
  }
}

/** The connection went away with this request already sent; the daemon may have acted on it. */
export class DaemonConnectionLostError extends Error {
  constructor(readonly command: string) {
    super(`Daemon connection lost during request: ${command}`);
    this.name = 'DaemonConnectionLostError';
  }
}

export interface DaemonClientOptions {
  socketPath: string;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  /**
   * Bounds every wait this client places on a transport event rather than on a peer's answer: the
   * connect handshake and the close acknowledgement. Neither is guaranteed to arrive. A Windows
   * named pipe in particular can stop producing events entirely -- no `connect`, no `error`, no
   * `close` -- and an unbounded wait on one is a process that never finishes, not a slow one.
   *
   * Deliberately not derived from `requestTimeoutMs`: a caller that wants a short answer from the
   * daemon is not asking for a short connect, and deriving it would turn a tight request bound into
   * a connect deadline a loaded machine could miss.
   */
  transportTimeoutMs?: number;
  /** Fault injection stays at the socket boundary; ordinary callers use a real connection. */
  connect?: (address: string) => Socket;
  /** The waits between refused connect attempts; see {@link defaultConnectRetryDelaysMs}. */
  connectRetryDelaysMs?: readonly number[];
}

export interface FollowLogsOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

export interface DaemonRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Abort a bounded observer on the daemon; it must not undo accepted side effects. */
  cancelRemote?: boolean;
}

interface PendingRequest {
  command: string;
  resolve: (envelope: JsonEnvelope<unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class DaemonClient {
  static readonly #maxTimedOutRequestTombstones = 256;
  readonly #socketPath: string;
  readonly #requestTimeoutMs: number;
  readonly #transportTimeoutMs: number;
  readonly #maxFrameBytes: number;
  readonly #openSocket: (address: string) => Socket;
  readonly #connectRetryDelaysMs: readonly number[];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #timedOutRequestTombstones = new Set<string>();
  #socket: Socket | null = null;
  #starting: Promise<void> | null = null;
  #closed = false;

  constructor(options: DaemonClientOptions) {
    this.#socketPath = options.socketPath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? defaultMaxIpcFrameBytes;
    this.#transportTimeoutMs = options.transportTimeoutMs ?? defaultTransportTimeoutMs;
    this.#openSocket = options.connect ?? ((address) => createConnection(address));
    this.#connectRetryDelaysMs = options.connectRetryDelaysMs ?? defaultConnectRetryDelaysMs;
    if (!Number.isInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new RangeError('Daemon request timeout must be a positive integer');
    }
    if (!Number.isInteger(this.#transportTimeoutMs) || this.#transportTimeoutMs < 1) {
      throw new RangeError('Daemon transport timeout must be a positive integer');
    }
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Daemon client is closed'));
    if (this.#socket !== null && !this.#socket.destroyed) return Promise.resolve();
    if (this.#socket?.destroyed) this.#socket = null;
    if (this.#starting !== null) return this.#starting;
    this.#starting = this.#connectWithRetry().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  /**
   * Retries only a connect the peer refused or closed. A transport that went silent already cost
   * a whole `transportTimeoutMs`, and trying it again would multiply that wait for nothing.
   */
  async #connectWithRetry(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#connect();
        return;
      } catch (error) {
        const delay = this.#connectRetryDelaysMs[attempt];
        const refused = error instanceof Error && error.message !== 'Daemon connection timed out';
        if (delay === undefined || !refused || this.#closed) throw error;
        await new Promise((resolve) => { setTimeout(resolve, delay).unref(); });
      }
    }
  }

  request(command: string, args?: unknown, options: DaemonRequestOptions = {}): Promise<JsonEnvelope<unknown>> {
    const socket = this.#socket;
    if (this.#closed || socket === null || socket.destroyed) {
      return Promise.reject(new Error('Daemon client is not connected'));
    }
    if (options.signal?.aborted) return Promise.reject(new Error(`Daemon request aborted: ${command}`));
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxReadinessTimeoutMs + readinessLaunchAllowanceMs)) {
      return Promise.reject(new RangeError('Daemon request timeout override is outside its supported bound'));
    }
    const id = randomUUID();
    const request: IpcRequest = {
      protocol: protocolVersion,
      id,
      command,
      ...(args === undefined ? {} : { arguments: args }),
    };
    const frame = encodeFrame(Buffer.from(JSON.stringify(request)), this.#maxFrameBytes);

    return new Promise<JsonEnvelope<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        if (pending?.signal !== undefined && pending.onAbort !== undefined) {
          pending.signal.removeEventListener('abort', pending.onAbort);
        }
        this.#rememberTimedOutRequest(id);
        if (options.cancelRemote === true) this.#cancelRemoteRequest(id);
        reject(new DaemonRequestTimeoutError(command, timeoutMs));
      }, timeoutMs);
      timer.unref();
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.#rememberTimedOutRequest(id);
        if (options.cancelRemote === true) this.#cancelRemoteRequest(id);
        reject(new Error(`Daemon request aborted: ${command}`));
      };
      this.#pending.set(id, {
        command,
        resolve,
        reject,
        timer,
        ...(options.signal === undefined ? {} : { signal: options.signal, onAbort }),
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      socket.write(frame, (error) => {
        if (error === null || error === undefined) return;
        this.#rejectPending(id, new Error('Daemon request could not be written'));
      });
    });
  }

  #cancelRemoteRequest(requestId: string): void {
    const socket = this.#socket;
    if (socket === null || socket.destroyed || !socket.writable) return;
    const id = randomUUID();
    // The cancellation acknowledgement is independent of the original late response.
    this.#rememberTimedOutRequest(id);
    const request: IpcRequest = { protocol: protocolVersion, id, command: 'ipc.cancel', arguments: { requestId } };
    try { socket.write(encodeFrame(Buffer.from(JSON.stringify(request)), this.#maxFrameBytes)); }
    catch { /* A lost connection also aborts its server-side observers. */ }
  }

  async followLogs(
    args: { cwd: string; taskName?: string },
    write: (chunk: string) => void | Promise<void>,
    options: FollowLogsOptions = {},
  ): Promise<number> {
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new RangeError('Log follow poll interval must be a positive integer');
    }
    const previous = new Map<string, { stdout: string; stderr: string }>();
    const cursors = new Map<string, LogStreamCursors>();
    while (!options.signal?.aborted) {
      let envelope: JsonEnvelope<unknown>;
      try {
        envelope = await this.request('logs', {
          ...args,
          follow: false,
          ...(cursors.size === 0 ? {} : { cursors: Object.fromEntries(cursors) }),
        }, options.signal === undefined ? {} : { signal: options.signal });
      } catch (error) {
        if (this.#closed || options.signal?.aborted) return 0;
        throw error;
      }
      if (!envelope.ok) throw new Error('Daemon log request failed');
      const current = parseLogSnapshot(envelope.data);
      if (current === null) throw new Error('Daemon returned an invalid log response');
      const currentKeys = new Set<string>();
      for (const entry of current) {
        currentKeys.add(entry.key);
        const before = previous.get(entry.key) ?? { stdout: '', stderr: '' };
        if (entry.cursors !== undefined) {
          if (entry.stdout.length > 0) await write(entry.stdout);
          if (entry.stderr.length > 0) await write(entry.stderr);
          cursors.set(entry.key, entry.cursors);
        } else {
          if (entry.stdout !== before.stdout) {
            await write(entry.stdout.startsWith(before.stdout) ? entry.stdout.slice(before.stdout.length) : entry.stdout);
          }
          if (entry.stderr !== before.stderr) {
            await write(entry.stderr.startsWith(before.stderr) ? entry.stderr.slice(before.stderr.length) : entry.stderr);
          }
        }
        previous.set(entry.key, { stdout: entry.stdout, stderr: entry.stderr });
      }
      for (const key of previous.keys()) {
        if (currentKeys.has(key)) continue;
        previous.delete(key);
        cursors.delete(key);
      }
      if (options.signal?.aborted) break;
      await abortableDelay(pollIntervalMs, options.signal);
    }
    return 0;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#failAll(new Error('Daemon client is closed'));
    this.#timedOutRequestTombstones.clear();
    try {
      await this.#starting;
    } catch {
      // Connection failure already rejected startup and pending requests.
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket === null || socket.closed) return;
    // The handle is released either way; this wait only exists so a caller that closes the client
    // before touching the address knows the transport let go of it. A transport that never reports
    // the close it was asked for must not be able to hold the process open for it.
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        socket.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, this.#transportTimeoutMs);
      timer.unref();
      socket.once('close', done);
      socket.destroy();
    });
  }

  async #connect(): Promise<void> {
    const socket = this.#openSocket(this.#socketPath);
    const decoder = new FrameDecoder({ maxFrameBytes: this.#maxFrameBytes });
    this.#socket = socket;
    socket.on('data', (chunk) => this.#receive(decoder, typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    socket.on('error', () => {
      if (this.#socket === socket) this.#failAll(null);
    });
    socket.once('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#timedOutRequestTombstones.clear();
      this.#failAll(this.#closed ? new Error('Daemon client is closed') : null);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const settle = (error: Error | null): void => {
          clearTimeout(timer);
          socket.off('connect', onConnect);
          socket.off('error', onStartupError);
          socket.off('close', onStartupClose);
          if (error === null) resolve();
          else reject(error);
        };
        const onConnect = (): void => settle(null);
        const onStartupError = (): void => settle(new Error('Daemon connection failed'));
        // A peer that closes the connection instead of refusing it emits no `error` at all. Without
        // this listener that outcome settles nothing and startup waits for an event already spent.
        const onStartupClose = (): void => settle(new Error('Daemon connection closed'));
        // And a transport can report none of the three: a named pipe whose peer instance is wedged
        // accepts the connect and then goes silent. Startup is the client's own deadline to keep.
        const timer = setTimeout(
          () => settle(new Error('Daemon connection timed out')),
          this.#transportTimeoutMs,
        );
        timer.unref();
        socket.once('connect', onConnect);
        socket.once('error', onStartupError);
        socket.once('close', onStartupClose);
      });
    } catch (error) {
      if (this.#socket === socket) this.#socket = null;
      socket.destroy();
      throw error;
    }
  }

  #receive(decoder: FrameDecoder, chunk: Buffer): void {
    let frames: Buffer[];
    try {
      frames = decoder.push(chunk);
    } catch {
      this.#protocolFailure();
      return;
    }
    for (const frame of frames) {
      try {
        const response = ipcResponseSchema.parse(JSON.parse(frame.toString('utf8')));
        if (!isProtocolVersionCompatible(response.protocol)) throw new Error('incompatible protocol');
        const pending = this.#pending.get(response.id);
        if (pending === undefined) {
          if (this.#timedOutRequestTombstones.delete(response.id)) continue;
          throw new Error('uncorrelated response');
        }
        this.#pending.delete(response.id);
        clearTimeout(pending.timer);
        if (pending.signal !== undefined && pending.onAbort !== undefined) {
          pending.signal.removeEventListener('abort', pending.onAbort);
        }
        pending.resolve(response.envelope as JsonEnvelope<unknown>);
      } catch {
        this.#protocolFailure();
        return;
      }
    }
  }

  #protocolFailure(): void {
    this.#failAll(new Error('Daemon returned an invalid IPC response'));
    this.#timedOutRequestTombstones.clear();
    const socket = this.#socket;
    this.#socket = null;
    socket?.destroy();
  }

  #rejectPending(id: string, error: Error): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.reject(error);
  }

  #rememberTimedOutRequest(id: string): void {
    this.#timedOutRequestTombstones.add(id);
    if (this.#timedOutRequestTombstones.size <= DaemonClient.#maxTimedOutRequestTombstones) return;
    const oldest = this.#timedOutRequestTombstones.values().next().value;
    if (oldest !== undefined) this.#timedOutRequestTombstones.delete(oldest);
  }

  /** `null` is a lost connection: each request already sent is told which one it was. */
  #failAll(error: Error | null): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      if (request.signal !== undefined && request.onAbort !== undefined) {
        request.signal.removeEventListener('abort', request.onAbort);
      }
      request.reject(error ?? new DaemonConnectionLostError(request.command));
    }
  }
}

interface LogCursor { dev: number; ino: number; offset: number; rotated?: boolean; generation?: string }
interface LogStreamCursors { stdout?: LogCursor; stderr?: LogCursor }
interface LogSnapshotEntry { key: string; stdout: string; stderr: string; cursors?: LogStreamCursors }

function parseLogSnapshot(data: unknown): LogSnapshotEntry[] | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('logs' in data)) return null;
  const logs = data.logs;
  if (!Array.isArray(logs)) return null;
  const entries: LogSnapshotEntry[] = [];
  for (const [index, log] of logs.entries()) {
    if (typeof log !== 'object' || log === null || Array.isArray(log)) return null;
    if (!('stdout' in log) || typeof log.stdout !== 'string') return null;
    if (!('stderr' in log) || typeof log.stderr !== 'string') return null;
    const processId = 'processId' in log && typeof log.processId === 'string' ? log.processId : undefined;
    const taskName = 'taskName' in log && typeof log.taskName === 'string' ? log.taskName : undefined;
    let cursors: LogStreamCursors | undefined;
    if ('cursors' in log) {
      const parsedCursors = parseLogCursors(log.cursors);
      if (parsedCursors === null) return null;
      cursors = parsedCursors;
    }
    entries.push({
      key: processId ?? `${taskName ?? 'log'}\0${index}`,
      stdout: log.stdout,
      stderr: log.stderr,
      ...(cursors === undefined ? {} : { cursors }),
    });
  }
  return entries;
}

function parseLogCursors(value: unknown): LogStreamCursors | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const parsed: LogStreamCursors = {};
  for (const stream of ['stdout', 'stderr'] as const) {
    if (!(stream in object) || object[stream] === undefined) continue;
    const cursor = object[stream];
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return null;
    if (!('dev' in cursor) || !Number.isSafeInteger(cursor.dev) || Number(cursor.dev) < 0) return null;
    if (!('ino' in cursor) || !Number.isSafeInteger(cursor.ino) || Number(cursor.ino) < 0) return null;
    if (!('offset' in cursor) || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0) return null;
    if ('rotated' in cursor && typeof cursor.rotated !== 'boolean') return null;
    if ('generation' in cursor && typeof cursor.generation !== 'string') return null;
    parsed[stream] = {
      dev: Number(cursor.dev),
      ino: Number(cursor.ino),
      offset: Number(cursor.offset),
      ...('rotated' in cursor ? { rotated: cursor.rotated as boolean } : {}),
      ...('generation' in cursor ? { generation: cursor.generation as string } : {}),
    };
  }
  return parsed;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

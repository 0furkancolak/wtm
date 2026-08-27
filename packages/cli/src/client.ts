import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import {
  FrameDecoder,
  defaultMaxIpcFrameBytes,
  encodeFrame,
  ipcResponseSchema,
  isProtocolVersionCompatible,
  protocolVersion,
  type IpcRequest,
  type JsonEnvelope,
} from '@wtm/protocol';

export interface DaemonClientOptions {
  socketPath: string;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
}

export interface FollowLogsOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

interface PendingRequest {
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
  readonly #maxFrameBytes: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #timedOutRequestTombstones = new Set<string>();
  #socket: Socket | null = null;
  #starting: Promise<void> | null = null;
  #closed = false;

  constructor(options: DaemonClientOptions) {
    this.#socketPath = options.socketPath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? defaultMaxIpcFrameBytes;
    if (!Number.isInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new RangeError('Daemon request timeout must be a positive integer');
    }
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Daemon client is closed'));
    if (this.#socket !== null && !this.#socket.destroyed) return Promise.resolve();
    if (this.#socket?.destroyed) this.#socket = null;
    if (this.#starting !== null) return this.#starting;
    this.#starting = this.#connect().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  request(command: string, args?: unknown, options: { signal?: AbortSignal } = {}): Promise<JsonEnvelope<unknown>> {
    const socket = this.#socket;
    if (this.#closed || socket === null || socket.destroyed) {
      return Promise.reject(new Error('Daemon client is not connected'));
    }
    if (options.signal?.aborted) return Promise.reject(new Error(`Daemon request aborted: ${command}`));
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
        reject(new Error(`Daemon request timed out: ${command}`));
      }, this.#requestTimeoutMs);
      timer.unref();
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.#rememberTimedOutRequest(id);
        reject(new Error(`Daemon request aborted: ${command}`));
      };
      this.#pending.set(id, {
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
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }

  async #connect(): Promise<void> {
    const socket = createConnection(this.#socketPath);
    const decoder = new FrameDecoder({ maxFrameBytes: this.#maxFrameBytes });
    this.#socket = socket;
    socket.on('data', (chunk) => this.#receive(decoder, typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    socket.on('error', () => {
      if (this.#socket === socket) this.#failAll(new Error('Daemon connection failed'));
    });
    socket.once('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#timedOutRequestTombstones.clear();
      this.#failAll(new Error(this.#closed ? 'Daemon client is closed' : 'Daemon connection closed'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off('error', onStartupError);
          resolve();
        };
        const onStartupError = () => {
          socket.off('connect', onConnect);
          reject(new Error('Daemon connection failed'));
        };
        socket.once('connect', onConnect);
        socket.once('error', onStartupError);
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

  #failAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      if (request.signal !== undefined && request.onAbort !== undefined) {
        request.signal.removeEventListener('abort', request.onAbort);
      }
      request.reject(error);
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

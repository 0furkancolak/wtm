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

interface PendingRequest {
  resolve: (envelope: JsonEnvelope<unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

  request(command: string, args?: unknown): Promise<JsonEnvelope<unknown>> {
    const socket = this.#socket;
    if (this.#closed || socket === null || socket.destroyed) {
      return Promise.reject(new Error('Daemon client is not connected'));
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
        this.#pending.delete(id);
        this.#rememberTimedOutRequest(id);
        reject(new Error(`Daemon request timed out: ${command}`));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      socket.write(frame, (error) => {
        if (error === null || error === undefined) return;
        this.#rejectPending(id, new Error('Daemon request could not be written'));
      });
    });
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
      request.reject(error);
    }
  }
}

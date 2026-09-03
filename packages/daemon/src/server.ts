import { createServer, type Server, type Socket } from 'node:net';
import {
  selectPlatformRuntime,
  type IpcServerPublisher,
  type PublishedIpcServer,
  type PublishOptions,
} from '@wtm/platform';
import { assertDaemonSocketPathFits } from '@wtm/platform/socket';
import {
  FrameDecoder,
  FrameSizeError,
  defaultMaxIpcFrameBytes,
  encodeFrame,
  ipcRequestSchema,
  ipcResponseSchema,
  jsonEnvelopeSchema,
  protocolVersion,
  type IpcRequest,
  type IpcResponse,
  type JsonEnvelope,
  type WtmErrorCode,
} from '@wtm/protocol';

export type IpcRequestHandler = (
  request: IpcRequest,
) => JsonEnvelope<unknown> | Promise<JsonEnvelope<unknown>>;

export interface UnixIpcServerOptions {
  socketPath: string;
  handler: IpcRequestHandler;
  /**
   * `sizeof(sun_path)` for the machine this server binds on. Defaults to the platform seam's
   * answer for this host, which is the right default here and nowhere else: unlike every other
   * path decision in WTM, this one is enforced by the kernel the `listen` actually runs against,
   * so a runtime injected for a *different* platform must not weaken or tighten it.
   */
  socketPathLimitBytes?: number;
  maxFrameBytes?: number;
  maxConnections?: number;
  maxInFlightPerConnection?: number;
  maxPendingOutputBytes?: number;
  partialFrameIdleTimeoutMs?: number;
  /** Test seam for verifying that requests remain paused until permissions are secured. */
  beforeSocketChmod?: () => Promise<void> | void;
  /** Test seam for deterministic stale-socket race coverage. */
  probeExistingSocket?: (path: string) => Promise<boolean>;
  /** @deprecated Use beforeStaleSocketQuarantine. */
  beforeStaleSocketUnlink?: () => Promise<void> | void;
  /** Test seam invoked immediately before stale-socket quarantine. */
  beforeStaleSocketQuarantine?: () => Promise<void> | void;
  /** Test seam invoked after chmod and before final socket/parent verification. */
  afterSocketChmod?: (path: string) => Promise<void> | void;
  /** Test seam invoked immediately before owned-socket quarantine. */
  beforeOwnedSocketQuarantine?: () => Promise<void> | void;
  /** Test seam invoked after the private bind path occupant is quarantined during close. */
  afterPrivateSocketQuarantine?: () => Promise<void> | void;
}

interface ConnectionState {
  decoder: FrameDecoder;
  inFlight: number;
  partialTimer: ReturnType<typeof setTimeout> | null;
  outputQueue: Buffer[];
  pendingOutputBytes: number;
  backpressured: boolean;
}

interface PreReadyInput {
  chunks: Buffer[];
  bytes: number;
  listener: (chunk: Buffer | string) => void;
}

/**
 * The host's socket address limit, resolved once and only if something actually binds.
 *
 * This used to be the macOS constant, imported by name, which was correct only for as long as the
 * daemon refused to start anywhere else. It is resolved lazily rather than at import because the
 * refusal for an unsupported platform belongs to `assertSupportedRuntime`, where a caller can
 * catch it and report it as an envelope — throwing it out of a module's top level instead would
 * turn a coded error into an import failure.
 */
let hostLimitBytes: number | null = null;

function hostSocketPathLimitBytes(): number {
  hostLimitBytes ??= selectPlatformRuntime().socket.limitBytes;
  return hostLimitBytes;
}

/**
 * Which publish protocol actually runs — the moved hardlink/chmod/uid dance on darwin and linux,
 * a plain `listen()` on win32 (spec `2026-09-03-windows-trust-and-transport-seam.md`, D7). Resolved
 * lazily for the same reason `hostSocketPathLimitBytes` is: an unsupported platform's refusal
 * belongs to `assertSupportedRuntime`, not to this module's top level.
 */
let hostPublisher: IpcServerPublisher | null = null;

function hostIpcPublisher(): IpcServerPublisher {
  hostPublisher ??= selectPlatformRuntime().ipc;
  return hostPublisher;
}

export class UnixIpcServer {
  readonly #socketPath: string;
  readonly #handler: IpcRequestHandler;
  readonly #maxFrameBytes: number;
  readonly #maxConnections: number;
  readonly #maxInFlightPerConnection: number;
  readonly #maxPendingOutputBytes: number;
  readonly #partialFrameIdleTimeoutMs: number;
  readonly #publisher: IpcServerPublisher;
  readonly #publishOptions: PublishOptions;
  readonly #sockets = new Set<Socket>();
  readonly #preReadySockets = new Set<Socket>();
  readonly #preReadyInput = new Map<Socket, PreReadyInput>();
  #server: Server | null = null;
  #published: PublishedIpcServer | null = null;
  #starting: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  readonly #socketPathLimitBytes: number | null;
  #state: 'idle' | 'starting' | 'started' | 'closing' | 'closed' = 'idle';
  #ready = false;

  constructor(options: UnixIpcServerOptions) {
    this.#socketPath = options.socketPath;
    this.#handler = options.handler;
    this.#socketPathLimitBytes = options.socketPathLimitBytes ?? null;
    this.#maxFrameBytes = options.maxFrameBytes ?? defaultMaxIpcFrameBytes;
    this.#maxConnections = positiveInteger(options.maxConnections ?? 64, 'Maximum IPC connections');
    this.#maxInFlightPerConnection = positiveInteger(
      options.maxInFlightPerConnection ?? 16,
      'Maximum in-flight IPC requests',
    );
    this.#maxPendingOutputBytes = positiveInteger(
      options.maxPendingOutputBytes ?? 4 * defaultMaxIpcFrameBytes,
      'Maximum pending IPC output bytes',
    );
    this.#partialFrameIdleTimeoutMs = positiveInteger(
      options.partialFrameIdleTimeoutMs ?? 5_000,
      'Partial IPC frame idle timeout',
    );
    this.#publisher = hostIpcPublisher();
    this.#publishOptions = {
      probeExistingSocket: options.probeExistingSocket,
      beforeStaleSocketQuarantine: options.beforeStaleSocketQuarantine ?? options.beforeStaleSocketUnlink,
      beforeSocketChmod: options.beforeSocketChmod,
      afterSocketChmod: options.afterSocketChmod,
      beforeOwnedSocketQuarantine: options.beforeOwnedSocketQuarantine,
      afterPrivateSocketQuarantine: options.afterPrivateSocketQuarantine,
    };
  }

  start(): Promise<void> {
    if (this.#state === 'closing' || this.#state === 'closed') {
      return Promise.reject(new Error('Unix IPC server is closed'));
    }
    if (this.#state === 'started') return Promise.resolve();
    if (this.#starting !== null) return this.#starting;
    this.#state = 'starting';
    this.#starting = this.#start().then(() => {
      if (this.#state === 'starting') this.#state = 'started';
    }).catch((error: unknown) => {
      if (this.#state === 'starting') this.#state = 'idle';
      throw error;
    }).finally(() => { this.#starting = null; });
    return this.#starting;
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#state === 'closed') return Promise.resolve();
    this.#state = 'closing';
    this.#closePromise = this.#close().finally(() => {
      this.#state = 'closed';
      this.#closePromise = null;
    });
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    try { await this.#starting; } catch { /* Startup performs its own cleanup. */ }
    let failure: unknown;
    for (const cleanup of [
      () => this.#closeListeningServer(),
      () => this.#unpublish(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async #start(): Promise<void> {
    // Before anything is created or bound. A path that cannot fit in a socket address fails at
    // `listen` with a bare `EINVAL` that names neither the limit nor the path, and by then the
    // publisher may already have quarantined a stale occupant -- work undone for a failure that
    // was knowable up front.
    assertDaemonSocketPathFits(this.#socketPath, this.#socketPathLimitBytes ?? hostSocketPathLimitBytes());
    const server = createServer((socket) => this.#acceptOrPause(socket));
    let published: PublishedIpcServer;
    try {
      published = await this.#publisher.publish(server, this.#socketPath, this.#publishOptions);
    } catch (error) {
      for (const socket of this.#sockets) socket.destroy();
      this.#sockets.clear();
      this.#preReadySockets.clear();
      this.#preReadyInput.clear();
      throw error;
    }
    if (this.#state === 'closing') {
      try { await published.unpublish(); } catch { /* Preserve the startup failure. */ }
      for (const socket of this.#sockets) socket.destroy();
      this.#sockets.clear();
      this.#preReadySockets.clear();
      this.#preReadyInput.clear();
      throw new Error('Unix IPC server closed during startup');
    }
    this.#published = published;
    this.#server = server;
    this.#ready = true;
    for (const socket of this.#preReadySockets) {
      this.#preReadySockets.delete(socket);
      if (!socket.destroyed) {
        const input = this.#preReadyInput.get(socket);
        if (input !== undefined) socket.off('data', input.listener);
        this.#preReadyInput.delete(socket);
        this.#activate(socket, input?.chunks ?? []);
      }
    }
  }

  #acceptOrPause(socket: Socket): void {
    if (this.#sockets.size >= this.#maxConnections || this.#state === 'closing' || this.#state === 'closed') {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.once('close', () => {
      this.#sockets.delete(socket);
      this.#preReadySockets.delete(socket);
      this.#preReadyInput.delete(socket);
    });
    socket.on('error', () => { /* Connection-local failures are contained. */ });
    if (!this.#ready) {
      this.#preReadySockets.add(socket);
      const input: PreReadyInput = {
        chunks: [],
        bytes: 0,
        listener: (chunk) => {
          const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          input.bytes += value.byteLength;
          if (input.bytes > this.#maxFrameBytes + 4) {
            socket.destroy();
            return;
          }
          input.chunks.push(value);
        },
      };
      this.#preReadyInput.set(socket, input);
      socket.on('data', input.listener);
      return;
    }
    this.#activate(socket);
  }

  #activate(socket: Socket, initialChunks: readonly Buffer[] = []): void {
    const decoder = new FrameDecoder({ maxFrameBytes: this.#maxFrameBytes });
    const state: ConnectionState = {
      decoder,
      inFlight: 0,
      partialTimer: null,
      outputQueue: [],
      pendingOutputBytes: 0,
      backpressured: false,
    };
    socket.once('close', () => {
      if (state.partialTimer !== null) clearTimeout(state.partialTimer);
      state.partialTimer = null;
      state.outputQueue.length = 0;
      state.pendingOutputBytes = 0;
    });
    socket.on('drain', () => {
      state.backpressured = false;
      this.#flushOutput(socket, state);
    });
    const receive = (chunk: Buffer | string) => {
      let frames: Buffer[];
      try {
        frames = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      } catch (error) {
        const message = error instanceof FrameSizeError
          ? 'IPC request frame exceeds the configured size limit.'
          : 'IPC request framing is invalid.';
        this.#writeResponse(socket, state, failureResponse(
          'invalid-request',
          'ipc',
          'WTM_DAEMON_INVALID_REQUEST',
          message,
        ));
        socket.end();
        return;
      }
      this.#updatePartialFrameTimer(socket, state);
      for (const frame of frames) {
        if (state.inFlight >= this.#maxInFlightPerConnection) {
          socket.destroy();
          return;
        }
        state.inFlight += 1;
        void this.#handleFrame(socket, state, frame).finally(() => { state.inFlight -= 1; });
      }
    };
    socket.on('data', receive);
    for (const chunk of initialChunks) {
      if (socket.destroyed) break;
      receive(chunk);
    }
  }

  async #handleFrame(socket: Socket, state: ConnectionState, frame: Buffer): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(frame.toString('utf8')) as unknown;
    } catch {
      this.#writeResponse(socket, state, failureResponse(
        'invalid-request',
        'ipc',
        'WTM_DAEMON_INVALID_REQUEST',
        'IPC request contains malformed JSON.',
      ));
      return;
    }

    const id = correlationId(raw);
    const command = commandName(raw);
    const version = looseProtocolVersion(raw);
    if (
      version !== null
      && (version.major !== protocolVersion.major || version.minor !== protocolVersion.minor)
    ) {
      this.#writeResponse(socket, state, failureResponse(
        id,
        command,
        'WTM_DAEMON_PROTOCOL_INCOMPATIBLE',
        'IPC protocol version is incompatible with this daemon.',
      ));
      return;
    }

    const parsed = ipcRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.#writeResponse(socket, state, failureResponse(
        id,
        command,
        'WTM_DAEMON_INVALID_REQUEST',
        'IPC request does not match the required schema.',
      ));
      return;
    }

    let envelope: JsonEnvelope<unknown>;
    try {
      const handled = await this.#handler(parsed.data);
      const validated = jsonEnvelopeSchema.safeParse(handled);
      if (!validated.success) throw new Error('handler returned an invalid envelope');
      envelope = handled;
    } catch {
      envelope = failureEnvelope(
        parsed.data.command,
        'WTM_DAEMON_REQUEST_FAILED',
        'The daemon could not complete the request.',
      );
    }
    this.#writeResponse(socket, state, {
      protocol: protocolVersion,
      id: parsed.data.id,
      envelope,
    });
  }

  #writeResponse(socket: Socket, state: ConnectionState, response: IpcResponse): void {
    if (socket.destroyed || !socket.writable) return;
    const validated = ipcResponseSchema.parse(response);
    const payload = Buffer.from(JSON.stringify(validated));
    try {
      const frame = encodeFrame(payload, this.#maxFrameBytes);
      if (state.pendingOutputBytes + frame.byteLength > this.#maxPendingOutputBytes) {
        socket.destroy();
        return;
      }
      state.pendingOutputBytes += frame.byteLength;
      state.outputQueue.push(frame);
      this.#flushOutput(socket, state);
    } catch {
      socket.destroy();
    }
  }

  #flushOutput(socket: Socket, state: ConnectionState): void {
    while (!state.backpressured && state.outputQueue.length > 0 && !socket.destroyed && socket.writable) {
      const frame = state.outputQueue.shift();
      if (frame === undefined) return;
      try {
        const accepted = socket.write(frame, () => {
          state.pendingOutputBytes = Math.max(0, state.pendingOutputBytes - frame.byteLength);
        });
        if (!accepted) state.backpressured = true;
      } catch {
        socket.destroy();
      }
    }
  }

  #updatePartialFrameTimer(socket: Socket, state: ConnectionState): void {
    if (state.partialTimer !== null) clearTimeout(state.partialTimer);
    state.partialTimer = null;
    if (!state.decoder.hasPartialFrame) return;
    state.partialTimer = setTimeout(() => socket.destroy(), this.#partialFrameIdleTimeoutMs);
    state.partialTimer.unref();
  }

  #closeListeningServer(): void {
    this.#ready = false;
    this.#server = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#preReadySockets.clear();
    this.#preReadyInput.clear();
  }

  async #unpublish(): Promise<void> {
    const published = this.#published;
    this.#published = null;
    if (published === null) return;
    await published.unpublish();
  }
}

function failureResponse(
  id: string,
  command: string,
  code: WtmErrorCode,
  message: string,
): IpcResponse {
  return {
    protocol: protocolVersion,
    id,
    envelope: failureEnvelope(command, code, message),
  };
}

function failureEnvelope(command: string, code: WtmErrorCode, message: string): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    data: null,
    warnings: [],
    errors: [{ code, message, severity: 'error' }],
  };
}

function correlationId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('id' in value)) return 'invalid-request';
  const id = value.id;
  return typeof id === 'string' && id.length > 0 ? id : 'invalid-request';
}

function commandName(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('command' in value)) return 'ipc';
  const command = value.command;
  return typeof command === 'string' && command.length > 0 ? command : 'ipc';
}

function looseProtocolVersion(value: unknown): { major: number; minor: number } | null {
  if (typeof value !== 'object' || value === null || !('protocol' in value)) return null;
  const protocol = value.protocol;
  if (typeof protocol !== 'object' || protocol === null || !('major' in protocol) || !('minor' in protocol)) {
    return null;
  }
  if (!Number.isInteger(protocol.major) || !Number.isInteger(protocol.minor) || Number(protocol.minor) < 0) {
    return null;
  }
  return { major: Number(protocol.major), minor: Number(protocol.minor) };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

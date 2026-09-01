import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { selectPlatformRuntime } from '@wtm/platform';
import { assertDaemonSocketPathFits, boundDaemonSocketPath } from '@wtm/platform/socket';
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

interface SocketIdentity {
  dev: number;
  ino: number;
  uid: number;
}

interface DirectoryIdentity extends SocketIdentity {
  uid: number;
}

interface QuarantinedPath {
  path: string;
  identity: SocketIdentity;
  changedDuringQuarantine: boolean;
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

export class UnixIpcServer {
  readonly #socketPath: string;
  readonly #handler: IpcRequestHandler;
  readonly #maxFrameBytes: number;
  readonly #maxConnections: number;
  readonly #maxInFlightPerConnection: number;
  readonly #maxPendingOutputBytes: number;
  readonly #partialFrameIdleTimeoutMs: number;
  readonly #beforeSocketChmod: () => Promise<void> | void;
  readonly #probeExistingSocket: (path: string) => Promise<boolean>;
  readonly #beforeStaleSocketQuarantine: () => Promise<void> | void;
  readonly #afterSocketChmod: (path: string) => Promise<void> | void;
  readonly #beforeOwnedSocketQuarantine: () => Promise<void> | void;
  readonly #afterPrivateSocketQuarantine: () => Promise<void> | void;
  readonly #sockets = new Set<Socket>();
  readonly #preReadySockets = new Set<Socket>();
  readonly #preReadyInput = new Map<Socket, PreReadyInput>();
  #server: Server | null = null;
  #ownedSocket: SocketIdentity | null = null;
  #boundSocket: SocketIdentity | null = null;
  #boundSocketPath: string | null = null;
  #rememberedBoundSocketPath: string | null = null;
  #socketParent: DirectoryIdentity | null = null;
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
    this.#beforeSocketChmod = options.beforeSocketChmod ?? (() => {});
    this.#probeExistingSocket = options.probeExistingSocket ?? socketAcceptsConnections;
    this.#beforeStaleSocketQuarantine = options.beforeStaleSocketQuarantine
      ?? options.beforeStaleSocketUnlink
      ?? (() => {});
    this.#afterSocketChmod = options.afterSocketChmod ?? (() => {});
    this.#beforeOwnedSocketQuarantine = options.beforeOwnedSocketQuarantine ?? (() => {});
    this.#afterPrivateSocketQuarantine = options.afterPrivateSocketQuarantine ?? (() => {});
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
      () => this.#unlinkBoundSocket(),
      () => this.#unlinkOwnedSocket(),
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
    // Before anything is created, quarantined or bound. A path that cannot fit in a socket
    // address fails at `listen` with a bare `EINVAL` that names neither the limit nor the
    // path, and by then the parent directory has already been secured and a stale socket may
    // already have been displaced -- work undone for a failure that was knowable up front.
    assertDaemonSocketPathFits(this.#socketPath, this.#socketPathLimitBytes ?? hostSocketPathLimitBytes());
    const parent = await secureSocketParent(dirname(this.#socketPath));
    await prepareSocketPath(this.#socketPath, parent, {
      probe: this.#probeExistingSocket,
      beforeQuarantine: this.#beforeStaleSocketQuarantine,
    });
    const boundPath = boundDaemonSocketPath(this.#socketPath);
    await prepareSocketPath(boundPath, parent, {
      probe: socketAcceptsConnections,
      beforeQuarantine: () => {},
    });
    const server = createServer((socket) => this.#acceptOrPause(socket));
    try {
      await listen(server, boundPath);
      this.#rememberedBoundSocketPath = boundPath;
      this.#socketParent = parent;
      const stat = await lstat(boundPath);
      const currentUid = process.getuid?.();
      if (!stat.isSocket() || currentUid === undefined || stat.uid !== currentUid) {
        throw new Error('Created IPC path is not a current-user Unix socket');
      }
      const identity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
      this.#boundSocket = identity;
      this.#boundSocketPath = boundPath;
      await link(boundPath, this.#socketPath);
      const published = await lstat(this.#socketPath);
      if (!matchesSocketIdentity(published, identity)) {
        throw new Error('Published IPC socket does not match the bound socket');
      }
      const linkedPrivate = await lstat(boundPath);
      if (!matchesSocketIdentity(linkedPrivate, identity)) {
        throw new Error('Private IPC socket changed during publication');
      }
      this.#ownedSocket = identity;
      const publishedMode = published.mode & 0o777;
      await this.#unlinkBoundSocket();
      const privateRemoved = await lstat(this.#socketPath);
      if (
        !matchesSocketIdentity(privateRemoved, identity)
        || (privateRemoved.mode & 0o777) !== publishedMode
      ) {
        throw new Error('Published IPC socket changed while removing the private bind entry');
      }
      await this.#beforeSocketChmod();
      const beforeChmod = await lstat(this.#socketPath);
      if (!matchesSocketIdentity(beforeChmod, identity)) {
        throw new Error('IPC socket changed before permissions were secured');
      }
      await chmod(this.#socketPath, 0o600);
      await this.#afterSocketChmod(this.#socketPath);
      await assertDirectoryIdentity(
        dirname(this.#socketPath),
        parent,
        'IPC socket parent changed after permissions were secured',
      );
      const secured = await lstat(this.#socketPath);
      if (!matchesSocketIdentity(secured, identity) || (secured.mode & 0o777) !== 0o600) {
        throw new Error('IPC socket changed after permissions were secured');
      }
      if (this.#state === 'closing') throw new Error('Unix IPC server closed during startup');
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
    } catch (error) {
      if (this.#server === server) this.#server = null;
      this.#ready = false;
      for (const socket of this.#sockets) socket.destroy();
      this.#sockets.clear();
      this.#preReadySockets.clear();
      this.#preReadyInput.clear();
      if (server.listening) {
        try { await this.#closeServerWithPrivatePathShield(server); } catch { /* Preserve the startup failure. */ }
      }
      try { await this.#unlinkBoundSocket(); } catch { /* Preserve the startup failure. */ }
      try { await this.#unlinkOwnedSocket(); } catch { /* Preserve the startup failure. */ }
      throw error;
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

  async #closeListeningServer(): Promise<void> {
    this.#ready = false;
    const server = this.#server;
    this.#server = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#preReadySockets.clear();
    this.#preReadyInput.clear();
    if (server !== null && server.listening) {
      try {
        await this.#closeServerWithPrivatePathShield(server);
      } finally {
        if (!server.listening) this.#server = null;
      }
    }
  }

  async #closeServerWithPrivatePathShield(server: Server): Promise<void> {
    const path = this.#rememberedBoundSocketPath;
    const parent = this.#socketParent;
    if (path === null || parent === null) {
      await closeServer(server);
      return;
    }

    let failure: unknown;
    let original: QuarantinedPath | null = null;
    let installed: Awaited<ReturnType<typeof installClosePlaceholder>> | null = null;
    try {
      original = await quarantinePathIfExists(path, parent);
      if (original?.changedDuringQuarantine === true) {
        failure = new Error('IPC private socket close shield observed a quarantine race');
      }
    } catch (error) {
      failure ??= error;
    }

    try {
      await this.#afterPrivateSocketQuarantine();
    } catch (error) {
      failure ??= error;
    }

    try {
      installed = await installClosePlaceholder(path, parent);
      if (installed.quarantinedRaces.length > 0) {
        failure ??= new Error('IPC private socket close shield retained a raced occupant');
      }
    } catch (error) {
      failure ??= error;
    }

    const closeCompletion = closeServer(server);
    try {
      await closeCompletion;
    } catch (error) {
      failure ??= error;
    } finally {
      this.#rememberedBoundSocketPath = null;
    }

    try {
      await assertDirectoryIdentity(
        dirname(path),
        parent,
        `IPC socket parent changed after private socket close shield: ${path}`,
      );
      const survivor = await quarantinePathIfExists(path, parent);
      if (survivor !== null) {
        if (installed !== null && matchesPathIdentity(survivor.identity, installed.placeholder)) {
          try {
            await unlinkVerifiedQuarantine(survivor, parent);
          } catch (error) {
            failure ??= error;
          }
          failure ??= new Error('IPC private socket close shield placeholder survived server close');
        } else {
          failure ??= new Error('IPC private socket close shield retained a post-close occupant');
        }
      }
    } catch (error) {
      failure ??= error;
    }

    if (original !== null) {
      try {
        const restored = await restoreQuarantinedPathWithoutOverwrite(original, path, parent);
        if (!restored) {
          failure ??= new Error('IPC private socket close shield could not restore its quarantined occupant');
        }
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure !== undefined) throw failure;
  }

  async #unlinkOwnedSocket(): Promise<void> {
    const owned = this.#ownedSocket;
    const parent = this.#socketParent;
    this.#ownedSocket = null;
    this.#socketParent = null;
    if (owned === null || parent === null) return;
    await quarantineAndUnlink(this.#socketPath, parent, owned, {
      beforeQuarantine: this.#beforeOwnedSocketQuarantine,
      mismatchMessage: 'IPC socket changed while quarantining owned socket',
    });
  }

  async #unlinkBoundSocket(): Promise<void> {
    const path = this.#boundSocketPath;
    const owned = this.#boundSocket;
    const parent = this.#socketParent;
    this.#boundSocketPath = null;
    this.#boundSocket = null;
    if (path === null || owned === null || parent === null) return;
    await quarantineAndUnlink(path, parent, owned, {
      mismatchMessage: 'Bound IPC socket changed during cleanup',
    });
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

async function secureSocketParent(path: string): Promise<DirectoryIdentity> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const initial = await lstat(path);
  const currentUid = process.getuid?.();
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error(`IPC socket parent is not a directory: ${path}`);
  }
  if (currentUid === undefined || initial.uid !== currentUid) {
    throw new Error(`IPC socket parent is not owned by the current user: ${path}`);
  }
  await chmod(path, 0o700);
  const secured = await lstat(path);
  if (
    !secured.isDirectory()
    || secured.isSymbolicLink()
    || secured.uid !== initial.uid
    || secured.dev !== initial.dev
    || secured.ino !== initial.ino
    || (secured.mode & 0o777) !== 0o700
  ) {
    throw new Error(`IPC socket parent changed while securing permissions: ${path}`);
  }
  return { dev: secured.dev, ino: secured.ino, uid: secured.uid };
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  message: string,
): Promise<void> {
  const current = await lstat(path);
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || current.uid !== expected.uid
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || (current.mode & 0o777) !== 0o700
  ) {
    throw new Error(message);
  }
}

async function prepareSocketPath(
  path: string,
  parent: DirectoryIdentity,
  hooks: {
    probe: (path: string) => Promise<boolean>;
    beforeQuarantine: () => Promise<void> | void;
  },
): Promise<void> {
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    throw error;
  }
  if (!initial.isSocket()) throw new Error(`IPC path exists and is not a Unix socket: ${path}`);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || initial.uid !== currentUid) {
    throw new Error(`IPC socket is not owned by the current user: ${path}`);
  }
  if (await hooks.probe(path)) throw new Error(`IPC socket is already in use: ${path}`);
  await quarantineAndUnlink(path, parent, {
    dev: initial.dev,
    ino: initial.ino,
    uid: initial.uid,
  }, {
    beforeQuarantine: hooks.beforeQuarantine,
    mismatchMessage: `IPC socket changed while checking stale ownership: ${path}`,
  });
}

async function quarantineAndUnlink(
  path: string,
  parent: DirectoryIdentity,
  expected: SocketIdentity,
  options: {
    beforeQuarantine?: () => Promise<void> | void;
    mismatchMessage: string;
  },
): Promise<void> {
  await options.beforeQuarantine?.();
  await assertDirectoryIdentity(
    dirname(path),
    parent,
    `IPC socket parent changed while quarantining: ${path}`,
  );
  const quarantinePath = uniqueSiblingPath(path, 'q');
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    throw error;
  }

  let candidate;
  try {
    candidate = await lstat(quarantinePath);
  } catch (error) {
    await restoreQuarantinedPath(quarantinePath, path);
    throw error;
  }
  if (!matchesSocketIdentity(candidate, expected)) {
    await restoreQuarantinedPath(quarantinePath, path);
    throw new Error(options.mismatchMessage);
  }
  await unlink(quarantinePath);
}

async function restoreQuarantinedPath(quarantinePath: string, originalPath: string): Promise<void> {
  try {
    await link(quarantinePath, originalPath);
  } catch {
    // Fail closed: never overwrite a path that appeared while restoring.
    return;
  }
  try {
    await unlink(quarantinePath);
  } catch {
    // The candidate remains reachable from its restored original path.
  }
}

function matchesSocketIdentity(
  stat: Awaited<ReturnType<typeof lstat>>,
  expected: SocketIdentity,
): boolean {
  return stat.isSocket()
    && stat.uid === expected.uid
    && stat.dev === expected.dev
    && stat.ino === expected.ino;
}

function uniqueSiblingPath(path: string, marker: string): string {
  return join(dirname(path), `.${marker}${randomUUID().replaceAll('-', '')}`);
}

async function installClosePlaceholder(
  path: string,
  parent: DirectoryIdentity,
): Promise<{ placeholder: SocketIdentity; quarantinedRaces: QuarantinedPath[] }> {
  const quarantinedRaces: QuarantinedPath[] = [];
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await assertDirectoryIdentity(
      dirname(path),
      parent,
      `IPC socket parent changed while installing private socket close shield: ${path}`,
    );
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) throw error;
      const raced = await quarantinePathIfExists(path, parent);
      if (raced !== null) quarantinedRaces.push(raced);
      continue;
    }

    let placeholder: SocketIdentity;
    try {
      await handle.chmod(0o600);
      const stat = await handle.stat();
      const currentUid = process.getuid?.();
      if (
        !stat.isFile()
        || currentUid === undefined
        || stat.uid !== currentUid
        || (stat.mode & 0o777) !== 0o600
      ) {
        throw new Error('IPC private socket close shield created an invalid placeholder');
      }
      placeholder = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    } finally {
      await handle.close();
    }

    await assertDirectoryIdentity(
      dirname(path),
      parent,
      `IPC socket parent changed after installing private socket close shield: ${path}`,
    );
    let published;
    try {
      published = await lstat(path);
    } catch (error) {
      if (isFileError(error, 'ENOENT')) continue;
      throw error;
    }
    if (
      published.isFile()
      && (published.mode & 0o777) === 0o600
      && matchesPathIdentity(published, placeholder)
    ) {
      return { placeholder, quarantinedRaces };
    }
    const raced = await quarantinePathIfExists(path, parent);
    if (raced !== null) quarantinedRaces.push(raced);
  }
  throw new Error('IPC private socket close shield could not install its placeholder');
}

async function quarantinePathIfExists(
  path: string,
  parent: DirectoryIdentity,
): Promise<QuarantinedPath | null> {
  await assertDirectoryIdentity(
    dirname(path),
    parent,
    `IPC socket parent changed while applying private socket close shield: ${path}`,
  );
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return null;
    throw error;
  }
  const quarantinePath = uniqueSiblingPath(path, 'q');
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return null;
    throw error;
  }
  await assertDirectoryIdentity(
    dirname(path),
    parent,
    `IPC socket parent changed after applying private socket close shield: ${path}`,
  );
  const quarantined = await lstat(quarantinePath);
  return {
    path: quarantinePath,
    identity: { dev: quarantined.dev, ino: quarantined.ino, uid: quarantined.uid },
    changedDuringQuarantine: !matchesPathIdentity(quarantined, initial),
  };
}

async function restoreQuarantinedPathWithoutOverwrite(
  quarantined: QuarantinedPath,
  originalPath: string,
  parent: DirectoryIdentity,
): Promise<boolean> {
  await assertDirectoryIdentity(
    dirname(originalPath),
    parent,
    `IPC socket parent changed while restoring private socket close shield quarantine: ${originalPath}`,
  );
  const candidate = await lstat(quarantined.path);
  if (!matchesPathIdentity(candidate, quarantined.identity)) {
    throw new Error('IPC private socket close shield quarantine changed before restoration');
  }
  try {
    await link(quarantined.path, originalPath);
  } catch (error) {
    if (isFileError(error, 'EEXIST')) return false;
    throw error;
  }
  const restored = await lstat(originalPath);
  if (!matchesPathIdentity(restored, quarantined.identity)) {
    throw new Error('IPC private socket close shield restored an unexpected occupant');
  }
  await unlink(quarantined.path);
  return true;
}

async function unlinkVerifiedQuarantine(
  quarantined: QuarantinedPath,
  parent: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(
    dirname(quarantined.path),
    parent,
    `IPC socket parent changed while cleaning private socket close shield placeholder: ${quarantined.path}`,
  );
  const candidate = await lstat(quarantined.path);
  if (!matchesPathIdentity(candidate, quarantined.identity)) {
    throw new Error('IPC private socket close shield placeholder quarantine changed');
  }
  await unlink(quarantined.path);
}

function matchesPathIdentity(
  stat: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino' | 'uid'>,
  expected: SocketIdentity,
): boolean {
  return stat.uid === expected.uid && stat.dev === expected.dev && stat.ino === expected.ino;
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out while checking existing IPC socket: ${path}`));
    }, 250);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (isFileError(error, 'ECONNREFUSED') || isFileError(error, 'ENOENT')) resolve(false);
      else reject(error);
    });
  });
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error); });
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

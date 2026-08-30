import {
  WtmConfigError,
  WtmEndpointAllocationError,
  WtmEnvironmentError,
  WtmTaskResolutionError,
  WtmTemplateError,
  type ManagedProcessRecord,
  type ResolvedTask,
} from '@wtm/core';
import {
  defaultMaxIpcFrameBytes,
  protocolVersion,
  type IpcRequest,
  type JsonEnvelope,
  type WtmError,
  type WtmErrorCode,
} from '@wtm/protocol';
import { z } from 'zod';
import type {
  ManagedProcessSelector,
  ManagedProcessStartInput,
  ManagedProcessStartResult,
} from './process-supervisor';

/**
 * Raised when a request names a directory that no registered workspace, repository, or
 * worktree covers. It is the single most common reason a runtime command cannot proceed, so
 * it says which of the three is missing instead of reporting an unexplained daemon failure.
 */
export class DaemonRegistrationError extends Error {
  readonly code = 'WTM_WORKSPACE_NOT_FOUND' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DaemonRegistrationError';
    this.context = context;
  }
}

const maximumLogReadBytes = 1024 * 1024;
// Every raw byte can expand to six JSON bytes (for example NUL -> "\\u0000").
// Keeping the aggregate at 128 KiB leaves ample room for envelope/IPC metadata.
const maximumLogPayloadBytes = 64 * 1024;
const maximumLogTasks = 128;

const cwdSchema = z.string().min(1).max(4096);
const taskNameSchema = z.string().min(1).max(256);
const logCursorSchema = z.object({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  rotated: z.boolean().optional(),
  truncated: z.boolean().optional(),
  generation: z.string().min(1).max(32).optional(),
}).strict();
const logStreamCursorsSchema = z.object({
  stdout: logCursorSchema.optional(),
  stderr: logCursorSchema.optional(),
}).strict();
const runtimeArgumentSchemas = {
  start: z.object({ cwd: cwdSchema, taskName: taskNameSchema }).strict(),
  restart: z.object({ cwd: cwdSchema, taskName: taskNameSchema }).strict(),
  stop: z.object({ cwd: cwdSchema, taskName: taskNameSchema.optional() }).strict(),
  ps: z.object({ cwd: cwdSchema }).strict(),
  logs: z.object({
    cwd: cwdSchema,
    taskName: taskNameSchema.optional(),
    follow: z.literal(false),
    cursors: z.record(z.string().min(1).max(128), logStreamCursorsSchema).optional(),
  }).strict(),
  exec: z.object({ cwd: cwdSchema, argv: z.array(z.string().max(8192)).min(1).max(1024) }).strict(),
} as const;

export const runtimeCommandNames = new Set(['start', 'stop', 'restart', 'ps', 'logs', 'exec']);

export interface DaemonRuntimeSupervisor {
  start(input: ManagedProcessStartInput): Promise<ManagedProcessStartResult>;
  restart(input: ManagedProcessStartInput): Promise<ManagedProcessStartResult>;
  stop(selector: ManagedProcessSelector): Promise<ManagedProcessRecord>;
  stopAll(worktreeId: string): Promise<ManagedProcessRecord[]>;
  list(worktreeId?: string): ManagedProcessRecord[];
}

export interface DaemonRuntimeLogReader {
  read(path: string, maxBytes?: number): Promise<string>;
  readCursor?(
    path: string,
    cursor?: { dev: number; ino: number; offset: number; generation?: string },
    maxBytes?: number,
  ): Promise<{
    content: string;
    cursor: { dev: number; ino: number; offset: number; rotated: boolean; truncated?: boolean; generation?: string };
  }>;
}

export interface ResolvedRegistration {
  workspaceId: string;
  worktreeId: string;
}

export interface DaemonRuntimeResolver {
  resolveTask(cwd: string, taskName: string): Promise<ResolvedRegistration & { task: ResolvedTask }>;
  resolveWorktree(cwd: string): Promise<ResolvedRegistration>;
  resolveExec(cwd: string): Promise<{ cwd: string; envDelta: Record<string, string> }>;
}

export interface DaemonRuntimeControllerOptions {
  supervisor: DaemonRuntimeSupervisor;
  logs: DaemonRuntimeLogReader;
  resolver: DaemonRuntimeResolver;
}

export class DaemonRuntimeController {
  readonly #supervisor: DaemonRuntimeSupervisor;
  readonly #logs: DaemonRuntimeLogReader;
  readonly #resolver: DaemonRuntimeResolver;

  constructor(options: DaemonRuntimeControllerOptions) {
    this.#supervisor = options.supervisor;
    this.#logs = options.logs;
    this.#resolver = options.resolver;
  }

  async handle(request: IpcRequest): Promise<JsonEnvelope<unknown>> {
    if (!runtimeCommandNames.has(request.command)) return invalidRequest(request.command);
    try {
      const schema = runtimeArgumentSchemas[request.command as keyof typeof runtimeArgumentSchemas];
      const parsed = schema.safeParse(request.arguments);
      if (!parsed.success) return invalidRequest(request.command);
      const args = parsed.data as {
        cwd: string;
        taskName?: string;
        follow?: false;
        argv?: string[];
        cursors?: Record<string, {
          stdout?: { dev: number; ino: number; offset: number; generation?: string };
          stderr?: { dev: number; ino: number; offset: number; generation?: string };
        }>;
      };
      const cwd = args.cwd;

      if (request.command === 'start' || request.command === 'restart') {
        const taskName = args.taskName as string;
        const resolved = await this.#resolver.resolveTask(cwd, taskName);
        const input = processStartInput(resolved.worktreeId, taskName, resolved.task);
        const result = request.command === 'start'
          ? await this.#supervisor.start(input)
          : await this.#supervisor.restart(input);
        return success(request.command, { process: result.record, existing: result.existing }, scopeOf(resolved));
      }

      if (request.command === 'stop') {
        const taskName = args.taskName;
        const registration = await this.#resolver.resolveWorktree(cwd);
        const { worktreeId } = registration;
        const records = taskName === undefined
          ? await this.#supervisor.stopAll(worktreeId)
          : [await this.#supervisor.stop({ worktreeId, taskName })];
        const stale = records.find(({ state }) => state === 'STALE_IDENTITY');
        if (stale !== undefined) {
          return failure('stop', {
            code: 'RUNTIME_PROCESS_IDENTITY_STALE',
            message: 'Managed process identity is stale.',
            severity: 'error',
            context: {
              command: 'stop',
              processId: stale.id,
              taskName: stale.taskName,
              worktreeId: stale.worktreeId,
            },
          });
        }
        return success('stop', { processes: records }, scopeOf(registration));
      }

      if (request.command === 'ps') {
        const registration = await this.#resolver.resolveWorktree(cwd);
        return success('ps', { processes: this.#supervisor.list(registration.worktreeId) }, scopeOf(registration));
      }

      if (request.command === 'logs') {
        const taskName = args.taskName;
        const registration = await this.#resolver.resolveWorktree(cwd);
        const { worktreeId } = registration;
        const allRecords = latestRecords(this.#supervisor.list(worktreeId), taskName);
        const records = allRecords.slice(0, maximumLogTasks);
        const logs: Array<{
          processId: string;
          taskName: string;
          stdout: string;
          stderr: string;
          cursors?: {
            stdout?: { dev: number; ino: number; offset: number; rotated?: boolean; truncated?: boolean; generation?: string };
            stderr?: { dev: number; ino: number; offset: number; rotated?: boolean; truncated?: boolean; generation?: string };
          };
        }> = [];
        let remaining = maximumLogPayloadBytes;
        let truncated = allRecords.length > records.length;
        for (const record of records) {
          const requestedCursors = args.cursors?.[record.id];
          const stdoutLimit = Math.min(maximumLogReadBytes, remaining);
          const stdoutRead = this.#logs.readCursor === undefined || remaining === 0
            ? null
            : await this.#logs.readCursor(
              record.stdoutPath,
              requestedCursors?.stdout,
              stdoutLimit,
            );
          const stdoutRaw = stdoutRead?.content
            ?? (remaining === 0 ? '' : await this.#logs.read(record.stdoutPath, Math.min(maximumLogReadBytes, remaining)));
          if (stdoutRead !== null && Buffer.byteLength(stdoutRaw) > stdoutLimit) {
            throw new Error('Managed log cursor reader exceeded its byte budget');
          }
          const stdout = stdoutRead === null ? truncateUtf8Tail(stdoutRaw, remaining) : stdoutRaw;
          remaining -= Buffer.byteLength(stdout);
          const stderrLimit = Math.min(maximumLogReadBytes, remaining);
          const stderrRead = this.#logs.readCursor === undefined || remaining === 0
            ? null
            : await this.#logs.readCursor(
              record.stderrPath,
              requestedCursors?.stderr,
              stderrLimit,
            );
          const stderrRaw = stderrRead?.content
            ?? (remaining === 0 ? '' : await this.#logs.read(record.stderrPath, Math.min(maximumLogReadBytes, remaining)));
          if (stderrRead !== null && Buffer.byteLength(stderrRaw) > stderrLimit) {
            throw new Error('Managed log cursor reader exceeded its byte budget');
          }
          const stderr = stderrRead === null ? truncateUtf8Tail(stderrRaw, remaining) : stderrRaw;
          remaining -= Buffer.byteLength(stderr);
          truncated ||= stdout !== stdoutRaw || stderr !== stderrRaw;
          logs.push({
            processId: truncateUtf8Tail(record.id, 128),
            taskName: truncateUtf8Tail(record.taskName, 256),
            stdout,
            stderr,
            ...(this.#logs.readCursor === undefined ? {} : {
              cursors: {
                ...(stdoutRead === null
                  ? requestedCursors?.stdout === undefined ? {} : { stdout: requestedCursors.stdout }
                  : { stdout: stdoutRead.cursor }),
                ...(stderrRead === null
                  ? requestedCursors?.stderr === undefined ? {} : { stderr: requestedCursors.stderr }
                  : { stderr: stderrRead.cursor }),
              },
            }),
          });
        }
        const responseScope = scopeOf(registration);
        let envelope = success('logs', { logs, ...(truncated ? { truncated: true } : {}) }, responseScope);
        while (!fitsIpcResponse(request.id, envelope) && logs.length > 0) {
          logs.pop();
          truncated = true;
          envelope = success('logs', { logs, truncated: true }, responseScope);
        }
        return envelope;
      }

      const argv = args.argv as string[];
      const prepared = await this.#resolver.resolveExec(cwd);
      return success('exec', { argv, cwd: prepared.cwd, envDelta: prepared.envDelta });
    } catch (error) {
      return failure(request.command, runtimeError(error, request.command));
    }
  }
}

function fitsIpcResponse(id: string, envelope: JsonEnvelope<unknown>): boolean {
  return Buffer.byteLength(JSON.stringify({ protocol: protocolVersion, id, envelope })) <= defaultMaxIpcFrameBytes;
}

function processStartInput(
  worktreeId: string,
  taskName: string,
  task: ResolvedTask,
): ManagedProcessStartInput {
  return {
    worktreeId,
    taskName,
    argv: task.argv,
    cwd: task.cwd,
    env: { ...process.env, ...task.envDelta },
    shell: task.shell,
  };
}

function latestRecords(records: ManagedProcessRecord[], taskName?: string): ManagedProcessRecord[] {
  const latest = new Map<string, ManagedProcessRecord>();
  for (const record of records) {
    if (taskName !== undefined && record.taskName !== taskName) continue;
    const current = latest.get(record.taskName);
    if (
      current === undefined
      || record.startedAt > current.startedAt
      || (record.startedAt === current.startedAt && record.id > current.id)
    ) latest.set(record.taskName, record);
  }
  return [...latest.values()].sort((left, right) => left.taskName.localeCompare(right.taskName));
}

function success(command: string, data: unknown, scope?: ResolvedRegistration): JsonEnvelope<unknown> {
  return {
    schemaVersion: 1,
    ok: true,
    command,
    ...(scope === undefined ? {} : { scope: { mode: 'local' as const, ...scope } }),
    data,
    warnings: [],
    errors: [],
  };
}

/** Identifiers are echoed back to a client, so they are bounded the way every other field is. */
function scopeOf(registration: ResolvedRegistration): ResolvedRegistration {
  return {
    workspaceId: truncateUtf8Tail(registration.workspaceId, 128),
    worktreeId: truncateUtf8Tail(registration.worktreeId, 128),
  };
}

function failure(command: string, error: WtmError): JsonEnvelope<null> {
  return { schemaVersion: 1, ok: false, command, data: null, warnings: [], errors: [error] };
}

function invalidRequest(command: string): JsonEnvelope<null> {
  return failure(command, {
    code: 'WTM_DAEMON_INVALID_REQUEST',
    message: 'Invalid runtime request.',
    severity: 'error',
    context: { command },
  });
}

/**
 * The errors whose message is written for the person who typed the command rather than for a
 * log. They are the only ones allowed to cross the socket verbatim: an unexpected throw
 * carries a stack and filesystem paths, and a client has no business reading either.
 *
 * Everything a workspace can get wrong belongs here. `{port.api}` with no such endpoint
 * configured used to arrive as "Runtime request failed", which says nothing at all about the
 * one line that needs changing.
 */
const forwardedErrors = [
  WtmTaskResolutionError,
  DaemonRegistrationError,
  WtmConfigError,
  WtmEnvironmentError,
  WtmTemplateError,
  WtmEndpointAllocationError,
] as const;

function runtimeError(error: unknown, command: string): WtmError {
  if (forwardedErrors.some((candidate) => error instanceof candidate)) {
    const forwarded = error as InstanceType<(typeof forwardedErrors)[number]>;
    return {
      code: forwarded.code,
      message: forwarded.message,
      severity: 'error',
      context: { command, ...safeContext(forwarded) },
    };
  }
  const code = safeRuntimeCode(error);
  if (code !== null) {
    return {
      code,
      message: safeRuntimeMessage(code),
      severity: 'error',
      context: { command, ...safeContext(error) },
    };
  }
  return {
    code: 'WTM_DAEMON_REQUEST_FAILED',
    message: 'Runtime request failed.',
    severity: 'error',
    context: { command },
  };
}

function safeRuntimeCode(error: unknown): WtmErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = error.code;
  if (
    code === 'RUNTIME_TASK_NOT_RUNNING'
    || code === 'RUNTIME_PROCESS_IDENTITY_STALE'
    || code === 'RUNTIME_START_FAILED'
    || code === 'RUNTIME_STOP_FAILED'
  ) return code;
  return null;
}

function safeRuntimeMessage(code: WtmErrorCode): string {
  if (code === 'RUNTIME_TASK_NOT_RUNNING') return 'Managed task is not running.';
  if (code === 'RUNTIME_PROCESS_IDENTITY_STALE') return 'Managed process identity is stale.';
  if (code === 'RUNTIME_STOP_FAILED') return 'Managed task could not be stopped safely.';
  return 'Managed task could not be started.';
}

function safeContext(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null || !('context' in error)) return {};
  const raw = error.context;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  // Names and numbers a caller needs in order to find the line at fault. Deliberately
  // excludes everything that identifies the machine — `source`, paths, causes — which is why
  // the list is spelled out rather than filtered.
  const allowed = [
    'worktreeId', 'taskName', 'processId', 'state', 'reason',
    'variable', 'name', 'port', 'range', 'protocol', 'host', 'target',
  ];
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
    allowed.includes(key) && (typeof value === 'string' || typeof value === 'number' || value === null),
  ));
}

function truncateUtf8Tail(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return '';
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maximumBytes) return value;
  let start = bytes.byteLength - maximumBytes;
  while (start < bytes.byteLength && (Number(bytes[start]) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

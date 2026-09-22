import {
  adapterRequestSchema,
  isProtocolVersionCompatible,
  protocolVersion,
  type AdapterCleanupPlanResponse,
  type AdapterContext,
  type AdapterMetadata,
  type AdapterOperation,
  type AdapterPlan,
  type AdapterRequest,
  type AdapterResponse,
  type DetectionResult,
  type DoctorCheck,
} from '@wtm/protocol';

export type {
  AdapterCleanupPlanResponse,
  AdapterContext,
  AdapterMetadata,
  AdapterOperation,
  AdapterPlan,
  AdapterRequest,
  AdapterResponse,
  DetectionResult,
  DoctorCheck,
} from '@wtm/protocol';
export { protocolVersion } from '@wtm/protocol';

/**
 * What an external adapter implements. Matches the wire operations in
 * docs/06-adapter-protocol.md; `cleanupPlan` is optional because most adapters own nothing that
 * ever needs deleting, and an adapter that never returns cleanup actions never needs the hook.
 */
export interface AdapterHandlers {
  metadata(): AdapterMetadata;
  detect(context: AdapterContext): DetectionResult | Promise<DetectionResult>;
  plan(context: AdapterContext): AdapterPlan | Promise<AdapterPlan>;
  doctor(context: AdapterContext): DoctorCheck[] | Promise<DoctorCheck[]>;
  cleanupPlan?(context: AdapterContext): AdapterCleanupPlanResponse | Promise<AdapterCleanupPlanResponse>;
}

/** Identity function; exists only so an author's handler object is checked against {@link AdapterHandlers}. */
export function defineAdapter(handlers: AdapterHandlers): AdapterHandlers {
  return handlers;
}

export interface AdapterIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

const defaultIo: AdapterIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };

/**
 * Reads exactly one JSON request from stdin, dispatches it to `handlers`, and writes exactly one
 * JSON response to stdout — the whole "one process per request" contract in
 * docs/06-adapter-protocol.md. Never throws: a malformed request or a handler error is reported on
 * stderr, and the promise resolves to `false` rather than rejecting, matching what WTM's own spawn
 * path already expects from a misbehaving adapter. It does not touch `process.exitCode` itself —
 * an entry point sets that from the result, so the function stays a plain, testable request/response
 * step rather than a hidden side effect on global process state:
 *
 * ```ts
 * process.exitCode = (await runAdapter(myAdapter)) ? 0 : 1;
 * ```
 */
export async function runAdapter(handlers: AdapterHandlers, io: AdapterIo = defaultIo): Promise<boolean> {
  let request: AdapterRequest;
  try {
    // `readAll` lives inside this try too: a stdin stream error (a broken pipe, a parent that
    // closes the fd abnormally) is exactly as much "no valid request arrived" as malformed JSON
    // is, and this function's contract is to never reject on either.
    const raw = await readAll(io.stdin);
    request = adapterRequestSchema.parse(JSON.parse(raw));
  } catch (error) {
    io.stderr.write(`invalid adapter request: ${errorMessage(error)}\n`);
    return false;
  }
  if (!isProtocolVersionCompatible(request.protocol)) {
    io.stderr.write(`incompatible protocol ${request.protocol.major}.${request.protocol.minor}\n`);
    return false;
  }
  try {
    const response = await respond(handlers, request);
    io.stdout.write(JSON.stringify(response));
    return true;
  } catch (error) {
    io.stderr.write(`adapter ${request.operation} failed: ${errorMessage(error)}\n`);
    return false;
  }
}

async function respond(handlers: AdapterHandlers, request: AdapterRequest): Promise<AdapterResponse> {
  switch (request.operation) {
    case 'metadata':
      return { protocol: protocolVersion, adapter: handlers.metadata() };
    case 'detect':
      return await handlers.detect(contextOf(request));
    case 'plan':
      return await handlers.plan(contextOf(request));
    case 'doctor':
      return { findings: await handlers.doctor(contextOf(request)) };
    case 'cleanup-plan':
      return handlers.cleanupPlan === undefined ? { actions: [] } : await handlers.cleanupPlan(contextOf(request));
  }
}

function contextOf(request: Extract<AdapterRequest, { workspace: unknown }>): AdapterContext {
  return { workspace: request.workspace, repository: request.repository, worktree: request.worktree };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

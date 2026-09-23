import { spawn, type ChildProcess } from 'node:child_process';
import {
  parseAdapterResponse,
  protocolVersion,
  type AdapterContext,
  type AdapterOperation,
  type AdapterResponse,
  type ProtocolVersion,
} from '@wtm/protocol';

const defaultContext: AdapterContext = {
  workspace: { root: '/workspace' },
  repository: { root: '/workspace/repo', mainRoot: '/workspace/repo' },
  worktree: { root: '/workspace/repo', id: 1, branch: 'main' },
};

export interface AdapterInvocation {
  readonly operation: AdapterOperation;
  /** Ignored for `metadata`, which carries no context. Defaults to a plausible single-repo worktree. */
  readonly context?: AdapterContext;
  readonly protocol?: ProtocolVersion;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export type AdapterInvocationResult =
  | { readonly ok: true; readonly response: AdapterResponse; readonly stderr: string }
  | { readonly ok: false; readonly reason: 'timeout' | 'nonzero-exit' | 'invalid-response'; readonly detail: string; readonly stderr: string };

const defaultTimeoutMs = 5_000;
const defaultMaxOutputBytes = 1_048_576;

/**
 * Runs a candidate adapter file with `node` exactly the way an author would locally — a single
 * process, one JSON request on stdin, one JSON response expected on stdout — and validates that
 * response against the same schemas WTM's own daemon uses. This is a development-time check, not
 * a substitute for the real path: it spawns `node <file>` directly rather than through WTM's
 * verify-then-execute-by-descriptor trust machinery (`@wtm/core`'s `external-adapter.ts`), so it
 * proves the adapter speaks the protocol correctly but not that it will pass `wtm adapter trust`'s
 * single-file format check. Run `wtm adapter trust` against the built artifact for that.
 */
export async function invokeAdapter(executablePath: string, invocation: AdapterInvocation): Promise<AdapterInvocationResult> {
  const request = {
    protocol: invocation.protocol ?? protocolVersion,
    operation: invocation.operation,
    ...(invocation.operation === 'metadata' ? {} : {
      workspace: (invocation.context ?? defaultContext).workspace,
      repository: (invocation.context ?? defaultContext).repository,
      worktree: (invocation.context ?? defaultContext).worktree,
    }),
  };

  // A dedicated process group lets the timeout path below terminate a hung adapter's own
  // descendants (nothing stops a `detect`/`plan` handler from spawning one, e.g. while
  // prototyping a `cargo fetch`/`docker` call) instead of leaving them running unsupervised
  // after this function has already resolved.
  const child = spawn(process.execPath, [executablePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const timeoutMs = invocation.timeoutMs ?? defaultTimeoutMs;
  const maxOutputBytes = invocation.maxOutputBytes ?? defaultMaxOutputBytes;

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdoutBytes >= maxOutputBytes) return;
    stdoutBytes += chunk.byteLength;
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= maxOutputBytes) return;
    stderrBytes += chunk.byteLength;
    stderr.push(chunk);
  });

  // A candidate adapter that exits before (or while) this write lands turns it into a write to a
  // closed pipe (EPIPE). Without a listener, Node treats that as an unhandled error and crashes
  // this process instead of letting the `close` handler below report the documented
  // `nonzero-exit`/`timeout` result — exactly the crash this function exists to keep out of an
  // adapter author's own test run. Mirrors `@wtm/core`'s `external-adapter.ts` (`onStdinError`).
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();

  const outcome = await new Promise<{ timedOut: boolean; exitCode: number | null }>((resolve) => {
    const timer = setTimeout(() => {
      killAdapterProcessGroup(child);
      resolve({ timedOut: true, exitCode: null });
    }, timeoutMs);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ timedOut: false, exitCode });
    });
  });

  const stderrText = Buffer.concat(stderr).toString('utf8');
  if (outcome.timedOut) {
    return { ok: false, reason: 'timeout', detail: `adapter did not exit within ${timeoutMs}ms`, stderr: stderrText };
  }
  if (outcome.exitCode !== 0) {
    return { ok: false, reason: 'nonzero-exit', detail: `adapter exited with code ${String(outcome.exitCode)}`, stderr: stderrText };
  }

  try {
    const payload: unknown = JSON.parse(Buffer.concat(stdout).toString('utf8'));
    return { ok: true, response: parseAdapterResponse(invocation.operation, payload), stderr: stderrText };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'invalid-response', detail, stderr: stderrText };
  }
}

/** Mirrors `@wtm/core`'s `signalAdapterProcessGroup`: kills the whole group the adapter's
 * `detached` spawn above started, not just the immediate `node` process, so a descendant the
 * adapter spawned while handling the timed-out request doesn't outlive this call. */
function killAdapterProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    // The process may already have exited; direct-child fallback is best effort.
  }
  child.kill('SIGKILL');
}

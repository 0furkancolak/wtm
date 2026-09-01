import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  darwinSocketPathLimitBytes,
  publishedDaemonSocketPath,
} from '@wtm/platform/socket';
import {
  FrameDecoder,
  encodeFrame,
  ipcRequestSchema,
  jsonEnvelopeSchema,
  protocolVersion,
  type IpcRequest,
} from '@wtm/protocol';
import type { DiagnosticDataSource, RegisteredWorkspace } from '../diagnostics';
import { DiagnosticSourceError, defaultDaemonSocketPath, runCli } from '../index';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const workspace: RegisteredWorkspace = {
  id: 'workspace-1',
  name: 'demo',
  root: '/registered/demo',
  scope: 'local',
};

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function sourceFailingWith(error: unknown): DiagnosticDataSource {
  const unused = async (): Promise<never> => { throw new Error('not part of this test'); };
  return {
    listRegisteredWorkspaces: async () => [workspace],
    readStatus: async () => { throw error; },
    readDoctor: unused,
    readExplain: unused,
    readPlan: unused,
    readEnv: unused,
    readPorts: unused,
  };
}

/** A daemon socket that answers, at a path far inside the limit. */
async function listeningDaemon(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-sock-'));
  const path = join(directory, 'wtmd.sock');
  const server = createServer((socket: Socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
        const request: IpcRequest = ipcRequestSchema.parse(JSON.parse(frame.toString('utf8')));
        socket.write(encodeFrame(Buffer.from(JSON.stringify({
          protocol: protocolVersion,
          id: request.id,
          envelope: {
            schemaVersion: 1,
            ok: true,
            command: request.command,
            data: { processes: [] },
            warnings: [],
            errors: [],
          },
        }))));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return path;
}

/**
 * The macOS socket root, spelled out rather than read from `PlatformRuntime.paths.socketRoot`.
 *
 * Deriving it from the resolver under test would make this suite agree with whatever that
 * resolver said. Spelling it literally is what pins macOS across the move onto the platform seam.
 */
function darwinSocketRoot(home: string): string {
  return join(home, 'Library', 'Application Support', 'WTM');
}

/** A socket path one byte past what a Unix socket address can hold. */
const overLimitSocketPath = publishedDaemonSocketPath(darwinSocketRoot(`/${'h'.repeat(62)}`));

describe('daemon socket path in the CLI', () => {
  test('advertises the shared published path', () => {
    expect(defaultDaemonSocketPath('/Users/x')).toBe(publishedDaemonSocketPath(darwinSocketRoot('/Users/x')));
  });

  test('the macOS address is the byte-for-byte one every installed daemon is already listening on', () => {
    // The literal, not a derivation of it. `defaultDaemonSocketPath` now asks the platform runtime
    // for its socket root instead of spelling `Library/Application Support` itself, and an
    // installed LaunchAgent that survives that change has to keep answering on the same address —
    // a daemon and a CLI that disagree about the path by one byte simply never meet.
    expect(defaultDaemonSocketPath('/Users/x'))
      .toBe('/Users/x/Library/Application Support/WTM/wtmd.sock');
  });

  test('ignores the XDG variables on macOS, so a home is not silently relocated', () => {
    // A macOS user who exports `XDG_STATE_HOME` for some other tool must not find WTM's socket
    // somewhere else. The variables are read from the ambient process here, which is what makes
    // this the real assertion rather than a restatement of the resolver.
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = '/xdg/state';
    try {
      expect(defaultDaemonSocketPath('/Users/x'))
        .toBe('/Users/x/Library/Application Support/WTM/wtmd.sock');
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });

  test('maps the new code to exit 2, the class for configuration the user has to change', async () => {
    const output = capture();

    const exitCode = await runCli(['status', '--json'], {
      cwd: '/registered/demo',
      dataSource: sourceFailingWith(new DiagnosticSourceError({
        code: 'WTM_SOCKET_PATH_TOO_LONG',
        message: 'The WTM daemon socket path is too long.',
        severity: 'error',
      })),
      ...output.io,
    });

    expect(JSON.parse(output.stdout()).errors[0].code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(exitCode).toBe(2);
  });

  test('a runtime command under an over-long home explains itself instead of reporting an unreachable daemon', async () => {
    const output = capture();

    const exitCode = await runCli(['ps', '--json'], {
      cwd: '/registered/demo',
      daemonSocketPath: overLimitSocketPath,
      ...output.io,
    });

    const envelope = JSON.parse(output.stdout());
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0].code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(envelope.errors[0].message).toContain(String(darwinSocketPathLimitBytes));
    expect(envelope.errors[0].message).toContain(String(darwinSocketPathLimitBytes + 1));
    expect(envelope.errors[0].message).toContain(overLimitSocketPath);
    expect(envelope.errors[0].context).toMatchObject({
      byteLength: darwinSocketPathLimitBytes + 1,
      limitBytes: darwinSocketPathLimitBytes,
    });
    expect(envelope.errors[0].remediation).toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);
    expect(exitCode).toBe(2);
  });

  test('a socket path that fits is connected to rather than refused', async () => {
    const output = capture();

    const exitCode = await runCli(['ps', '--json'], {
      cwd: '/registered/demo',
      daemonSocketPath: await listeningDaemon(),
      ...output.io,
    });

    expect(JSON.parse(output.stdout()).ok).toBe(true);
    expect(exitCode).toBe(0);
  });
});

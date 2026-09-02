import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonSocketFileName,
  publishedDaemonSocketPath,
} from '@wtm/platform/socket';
import { selectPlatformRuntime } from '@wtm/platform';
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
 * `sizeof(sun_path)` for the machine this file runs on: 104 bytes on macOS, 108 on Linux.
 *
 * `runCli` measures the address it is given against `hostPlatformRuntime().socket.limitBytes`
 * (`main.ts:1106`), so a fixture written as `darwinSocketPathLimitBytes + 1` was 105 bytes — past
 * macOS's limit and comfortably inside Linux's. The refusal the test below is named for simply
 * did not happen there, and the command connected instead.
 */
const hostLimitBytes = selectPlatformRuntime().socket.limitBytes;

/**
 * A socket path of exactly `bytes` bytes, ending in the name the daemon actually publishes.
 *
 * The refusal is a property of the address's length, so the fixture has to hit a length rather
 * than merely be deep. The file name is the real one because `boundDaemonSocketPath` substitutes
 * its first character rather than prefixing it, which is what keeps the measured path exactly
 * this long.
 */
function socketPathOfBytes(bytes: number): string {
  const segment = bytes - daemonSocketFileName.length - 2;
  if (segment < 1) throw new Error(`${bytes} bytes cannot hold a socket path`);
  const path = `/${'h'.repeat(segment)}/${daemonSocketFileName}`;
  if (Buffer.byteLength(path) !== bytes) throw new Error('fixture did not hit the requested length');
  return path;
}

/** One byte past what a Unix socket address holds on this host: 105 on macOS, 109 on Linux. */
const overLimitSocketPath = socketPathOfBytes(hostLimitBytes + 1);

describe('daemon socket path in the CLI', () => {
  test('advertises the shared published path, wherever this platform keeps its sockets', () => {
    // `defaultDaemonSocketPath` takes a home but not a platform: it asks the host. So this is the
    // half of the macOS claim that is about the CLI, stated so it stays true on either host — the
    // advertised address is `publishedDaemonSocketPath` applied to *this* platform's socket root
    // and nothing else. It fails if the CLI goes back to deriving the address from the data root
    // (which on Linux is a different directory), or spells `wtmd.sock` a second time itself.
    expect(defaultDaemonSocketPath('/Users/x'))
      .toBe(publishedDaemonSocketPath(selectPlatformRuntime({ home: '/Users/x' }).paths.socketRoot));
  });

  test('the macOS address is the byte-for-byte one every installed daemon is already listening on', () => {
    // The literal, and a *named* platform rather than this host. Asked of the host, this assertion
    // demanded `Library/Application Support` from a Linux runner that has no such directory — and
    // the fix is not to weaken the claim but to say which platform it is about. Together with the
    // test above it still pins the whole chain on macOS: the CLI publishes at the platform's
    // socket root, and darwin's socket root is this exact address. An installed LaunchAgent that
    // survives the move onto the platform seam has to keep answering here, because a daemon and a
    // CLI that disagree about the path by one byte simply never meet.
    const darwin = selectPlatformRuntime({ platform: 'darwin', home: '/Users/x', env: {} });

    expect(publishedDaemonSocketPath(darwin.paths.socketRoot))
      .toBe('/Users/x/Library/Application Support/WTM/wtmd.sock');
  });

  test('ignores the XDG variables on macOS, so a home is not silently relocated', () => {
    // A macOS user who exports `XDG_STATE_HOME` for some other tool must not find WTM's socket
    // somewhere else. The variable is read from the ambient process, which is what makes this the
    // real assertion rather than a restatement of the resolver: `selectPlatformRuntime` defaults
    // `env` to `process.env`, and that default is the one production takes.
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = '/xdg/state';
    try {
      const darwin = selectPlatformRuntime({ platform: 'darwin', home: '/Users/x' });

      expect(publishedDaemonSocketPath(darwin.paths.socketRoot))
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
    expect(envelope.errors[0].message).toContain(String(hostLimitBytes));
    expect(envelope.errors[0].message).toContain(String(hostLimitBytes + 1));
    expect(envelope.errors[0].message).toContain(overLimitSocketPath);
    expect(envelope.errors[0].context).toMatchObject({
      byteLength: hostLimitBytes + 1,
      limitBytes: hostLimitBytes,
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

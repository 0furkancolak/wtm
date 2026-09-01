import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonSocketPathLimitBytes,
  publishedDaemonSocketPath,
} from '@wtm/core';
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

/** A socket path one byte past what a Unix socket address can hold. */
const overLimitSocketPath = publishedDaemonSocketPath(`/${'h'.repeat(62)}`);

describe('daemon socket path in the CLI', () => {
  test('advertises the shared published path', () => {
    expect(defaultDaemonSocketPath('/Users/x')).toBe(publishedDaemonSocketPath('/Users/x'));
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
    expect(envelope.errors[0].message).toContain(String(daemonSocketPathLimitBytes));
    expect(envelope.errors[0].message).toContain(String(daemonSocketPathLimitBytes + 1));
    expect(envelope.errors[0].message).toContain(overLimitSocketPath);
    expect(envelope.errors[0].context).toMatchObject({
      byteLength: daemonSocketPathLimitBytes + 1,
      limitBytes: daemonSocketPathLimitBytes,
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

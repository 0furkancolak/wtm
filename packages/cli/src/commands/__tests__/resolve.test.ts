import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import { runResolveCommand } from '../resolve';
import { runRunCommand } from '../run';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe('runResolveCommand', () => {
  test('returns the dry final command, cwd and environment delta in a stable JSON envelope', async () => {
    const envelope = await runResolveCommand({
      config: {
        environment: { WTM_ID: '{id}', WEB_PORT: '{port.web}' },
        tasks: {
          dev: {
            main: ['make', 'dev'],
            worktree: ['make', 'dev-with-worktree-{id}'],
            cwd: '{workspace.root}',
          },
        },
      },
      taskName: 'dev',
      isMain: false,
      workspaceId: 'workspace-1',
      context: context('/projects/demo/repo-feature', 3),
    });

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'resolve',
      scope: { mode: 'local', workspaceId: 'workspace-1' },
      data: {
        argv: ['make', 'dev-with-worktree-3'],
        shell: false,
        cwd: '/projects/demo',
        envDelta: { WTM_ID: '3', WEB_PORT: '23003' },
      },
      warnings: [],
      errors: [],
    });
  });

  test('maps missing tasks without leaking stacks into the JSON contract', async () => {
    const envelope = await runResolveCommand({
      config: { tasks: {} },
      taskName: 'missing',
      isMain: true,
      context: context('/projects/demo/repo', 1),
    });

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      ok: false,
      command: 'resolve',
      data: null,
      errors: [{
        code: 'WTM_CONFIG_INVALID',
        severity: 'error',
        context: { command: 'resolve', taskName: 'missing' },
      }],
    });
    expect(JSON.stringify(envelope)).not.toContain('stack');
  });
});

describe('runRunCommand', () => {
  test('waits for an argv task in the foreground with resolved cwd and environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-run-'));
    temporaryDirectories.push(directory);
    const script = [
      "const fs = require('node:fs');",
      "fs.writeFileSync('observed.json', JSON.stringify([process.cwd(), process.env.WTM_VALUE]));",
    ].join('');

    const envelope = await runRunCommand({
      config: {
        environment: { WTM_VALUE: 'worktree-{id}' },
        tasks: { record: { run: ['node', '-e', script], cwd: '{worktree.root}' } },
      },
      taskName: 'record',
      isMain: false,
      context: context(directory, 3),
    });

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      ok: true,
      command: 'run',
      data: {
        exitCode: 0,
        signal: null,
        task: { shell: false, cwd: directory, envDelta: { WTM_VALUE: 'worktree-3' } },
      },
    });
    expect(JSON.parse(await readFile(join(directory, 'observed.json'), 'utf8')))
      .toEqual([await realpath(directory), 'worktree-3']);
  });

  test('executes an explicitly approved shell string and reports nonzero exits as runtime errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-run-shell-'));
    temporaryDirectories.push(directory);
    const shellEnvelope = await runRunCommand({
      config: {
        tasks: {
          shell: {
            run: "printf '%s' \"$WTM_VALUE\" > shell.txt",
            shell: true,
            cwd: '{worktree.root}',
            env: { WTM_VALUE: 'shell-{id}' },
          },
        },
      },
      taskName: 'shell',
      isMain: true,
      context: context(directory, 1),
    });
    expect(shellEnvelope).toMatchObject({ ok: true, data: { exitCode: 0 } });
    expect(await readFile(join(directory, 'shell.txt'), 'utf8')).toBe('shell-1');

    const failedEnvelope = await runRunCommand({
      config: { tasks: { fail: { run: ['node', '-e', 'process.exit(7)'] } } },
      taskName: 'fail',
      isMain: true,
      context: context(directory, 1),
    });
    expect(jsonEnvelopeSchema.parse(failedEnvelope)).toMatchObject({
      ok: false,
      command: 'run',
      data: null,
      errors: [{
        code: 'RUNTIME_START_FAILED',
        context: { command: 'run', taskName: 'fail', exitCode: 7, signal: null },
      }],
    });
  });
});

function context(worktreeRoot: string, id: number) {
  return {
    workspace: { root: '/projects/demo', name: 'demo' },
    repo: { root: '/projects/demo/repo', name: 'repo' },
    main: { root: '/projects/demo/repo' },
    worktree: { root: worktreeRoot },
    id,
    key: `repo:${id}`,
    slug: `repo-${id}`,
    branch: id === 1 ? 'main' : 'feat/runtime',
    branchSlug: id === 1 ? 'main' : 'feat-runtime',
    ports: { web: 23000 + id },
    env: { PATH: process.env.PATH },
  };
}

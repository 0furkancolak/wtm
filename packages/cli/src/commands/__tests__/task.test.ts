import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createGitSafetyFixture, type GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import type { RuntimeDaemonClient } from '../runtime-client';
import {
  runTaskListCommand, runTaskSetCommand, runTaskShowCommand, runTaskUnsetCommand,
  taskOverrideToToml, taskValueFromFlags,
} from '../task';
import { runCli } from '../../main';

const fixtures: GitSafetyFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function repository() {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return { fixture, databasePath: join(fixture.root, 'state.db') };
}

const record = {
  taskName: 'dev', task: { run: 'npm run dev', shell: true },
  createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z',
};

describe('taskValueFromFlags', () => {
  test('builds a task from individual flags', () => {
    const result = taskValueFromFlags({
      run: 'npm run dev', shell: true, cwd: '/repo', background: true, singleton: true,
      description: 'Run the dev server', env: ['PORT=3000', 'HOST=localhost'],
    });
    expect(result).toEqual({
      value: {
        run: 'npm run dev', shell: true, cwd: '/repo', background: true, singleton: true,
        description: 'Run the dev server', env: { PORT: '3000', HOST: 'localhost' },
      },
    });
  });

  test('builds an argv command with no shell', () => {
    expect(taskValueFromFlags({ argv: ['node', 'server.js'] })).toEqual({ value: { run: ['node', 'server.js'] } });
  });

  test('prefers --task-json over the individual flags, and validates it', () => {
    expect(taskValueFromFlags({ taskJson: '{"run":"npm run dev","shell":true}', run: 'ignored' }))
      .toEqual({ value: { run: 'npm run dev', shell: true } });
    expect(taskValueFromFlags({ taskJson: 'not json' })).toMatchObject({ error: { code: 'WTM_CONFIG_INVALID' } });
    expect(taskValueFromFlags({ taskJson: '{"unknownField":true}' })).toMatchObject({ error: { code: 'WTM_CONFIG_INVALID' } });
  });

  test('refuses --run combined with --argv, and a malformed --env', () => {
    expect(taskValueFromFlags({ run: 'npm run dev', argv: ['node'] })).toMatchObject({ error: { code: 'WTM_CONFIG_INVALID' } });
    expect(taskValueFromFlags({ run: 'npm run dev', shell: true, env: ['NOEQUALS'] })).toMatchObject({ error: { code: 'WTM_CONFIG_INVALID' } });
  });

  // Cross-field rules like "a string --run requires --shell" are core's business rules
  // (`taskSchema`'s `superRefine`), re-checked authoritatively where the daemon writes the
  // override, not duplicated here — see `taskOverrideValueSchema`'s own doc comment.
  test('accepts a run string with no --shell at this shape-only layer', () => {
    expect(taskValueFromFlags({ run: 'npm run dev' })).toEqual({ value: { run: 'npm run dev' } });
  });
});

describe('taskOverrideToToml', () => {
  test('renders a [tasks.<name>] block', () => {
    const toml = taskOverrideToToml('dev', { run: 'npm run dev', shell: true });
    expect(toml).toContain('[tasks.dev]');
    expect(toml).toContain('run = "npm run dev"');
    expect(toml).toContain('shell = true');
  });
});

describe('task commands', () => {
  test('list forwards cwd and validates the result', async () => {
    const { fixture } = await repository();
    const calls: Array<{ command: string; args: unknown }> = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, args });
        return { schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { tasks: [record] } };
      },
    };
    expect(await runTaskListCommand({ cwd: fixture.repoPath }, client)).toMatchObject({
      ok: true, command: 'task list', data: { tasks: [record] },
    });
    expect(calls).toEqual([{ command: 'task.list', args: { cwd: fixture.repoPath } }]);
  });

  test('show forwards taskName and reports a missing override as null, not an error', async () => {
    const { fixture } = await repository();
    const client: RuntimeDaemonClient = {
      request: async (command) => ({ schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { task: null } }),
    };
    expect(await runTaskShowCommand({ cwd: fixture.repoPath, taskName: 'dev' }, client)).toMatchObject({
      ok: true, command: 'task show', data: { task: null },
    });
  });

  test('set forwards the built task and validates the daemon\'s record', async () => {
    const { fixture } = await repository();
    const calls: Array<{ command: string; args: unknown }> = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, args });
        return { schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { task: record } };
      },
    };
    const task = { run: 'npm run dev', shell: true };
    expect(await runTaskSetCommand({ cwd: fixture.repoPath, taskName: 'dev', task }, client)).toMatchObject({
      ok: true, command: 'task set', data: { task: record },
    });
    expect(calls).toEqual([{ command: 'task.set', args: { cwd: fixture.repoPath, taskName: 'dev', task } }]);
  });

  test('set rejects an invalid daemon result', async () => {
    const { fixture } = await repository();
    const client: RuntimeDaemonClient = {
      request: async (command) => ({ schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { task: { taskName: 'dev' } } }),
    };
    expect(await runTaskSetCommand({ cwd: fixture.repoPath, taskName: 'dev', task: { run: 'x', shell: true } }, client)).toMatchObject({
      ok: false, command: 'task set', errors: [{ code: 'WTM_DAEMON_REQUEST_FAILED' }],
    });
  });

  test('unset forwards taskName and reports whether a row was removed', async () => {
    const { fixture } = await repository();
    const client: RuntimeDaemonClient = {
      request: async (command) => ({ schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { removed: true } }),
    };
    expect(await runTaskUnsetCommand({ cwd: fixture.repoPath, taskName: 'dev' }, client)).toMatchObject({
      ok: true, command: 'task unset', data: { removed: true },
    });
  });

  test('without a daemon every command is WTM_DAEMON_UNAVAILABLE', async () => {
    const { fixture } = await repository();
    expect(await runTaskListCommand({ cwd: fixture.repoPath })).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
    expect(await runTaskUnsetCommand({ cwd: fixture.repoPath, taskName: 'dev' })).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
  });

  test('the task commands are registered with --worktree, --repo and --json', async () => {
    const { fixture, databasePath } = await repository();
    let out = '';
    const code = await runCli(['task', 'list', '--json'], {
      cwd: fixture.repoPath,
      taskTargetDatabasePath: databasePath,
      taskTargetGlobalConfigPath: join(fixture.root, 'config.toml'),
      // Never the user's real socket: a running daemon would answer instead of WTM_DAEMON_UNAVAILABLE.
      daemonSocketPath: join(fixture.root, 'absent.sock'),
      stdout: (value) => { out += value; },
      stderr: () => {},
    });
    expect(code).toBeGreaterThan(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, command: 'task list', errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
  });

  test('export accepts --json after the argument, like every sibling task command, and labels it "task export"', async () => {
    const { fixture, databasePath } = await repository();
    let out = '';
    const code = await runCli(['task', 'export', 'dev', '--json'], {
      cwd: fixture.repoPath,
      taskTargetDatabasePath: databasePath,
      taskTargetGlobalConfigPath: join(fixture.root, 'config.toml'),
      // Never the user's real socket: a running daemon would answer instead of WTM_DAEMON_UNAVAILABLE.
      daemonSocketPath: join(fixture.root, 'absent.sock'),
      stdout: (value) => { out += value; },
      stderr: () => {},
    });
    expect(code).toBeGreaterThan(0);
    // Without `addJsonOption`, commander rejected `--json` here as an unknown option before the
    // command ever ran, and `runTaskShowCommand`'s envelope (built for 'task show', its own
    // caller-blind command name) leaked through unrelabeled when it did run.
    expect(JSON.parse(out)).toMatchObject({ ok: false, command: 'task export', errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
  });

  test('task set refuses --run combined with --argv before ever contacting the daemon', async () => {
    const { fixture, databasePath } = await repository();
    let out = '';
    const code = await runCli(['task', 'set', 'dev', '--run', 'npm run dev', '--argv', 'node', '--json'], {
      cwd: fixture.repoPath,
      taskTargetDatabasePath: databasePath,
      taskTargetGlobalConfigPath: join(fixture.root, 'config.toml'),
      // Never the user's real socket: a running daemon would answer instead of WTM_DAEMON_UNAVAILABLE.
      daemonSocketPath: join(fixture.root, 'absent.sock'),
      stdout: (value) => { out += value; },
      stderr: () => {},
    });
    expect(code).toBeGreaterThan(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, command: 'task set', errors: [{ code: 'WTM_CONFIG_INVALID' }] });
  });
});

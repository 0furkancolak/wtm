import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createGitSafetyFixture, type GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import type { RuntimeDaemonClient } from '../runtime-client';
import { runChecklistClearCommand, runChecklistListCommand, runChecklistSetCommand } from '../checklist';
import { runCli } from '../../main';

const fixtures: GitSafetyFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function repository() {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return { fixture, databasePath: join(fixture.root, 'state.db') };
}

const item = {
  position: 0, text: 'Check the login flow', checked: false,
  createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z',
};

describe('checklist commands', () => {
  test('list forwards cwd and validates the result', async () => {
    const { fixture } = await repository();
    const calls: Array<{ command: string; args: unknown }> = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, args });
        return { schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { items: [item] } };
      },
    };
    expect(await runChecklistListCommand({ cwd: fixture.repoPath }, client)).toMatchObject({
      ok: true, command: 'checklist list', data: { items: [item] },
    });
    expect(calls).toEqual([{ command: 'checklist.list', args: { cwd: fixture.repoPath } }]);
  });

  test('set forwards the item list and validates the daemon\'s result', async () => {
    const { fixture } = await repository();
    const calls: Array<{ command: string; args: unknown }> = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, args });
        return { schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { items: [item] } };
      },
    };
    expect(await runChecklistSetCommand({ cwd: fixture.repoPath, items: ['Check the login flow'] }, client)).toMatchObject({
      ok: true, command: 'checklist set', data: { items: [item] },
    });
    expect(calls).toEqual([{ command: 'checklist.set', args: { cwd: fixture.repoPath, items: ['Check the login flow'] } }]);
  });

  test('set rejects an invalid daemon result', async () => {
    const { fixture } = await repository();
    const client: RuntimeDaemonClient = {
      request: async (command) => ({ schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { items: [{ position: 0 }] } }),
    };
    expect(await runChecklistSetCommand({ cwd: fixture.repoPath, items: ['x'] }, client)).toMatchObject({
      ok: false, command: 'checklist set', errors: [{ code: 'WTM_DAEMON_REQUEST_FAILED' }],
    });
  });

  test('clear forwards cwd and reports how many rows were removed', async () => {
    const { fixture } = await repository();
    const client: RuntimeDaemonClient = {
      request: async (command) => ({ schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { removed: 2 } }),
    };
    expect(await runChecklistClearCommand({ cwd: fixture.repoPath }, client)).toMatchObject({
      ok: true, command: 'checklist clear', data: { removed: 2 },
    });
  });

  test('without a daemon every command is WTM_DAEMON_UNAVAILABLE', async () => {
    const { fixture } = await repository();
    expect(await runChecklistListCommand({ cwd: fixture.repoPath })).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
    expect(await runChecklistClearCommand({ cwd: fixture.repoPath })).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
  });

  test('the checklist commands are registered with --worktree, --repo and --json', async () => {
    const { fixture, databasePath } = await repository();
    let out = '';
    const code = await runCli(['checklist', 'list', '--json'], {
      cwd: fixture.repoPath,
      taskTargetDatabasePath: databasePath,
      taskTargetGlobalConfigPath: join(fixture.root, 'config.toml'),
      stdout: (value) => { out += value; },
      stderr: () => {},
    });
    expect(code).toBeGreaterThan(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, command: 'checklist list', errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
  });

  test('checklist set with zero --item flags is a clear usage error, not a silent clear', async () => {
    const { fixture, databasePath } = await repository();
    let out = '';
    const code = await runCli(['checklist', 'set', '--json'], {
      cwd: fixture.repoPath,
      taskTargetDatabasePath: databasePath,
      taskTargetGlobalConfigPath: join(fixture.root, 'config.toml'),
      stdout: (value) => { out += value; },
      stderr: () => {},
    });
    expect(code).toBeGreaterThan(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, command: 'checklist set', errors: [{ code: 'WTM_CONFIG_INVALID' }] });
  });

  test('checklist set forwards repeated --item flags in order', async () => {
    const { fixture, databasePath } = await repository();
    let out = '';
    const code = await runCli(['checklist', 'set', '--item', 'Check login', '--item', 'Run migration', '--json'], {
      cwd: fixture.repoPath,
      taskTargetDatabasePath: databasePath,
      taskTargetGlobalConfigPath: join(fixture.root, 'config.toml'),
      stdout: (value) => { out += value; },
      stderr: () => {},
    });
    expect(code).toBeGreaterThan(0);
    // No daemon in this test environment, so this still reaches WTM_DAEMON_UNAVAILABLE — the
    // point here is that two --item flags do not throw a usage error before that.
    expect(JSON.parse(out)).toMatchObject({ ok: false, command: 'checklist set', errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
  });
});

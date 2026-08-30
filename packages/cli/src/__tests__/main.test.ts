import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createAdapterTrustStore } from '@wtm/core';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import { createFakeAdapter } from '../../../testkit/src/fake-adapter';
import type { DiagnosticDataSource, RegisteredWorkspace } from '../diagnostics';
import { createCli, DiagnosticSourceError, runCli } from '../index';

const workspace: RegisteredWorkspace = {
  id: 'workspace-1',
  name: 'demo',
  root: '/registered/demo',
  scope: 'local',
};

function source(): DiagnosticDataSource {
  return {
    listRegisteredWorkspaces: async () => [workspace],
    readStatus: async () => ({
      workspace,
      identity: {
        repositoryId: null,
        worktreeId: null,
        numericId: null,
        path: '/registered/demo',
        branch: null,
        headOid: null,
        isMain: true,
      },
      state: 'UNKNOWN',
      endpoints: [],
      processes: [],
      resources: [],
    }),
    readDoctor: async () => ({ workspace, findings: [] }),
    readExplain: async () => ({ workspace, decisions: [] }),
    readPlan: async () => ({ workspace, changes: [] }),
    readEnv: async () => ({ workspace, variables: {} }),
    readPorts: async () => ({ workspace, leases: [] }),
  };
}

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

describe('Commander CLI', () => {
  test('prints the package version alone', async () => {
    const output = capture();

    expect(await runCli(['--version'], output.io)).toBe(0);
    expect(output.stderr()).toBe('');
    expect(output.stdout()).toBe('0.1.0\n');
  });

  test('includes the Nafru attribution once in root help', async () => {
    const output = capture();

    expect(await runCli(['--help'], output.io)).toBe(0);
    expect(output.stderr()).toBe('');
    expect(output.stdout().match(/Powered by https:\/\/nafru\.com/gu)).toHaveLength(1);
  });

  test('keeps status JSON free of product attribution', async () => {
    const output = capture();

    expect(await runCli(['status', '--json'], {
      dataSource: source(),
      cwd: '/registered/demo',
      ...output.io,
    })).toBe(0);
    expect(output.stderr()).toBe('');
    expect(() => JSON.parse(output.stdout())).not.toThrow();
    expect(output.stdout()).not.toContain('Powered by https://nafru.com');
  });

  test('exposes diagnostic, runtime, daemon, and resource lifecycle commands', () => {
    const cli = createCli({ dataSource: source(), cwd: '/registered/demo' });

    expect(cli.commands.map((command) => command.name())).toEqual([
      'status', 'doctor', 'explain', 'plan', 'env', 'ports',
      'resolve', 'run', 'analyze', 'remove', 'start', 'stop', 'restart', 'ps', 'logs', 'exec',
      'daemon', 'disk', 'gc', 'adapter', 'init', 'detect', 'skill',
    ]);
  });

  test('routes resolve, analyze, and remove through their production parser boundaries', async () => {
    const calls: Array<{ command: string; input: unknown }> = [];
    const ok = (command: string) => ({
      schemaVersion: 1 as const, ok: true as const, command,
      scope: { mode: 'local' as const }, data: null, warnings: [], errors: [],
    });

    for (const testCase of [
      { argv: ['resolve', 'dev', '--json'], command: 'resolve' },
      { argv: ['analyze', '../linked', '--json'], command: 'analyze' },
      { argv: ['remove', '../linked', '--json'], command: 'remove' },
    ]) {
      const output = capture();
      expect(await runCli(testCase.argv, {
        cwd: '/workspace/repo',
        resolveRunner: async (input) => { calls.push({ command: 'resolve', input }); return ok('resolve'); },
        analyzeRunner: async (input) => { calls.push({ command: 'analyze', input }); return ok('analyze'); },
        removeRunner: async (input) => { calls.push({ command: 'remove', input }); return ok('remove'); },
        ...output.io,
      })).toBe(0);
      expect(JSON.parse(output.stdout()).command).toBe(testCase.command);
    }

    expect(calls).toEqual([
      { command: 'resolve', input: { cwd: '/workspace/repo', taskName: 'dev' } },
      { command: 'analyze', input: { repoPath: '/workspace/repo', selector: '../linked' } },
      { command: 'remove', input: { repoPath: '/workspace/repo', selector: '../linked' } },
    ]);
  });

  test('skill print emits exactly the canonical skill without an added newline or envelope', async () => {
    const output = capture();
    const canonical = await readFile(join(import.meta.dir, '../../../../skills/wtm/SKILL.md'), 'utf8');

    const exitCode = await runCli(['skill', 'print'], { ...output.io });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe('');
    expect(output.stdout()).toBe(canonical);
  });

  test('registers init and forwards --no-ai-skill without invoking the installer', async () => {
    const output = capture();
    let installs = 0;
    const seen: unknown[] = [];

    const exitCode = await runCli(['init', 'project', '--yes', '--max-depth', '3', '--no-ai-skill', '--json'], {
      cwd: '/workspace',
      initRunner: async (input) => {
        seen.push(input);
        return {
          schemaVersion: 1,
          ok: true,
          command: 'init',
          scope: { mode: 'local', workspaceId: 'workspace-1' },
          data: null,
          warnings: [],
          errors: [],
        };
      },
      skillInstaller: {
        async install() {
          installs += 1;
          return { path: '/must-not-be-written/SKILL.md' };
        },
      },
      ...output.io,
    });

    expect(exitCode).toBe(0);
    expect(installs).toBe(0);
    expect(seen).toEqual([expect.objectContaining({
      root: '/workspace/project',
      maxDepth: 3,
      globalOnly: false,
      installAiSkill: false,
      acceptDefaults: true,
    })]);
  });

  test('rejects an invalid init discovery depth as deterministic JSON usage', async () => {
    const output = capture();

    const exitCode = await runCli(['init', '--max-depth', '-1', '--json'], { ...output.io });

    expect(exitCode).toBe(2);
    expect(output.stderr()).toBe('');
    expect(JSON.parse(output.stdout())).toMatchObject({
      ok: false,
      command: 'init',
      errors: [{ code: 'WTM_CONFIG_INVALID' }],
    });
  });

  test('renders skill installation failures as one deterministic JSON envelope', async () => {
    const output = capture();

    const exitCode = await runCli(['skill', 'install', '--json'], {
      skillInstaller: { async install() { throw new Error('private vendor detail'); } },
      ...output.io,
    });

    expect(exitCode).toBe(2);
    expect(output.stderr()).toBe('');
    expect(JSON.parse(output.stdout())).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'skill install',
      scope: { mode: 'local' },
      data: null,
      warnings: [],
      errors: [{
        code: 'WTM_CONFIG_INVALID',
        message: 'WTM Agent Skill installation failed.',
        severity: 'error',
        context: { scope: 'local' },
      }],
    });
  });

  test('writes schema-valid JSON through injected stdout', async () => {
    const output = capture();
    const exitCode = await runCli(['status', '--json'], {
      dataSource: source(),
      cwd: '/registered/demo',
      ...output.io,
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe('');
    const envelope = JSON.parse(output.stdout());
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.command).toBe('status');
    expect(envelope.data.workspaces[0].state).toBe('UNKNOWN');
  });

  test('supports selector and global scope options for every command', async () => {
    for (const command of ['status', 'doctor', 'explain', 'plan', 'env', 'ports']) {
      const output = capture();
      const exitCode = await runCli([command, '--global', '--json'], {
        dataSource: source(),
        cwd: '/unregistered/sentinel',
        ...output.io,
      });
      expect(exitCode).toBe(0);
      expect(JSON.parse(output.stdout()).scope).toEqual({ mode: 'global' });
    }

    const output = capture();
    expect(await runCli(['status', 'workspace-1', '--json'], {
      dataSource: source(),
      cwd: '/unregistered/sentinel',
      ...output.io,
    })).toBe(0);
    expect(JSON.parse(output.stdout()).scope).toEqual({ mode: 'local', workspaceId: 'workspace-1' });
  });

  test('rejects unknown top-level words with deterministic usage exit code', async () => {
    const output = capture();
    const exitCode = await runCli(['dev'], {
      dataSource: source(),
      cwd: '/registered/demo',
      ...output.io,
    });

    expect(exitCode).toBe(2);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain("unknown command 'dev'");
  });

  test('renders Commander usage failures as one JSON envelope when requested before or after the command', async () => {
    const cases = [
      { argv: ['status', '--json', '--bogus'], command: 'status', commanderCode: 'commander.unknownOption' },
      { argv: ['--json', 'status', '--bogus'], command: 'status', commanderCode: 'commander.unknownOption' },
      { argv: ['--json', 'dev'], command: 'dev', commanderCode: 'commander.unknownCommand' },
    ] as const;

    for (const testCase of cases) {
      const output = capture();
      const exitCode = await runCli(testCase.argv, {
        dataSource: source(),
        cwd: '/registered/demo',
        ...output.io,
      });

      expect(exitCode).toBe(2);
      expect(output.stderr()).toBe('');
      expect(output.stdout().trim().split('\n')).toHaveLength(1);
      const envelope = JSON.parse(output.stdout());
      expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
      expect(envelope.ok).toBe(false);
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.command).toBe(testCase.command);
      expect(envelope.errors).toEqual([{
        code: 'WTM_CONFIG_INVALID',
        message: 'Invalid command-line usage.',
        severity: 'error',
        context: { commanderCode: testCase.commanderCode },
      }]);
    }
  });

  test('stops JSON intent scanning at the standalone option terminator', async () => {
    const human = capture();
    const humanExit = await runCli(['status', '--', '--json', 'extra'], {
      dataSource: source(),
      cwd: '/registered/demo',
      ...human.io,
    });

    expect(humanExit).toBe(2);
    expect(human.stdout()).toBe('');
    expect(human.stderr()).toContain('too many arguments');

    const json = capture();
    const jsonExit = await runCli(['status', '--json', '--', 'one', 'two'], {
      dataSource: source(),
      cwd: '/registered/demo',
      ...json.io,
    });

    expect(jsonExit).toBe(2);
    expect(json.stderr()).toBe('');
    const envelope = JSON.parse(json.stdout());
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.errors[0].code).toBe('WTM_CONFIG_INVALID');
  });

  test('maps invalid registered-workspace provider output to protocol exit class 5', async () => {
    const output = capture();
    const dataSource = source();
    dataSource.listRegisteredWorkspaces = async () => [{ ...workspace, id: '' }];

    const exitCode = await runCli(['status', '--json'], {
      dataSource,
      cwd: '/registered/demo',
      ...output.io,
    });

    expect(exitCode).toBe(5);
    const envelope = JSON.parse(output.stdout());
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.errors[0].code).toBe('ADAPTER_INVALID_RESPONSE');
  });

  test('returns a deterministic config exit code without calling process.exit', async () => {
    const output = capture();
    const dataSource = source();
    dataSource.readStatus = async () => {
      throw new DiagnosticSourceError({
        code: 'WTM_CONFIG_INVALID',
        message: 'Bad configuration.',
        severity: 'error',
      });
    };

    const exitCode = await runCli(['status', '--json'], {
      dataSource,
      cwd: '/registered/demo',
      ...output.io,
    });

    expect(exitCode).toBe(2);
    const envelope = JSON.parse(output.stdout());
    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0].code).toBe('WTM_CONFIG_INVALID');
  });

  test('wires adapter trust through the CLI with an injected SQLite database path', async () => {
    const adapter = await createFakeAdapter({ type: 'response', response: {} });
    const output = capture();
    const trust = createAdapterTrustStore();
    try {
      const exitCode = await runCli(['adapter', 'trust', 'fake', adapter.executablePath, '--json'], {
        cwd: adapter.root,
        adapterDatabasePath: join(adapter.root, 'state', 'state.db'),
        adapterTrustStore: trust,
        ...output.io,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(output.stdout())).toMatchObject({
        ok: true,
        command: 'adapter trust',
        data: { adapterId: 'fake', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      });
      expect(trust.list()).toHaveLength(1);
    } finally {
      await adapter.cleanup();
    }
  });

  test('exec returns the foreground child exit status without using a shell or process.exit', async () => {
    const output = capture();
    const seen: unknown[] = [];
    const runtimeClient = {
      request: async (_command: string, args?: unknown) => {
        seen.push(args);
        return {
          schemaVersion: 1 as const,
          ok: true as const,
          command: 'exec',
          data: { argv: ['node', '-e', 'process.exit(7)'], cwd: '/registered/demo', envDelta: {} },
          warnings: [],
          errors: [],
        };
      },
    };
    const executions: unknown[] = [];

    const exitCode = await runCli(['exec', '--json', '--', 'node', '-e', 'process.exit(7)'], {
      cwd: '/registered/demo',
      runtimeClient,
      execForeground: async (input) => { executions.push(input); return { exitCode: 7, signal: null }; },
      ...output.io,
    });

    expect(exitCode).toBe(7);
    expect(seen).toEqual([{ cwd: '/registered/demo', argv: ['node', '-e', 'process.exit(7)'] }]);
    expect(executions).toEqual([{
      argv: ['node', '-e', 'process.exit(7)'], cwd: '/registered/demo', envDelta: {}, shell: false,
    }]);
    expect(JSON.parse(output.stdout()).errors[0].context.exitCode).toBe(7);
  });

  test('exec maps signal termination to the conventional 128 plus signal number status', async () => {
    const output = capture();
    const runtimeClient = {
      request: async () => ({
        schemaVersion: 1 as const,
        ok: true as const,
        command: 'exec',
        data: { argv: ['node'], cwd: '/registered/demo', envDelta: {} },
        warnings: [],
        errors: [],
      }),
    };

    const exitCode = await runCli(['exec', '--json', '--', 'node'], {
      cwd: '/registered/demo',
      runtimeClient,
      execForeground: async () => ({ exitCode: 1, signal: 'SIGTERM' }),
      ...output.io,
    });

    expect(exitCode).toBe(143);
  });
});

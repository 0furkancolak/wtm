import { describe, expect, test } from 'bun:test';
import { jsonEnvelopeSchema } from '@wtm/protocol';
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
  test('exposes the six diagnostic commands plus explicit runtime commands', () => {
    const cli = createCli({ dataSource: source(), cwd: '/registered/demo' });

    expect(cli.commands.map((command) => command.name())).toEqual([
      'status', 'doctor', 'explain', 'plan', 'env', 'ports',
      'start', 'stop', 'restart', 'ps', 'logs', 'exec',
    ]);
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

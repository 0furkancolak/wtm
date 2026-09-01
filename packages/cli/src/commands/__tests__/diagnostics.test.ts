import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonRegistrationError } from '@wtm/daemon';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import {
  DiagnosticSourceError,
  doctorChecks,
  runDoctorCommand,
  runEnvCommand,
  runExplainCommand,
  runPlanCommand,
  runPortsCommand,
  runStatusCommand,
  type DiagnosticDataSource,
  type RegisteredWorkspace,
} from '../../diagnostics';
import { runCli } from '../../main';
import { renderEnvelope } from '../../output';

const workspace: RegisteredWorkspace = {
  id: 'workspace-1',
  name: 'demo',
  root: '/registered/demo',
  scope: 'local',
};

function source(overrides: Partial<DiagnosticDataSource> = {}): DiagnosticDataSource {
  return {
    listRegisteredWorkspaces: async () => [workspace],
    readStatus: async () => ({
      workspace,
      identity: {
        repositoryId: 'repository-1',
        worktreeId: 'worktree-7',
        numericId: 7,
        path: '/registered/demo',
        branch: 'feat/diagnostics',
        headOid: '0123456789abcdef',
        isMain: false,
      },
      state: 'READY',
      endpoints: [{
        id: 'lease-1',
        worktreeId: 'worktree-7',
        name: 'web',
        protocol: 'tcp',
        host: '127.0.0.1',
        port: 24007,
        state: 'ACTIVE',
        allocatedAt: '2026-08-27T08:00:00.000Z',
        lastVerifiedAt: '2026-08-27T08:01:00.000Z',
      }],
      processes: [],
      resources: [],
    }),
    readDoctor: async () => ({
      workspace,
      findings: [
        { check: 'git', status: 'pass', message: 'Git repository is readable.' },
        { check: 'config', status: 'pass', message: 'Configuration is valid.' },
        { check: 'adapters', status: 'unknown', message: 'No adapter diagnostics are available.' },
        { check: 'resources', status: 'unknown', message: 'No resource diagnostics are available.' },
        { check: 'ports', status: 'pass', message: 'Endpoint lease is active.' },
        { check: 'process-records', status: 'unknown', message: 'No process records are available.' },
      ],
    }),
    readExplain: async () => ({
      workspace,
      decisions: [{
        kind: 'config',
        key: 'ports.range',
        value: '20000-50000',
        provenance: { source: 'built-in' },
        reason: 'Highest-precedence resolved value.',
      }],
    }),
    readPlan: async () => ({
      workspace,
      changes: [{
        kind: 'endpoint',
        action: 'create',
        target: 'web',
        reason: 'The desired endpoint has no active lease.',
      }],
    }),
    readEnv: async () => ({
      workspace,
      variables: { PORT: '24007', WTM_WORKTREE_ID: '7' },
    }),
    readPorts: async () => ({
      workspace,
      leases: [{
        id: 'lease-1',
        worktreeId: 'worktree-7',
        name: 'web',
        protocol: 'tcp',
        host: '127.0.0.1',
        port: 24007,
        state: 'ACTIVE',
        allocatedAt: '2026-08-27T08:00:00.000Z',
        lastVerifiedAt: '2026-08-27T08:01:00.000Z',
      }],
    }),
    ...overrides,
  };
}

describe('diagnostic command envelopes', () => {
  test('status returns a schema-valid literal success envelope', async () => {
    const envelope = await runStatusCommand({ cwd: '/registered/demo/src' }, source());

    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'status',
      scope: { mode: 'local', workspaceId: 'workspace-1' },
      data: {
        workspaces: [{
          workspace,
          identity: {
            repositoryId: 'repository-1',
            worktreeId: 'worktree-7',
            numericId: 7,
            path: '/registered/demo',
            branch: 'feat/diagnostics',
            headOid: '0123456789abcdef',
            isMain: false,
          },
          state: 'READY',
          endpoints: [{
            id: 'lease-1',
            worktreeId: 'worktree-7',
            name: 'web',
            protocol: 'tcp',
            host: '127.0.0.1',
            port: 24007,
            state: 'ACTIVE',
            allocatedAt: '2026-08-27T08:00:00.000Z',
            lastVerifiedAt: '2026-08-27T08:01:00.000Z',
          }],
          processes: [],
          resources: [],
        }],
      },
      warnings: [],
      errors: [],
    });
  });

  test('failure has a nonempty stable error list and schema version', async () => {
    const failure = new DiagnosticSourceError({
      code: 'WTM_CONFIG_INVALID',
      message: 'Configuration cannot be parsed.',
      severity: 'error',
      context: { source: '/registered/demo/wtm.toml' },
    });
    const envelope = await runStatusCommand({ cwd: '/registered/demo' }, source({
      readStatus: async () => { throw failure; },
    }));

    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'status',
      scope: { mode: 'local', workspaceId: 'workspace-1' },
      data: { workspaces: [] },
      warnings: [],
      errors: [{
        code: 'WTM_CONFIG_INVALID',
        message: 'Configuration cannot be parsed.',
        severity: 'error',
        context: {
          command: 'status',
          source: '/registered/demo/wtm.toml',
          workspaceId: 'workspace-1',
        },
      }],
    });
  });

  test('rejects combining a selector with global scope', async () => {
    const envelope = await runStatusCommand({
      cwd: '/registered/demo',
      selector: 'workspace-1',
      global: true,
    }, source());

    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.ok).toBe(false);
    expect(envelope.scope).toEqual({ mode: 'global' });
    expect(envelope.errors[0]).toEqual({
      code: 'WTM_CONFIG_INVALID',
      message: 'A workspace selector cannot be combined with global scope.',
      severity: 'error',
      context: { command: 'status', selector: 'workspace-1' },
    });
  });

  test('resolves a relative workspace selector from the injected cwd', async () => {
    const selected = { ...workspace, name: 'project' };
    const envelope = await runStatusCommand({ cwd: '/registered', selector: './demo' }, source({
      listRegisteredWorkspaces: async () => [selected],
      readStatus: async () => ({
        workspace: selected,
        identity: {
          repositoryId: null,
          worktreeId: null,
          numericId: null,
          path: selected.root,
          branch: null,
          headOid: null,
          isMain: true,
        },
        state: 'UNKNOWN',
        endpoints: [],
        processes: [],
        resources: [],
      }),
    }));

    expect(envelope.ok).toBe(true);
    expect(envelope.scope).toEqual({ mode: 'local', workspaceId: 'workspace-1' });
  });

  test('resolves path selectors inside the most specific containing registered root', async () => {
    const outer = { ...workspace, id: 'workspace-outer', name: 'outer', root: '/tmp/../registered' };
    const nested = { ...workspace, id: 'workspace-nested', name: 'nested', root: '/registered/demo' };
    const received: string[] = [];
    const dataSource = source({
      listRegisteredWorkspaces: async () => [outer, nested],
      readStatus: async (registered) => {
        received.push(registered.id);
        return {
          workspace: registered,
          identity: {
            repositoryId: null,
            worktreeId: null,
            numericId: null,
            path: registered.root,
            branch: null,
            headOid: null,
            isMain: true,
          },
          state: 'UNKNOWN',
          endpoints: [],
          processes: [],
          resources: [],
        };
      },
    });

    const absolute = await runStatusCommand({
      cwd: '/outside',
      selector: '/registered/demo/src',
    }, dataSource);
    const relative = await runStatusCommand({
      cwd: '/registered/demo',
      selector: './src',
    }, dataSource);

    expect(absolute.scope).toEqual({ mode: 'local', workspaceId: 'workspace-nested' });
    expect(relative.scope).toEqual({ mode: 'local', workspaceId: 'workspace-nested' });
    expect(received).toEqual(['workspace-nested', 'workspace-nested']);
  });

  test('does not use string-prefix containment for path selectors', async () => {
    const app = { ...workspace, root: '/registered/app' };
    const envelope = await runStatusCommand({
      cwd: '/outside',
      selector: '/registered/app2/src',
    }, source({ listRegisteredWorkspaces: async () => [app] }));

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe('WTM_WORKSPACE_NOT_FOUND');
  });

  test('all diagnostic cores expose schema-valid command-specific data', async () => {
    const input = { cwd: '/registered/demo' };
    const dataSource = source();
    const envelopes = await Promise.all([
      runDoctorCommand(input, dataSource),
      runExplainCommand(input, dataSource),
      runPlanCommand(input, dataSource),
      runEnvCommand(input, dataSource),
      runPortsCommand(input, dataSource),
    ]);

    expect(envelopes.map((envelope) => jsonEnvelopeSchema.parse(envelope).command)).toEqual([
      'doctor', 'explain', 'plan', 'env', 'ports',
    ]);
    expect(envelopes.map((envelope) => envelope.data.workspaces.length)).toEqual([1, 1, 1, 1, 1]);
    expect(envelopes[0]?.data.workspaces[0]).toEqual({
      workspace,
      findings: [
        { check: 'registration', status: 'unknown', message: 'Registration diagnostics are unavailable.' },
        { check: 'git', status: 'pass', message: 'Git repository is readable.' },
        { check: 'config', status: 'pass', message: 'Configuration is valid.' },
        { check: 'adapters', status: 'unknown', message: 'No adapter diagnostics are available.' },
        { check: 'resources', status: 'unknown', message: 'No resource diagnostics are available.' },
        { check: 'ports', status: 'pass', message: 'Endpoint lease is active.' },
        { check: 'process-records', status: 'unknown', message: 'No process records are available.' },
        { check: 'platform', status: 'unknown', message: 'Platform diagnostics are unavailable.' },
        { check: 'socket-path', status: 'unknown', message: 'Socket path diagnostics are unavailable.' },
      ],
    });
    expect(envelopes[4]?.data.workspaces[0]).toEqual({
      workspace,
      leases: [{
        id: 'lease-1',
        worktreeId: 'worktree-7',
        name: 'web',
        protocol: 'tcp',
        host: '127.0.0.1',
        port: 24007,
        state: 'ACTIVE',
        allocatedAt: '2026-08-27T08:00:00.000Z',
        lastVerifiedAt: '2026-08-27T08:01:00.000Z',
      }],
    });
  });

  test('human and JSON rendering consume the same core envelope data', async () => {
    const envelope = await runEnvCommand({ cwd: '/registered/demo' }, source());
    const json = renderEnvelope(envelope, { json: true });
    const human = renderEnvelope(envelope, { json: false });

    expect(jsonEnvelopeSchema.parse(JSON.parse(json))).toEqual(envelope);
    expect(human).toContain('env: ok');
    expect(human).toContain('PORT: 24007');
    expect(human).toContain('WTM_WORKTREE_ID: 7');
  });

  test('doctor reports every unavailable subsystem as explicitly unknown', async () => {
    const envelope = await runDoctorCommand({ cwd: '/registered/demo' }, source({
      readDoctor: async () => ({ workspace, findings: [] }),
    }));

    // A check declared but left out of the back-fill list vanishes from the report rather than
    // saying it is unknown, which reads exactly like a check that passed.
    expect(envelope.data.workspaces[0]?.findings.map(({ check }) => check)).toEqual([...doctorChecks]);
    expect(envelope.data.workspaces[0]?.findings).toEqual([
      { check: 'registration', status: 'unknown', message: 'Registration diagnostics are unavailable.' },
      { check: 'git', status: 'unknown', message: 'Git diagnostics are unavailable.' },
      { check: 'config', status: 'unknown', message: 'Config diagnostics are unavailable.' },
      { check: 'adapters', status: 'unknown', message: 'Adapter diagnostics are unavailable.' },
      { check: 'resources', status: 'unknown', message: 'Resource diagnostics are unavailable.' },
      { check: 'ports', status: 'unknown', message: 'Port diagnostics are unavailable.' },
      { check: 'process-records', status: 'unknown', message: 'Process record diagnostics are unavailable.' },
      { check: 'platform', status: 'unknown', message: 'Platform diagnostics are unavailable.' },
      { check: 'socket-path', status: 'unknown', message: 'Socket path diagnostics are unavailable.' },
    ]);
  });

  test('rejects invalid diagnostic JSON before exposing it', async () => {
    const invalid = {
      workspace,
      decisions: [{
        kind: 'adapter',
        key: 'node',
        value: undefined,
        provenance: { source: 'adapter-response' },
        reason: 'Invalid undefined JSON value.',
      }],
    };
    const envelope = await runExplainCommand({ cwd: '/registered/demo' }, source({
      readExplain: async () => invalid as never,
    }));

    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toEqual({ workspaces: [] });
    expect(envelope.errors[0]?.code).toBe('ADAPTER_INVALID_RESPONSE');
  });

  test('keeps error context JSON-safe without losing valid evidence', async () => {
    const secret = 'EXPLICIT-SECRET-BYTE-2471';
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const deepRoot = deep;
    for (let index = 0; index < 20; index += 1) {
      const child: Record<string, unknown> = {};
      deep.next = child;
      deep = child;
    }
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field-${index}`, index]));
    const envelope = await runStatusCommand({ cwd: '/registered/demo' }, source({
      readStatus: async () => {
        throw new DiagnosticSourceError({
          code: 'GIT_REPOSITORY_DEGRADED',
          message: 'State record is degraded.',
          severity: 'error',
          context: {
            repositoryId: 'repository-1',
            apiKey: secret,
            cyclic,
            deep: deepRoot,
            wide,
            impossible: 1n,
          },
        } as never);
      },
    }));

    const context = JSON.parse(renderEnvelope(envelope, { json: true })).errors[0].context;
    expect(context.repositoryId).toBe('repository-1');
    expect(context.apiKey).toBe('[REDACTED]');
    expect(context.cyclic.self).toBe('[Circular]');
    expect(context.deep.next.next.next.next.next).toBe('[Truncated]');
    expect(Object.keys(context.wide)).toHaveLength(33);
    expect(JSON.stringify(context)).not.toContain(secret);
    expect(context.command).toBe('status');
    expect(context.workspaceId).toBe('workspace-1');
    expect(context.impossible).toBeUndefined();
  });

  test('isolates trusted diagnostic evidence from input and exposed-view mutation', async () => {
    const secret = 'MUTATION-SECRET-BYTE-6197';
    const original = {
      code: 'GIT_REPOSITORY_DEGRADED' as const,
      message: 'Safe typed failure.',
      severity: 'error' as const,
      context: { repositoryId: 'repository-safe' },
      remediation: [{
        kind: 'command-suggestion' as const,
        argv: ['git', 'status'],
      }],
    };
    const error = new DiagnosticSourceError(original);

    original.message = secret;
    original.context.repositoryId = secret;
    original.remediation[0]!.argv[1] = secret;
    const cyclic: Record<string, unknown> = { apiKey: secret, impossible: 1n };
    cyclic.self = cyclic;
    try {
      const exposed = error.item as unknown as Record<string, unknown>;
      exposed.code = 'WTM_CONFIG_INVALID';
      exposed.message = secret;
      exposed.context = cyclic;
    } catch {
      // A frozen defensive view may reject mutation.
    }

    const envelope = await runStatusCommand({ cwd: '/registered/demo' }, source({
      readStatus: async () => { throw error; },
    }));
    const json = JSON.stringify(envelope);

    expect(jsonEnvelopeSchema.parse(JSON.parse(json))).toEqual(envelope);
    expect(json).not.toContain(secret);
    expect(envelope.errors[0]).toEqual({
      code: 'GIT_REPOSITORY_DEGRADED',
      message: 'Safe typed failure.',
      severity: 'error',
      context: {
        repositoryId: 'repository-safe',
        command: 'status',
        workspaceId: 'workspace-1',
      },
      remediation: [{ kind: 'command-suggestion', argv: ['git', 'status'] }],
    });
  });

  test('redacts untrusted secrets and totally sanitizes cyclic, deep, and wide errors', async () => {
    const secret = 'TOP-SECRET-BYTE-9381';
    const cyclic: Record<string, unknown> = { safe: 'visible' };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const deepRoot = deep;
    for (let index = 0; index < 100; index += 1) {
      const child: Record<string, unknown> = {};
      deep.next = child;
      deep = child;
    }
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field-${index}`, index]));
    const envelope = await runStatusCommand({ cwd: '/registered/demo' }, source({
      readStatus: async () => {
        throw Object.assign(new Error(`provider failed with ${secret}`), {
          code: 'WTM_CONFIG_INVALID',
          context: {
            safe: 'visible',
            API_KEY: secret,
            Password: secret,
            authToken: secret,
            cookie: secret,
            cyclic,
            deep: deepRoot,
            wide,
            bigint: 1n,
            symbol: Symbol(secret),
            callback: () => secret,
          },
        });
      },
    }));

    const json = JSON.stringify(envelope);
    expect(jsonEnvelopeSchema.parse(JSON.parse(json))).toEqual(envelope);
    expect(json).not.toContain(secret);
    expect(envelope.errors[0]).toEqual({
      code: 'GIT_REPOSITORY_DEGRADED',
      message: 'Diagnostic data source failed.',
      severity: 'error',
      context: { command: 'status', workspaceId: 'workspace-1' },
    });
  });

  test('classifies malformed registered-workspace lists as invalid provider responses', async () => {
    const envelope = await runStatusCommand({ cwd: '/registered/demo' }, source({
      listRegisteredWorkspaces: async () => [{ ...workspace, root: '' }],
    }));

    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe('ADAPTER_INVALID_RESPONSE');
    expect(envelope.errors[0]?.message).toBe('Diagnostic data source returned an invalid response.');
  });

  test('rejects a diagnostic response whose registered identity differs beyond ID', async () => {
    const envelope = await runPortsCommand({ cwd: '/registered/demo' }, source({
      readPorts: async () => ({
        workspace: { ...workspace, name: 'spoofed', root: '/other/root', scope: 'global-only' },
        leases: [],
      }),
    }));

    expect(envelope.ok).toBe(false);
    expect(envelope.data).toEqual({ workspaces: [] });
    expect(envelope.errors[0]?.code).toBe('ADAPTER_INVALID_RESPONSE');
  });

  test('uses locale-independent code-unit order for machine-contract collections', async () => {
    const omega = { ...workspace, id: 'workspace-Ω', name: 'omega', root: '/registered/omega' };
    const umlaut = { ...workspace, id: 'workspace-ä', name: 'umlaut', root: '/registered/umlaut' };
    const ascii = { ...workspace, id: 'workspace-z', name: 'ascii', root: '/registered/ascii' };
    const received: string[] = [];
    const dataSource = source({
      listRegisteredWorkspaces: async () => [omega, umlaut, ascii],
      readEnv: async (registered) => {
        received.push(registered.id);
        return {
          workspace: registered,
          variables: { 'Ω': 'omega', 'ä': 'umlaut', z: 'ascii' },
        };
      },
    });

    const envelope = await runEnvCommand({ cwd: '/outside', global: true }, dataSource);

    expect(received).toEqual(['workspace-z', 'workspace-ä', 'workspace-Ω']);
    expect(envelope.data.workspaces.map((item) => Object.keys(item.variables))).toEqual([
      ['z', 'ä', 'Ω'],
      ['z', 'ä', 'Ω'],
      ['z', 'ä', 'Ω'],
    ]);
  });

  test('global mode reads only registered workspace records and isolates failures', async () => {
    const first = { ...workspace, id: 'workspace-b', name: 'bravo', root: '/registered/bravo' };
    const second = { ...workspace, id: 'workspace-a', name: 'alpha', root: '/registered/alpha' };
    const received: string[] = [];
    const dataSource = source({
      listRegisteredWorkspaces: async () => [first, second],
      readPorts: async (registered) => {
        received.push(registered.id);
        if (registered.id === 'workspace-b') {
          throw new DiagnosticSourceError({
            code: 'GIT_REPOSITORY_DEGRADED',
            message: 'Lease table is degraded.',
            severity: 'error',
          });
        }
        return { workspace: registered, leases: [] };
      },
    });

    const sentinel = await mkdtemp(join(tmpdir(), 'wtm-unregistered-'));
    try {
      await mkdir(join(sentinel, '.git'));
      await writeFile(join(sentinel, 'wtm.toml'), '[workspace]\nname = "must-not-be-scanned"\n');
      const envelope = await runPortsCommand({ cwd: sentinel, global: true }, dataSource);

      expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
      expect(received).toEqual(['workspace-a', 'workspace-b']);
      expect(envelope.data).toEqual({ workspaces: [{ workspace: second, leases: [] }] });
      expect(envelope.errors).toEqual([{
        code: 'GIT_REPOSITORY_DEGRADED',
        message: 'Lease table is degraded.',
        severity: 'error',
        context: { command: 'ports', workspaceId: 'workspace-b' },
      }]);
    } finally {
      await rm(sentinel, { recursive: true, force: true });
    }
  });
});

describe('coded errors keep their identity through the envelope', () => {
  test('a DaemonRegistrationError reaches env as WTM_WORKSPACE_NOT_FOUND, with its own message', async () => {
    // The daemon already decides that this directory is in no registered worktree, and already
    // says what to do about it. Flattening that to `GIT_REPOSITORY_DEGRADED` / "Diagnostic data
    // source failed." threw away the code, the sentence, and the exit code all at once.
    const envelope = await runEnvCommand({ cwd: '/registered/demo' }, source({
      readEnv: async () => {
        throw new DaemonRegistrationError(
          'This directory is not inside a worktree WTM has registered. Run `wtm init` in the workspace root.',
        );
      },
    }));

    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.errors[0]).toEqual({
      code: 'WTM_WORKSPACE_NOT_FOUND',
      message: 'This directory is not inside a worktree WTM has registered. Run `wtm init` in the workspace root.',
      severity: 'error',
      context: { command: 'env', workspaceId: 'workspace-1' },
    });
  });

  test('`wtm env` in an unregistered worktree exits 2', async () => {
    let stdout = '';
    const exitCode = await runCli(['env', '--json'], {
      cwd: '/registered/demo',
      stdout: (value) => { stdout += value; },
      stderr: () => {},
      dataSource: source({
        readEnv: async () => {
          throw new DaemonRegistrationError(
            'This directory is not inside a worktree WTM has registered. Run `wtm init` in the workspace root.',
          );
        },
      }),
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout).errors[0].code).toBe('WTM_WORKSPACE_NOT_FOUND');
    expect(JSON.parse(stdout).errors[0].message).toContain('wtm init');
  });

  test('keeps a coded error\'s remediation and sanitizes its context', async () => {
    const secret = 'CODED-CONTEXT-SECRET-4412';
    const envelope = await runStatusCommand({ cwd: '/registered/demo' }, source({
      readStatus: async () => {
        throw Object.assign(new Error('The WTM daemon socket path is too long.'), {
          code: 'WTM_SOCKET_PATH_TOO_LONG',
          severity: 'error',
          context: { byteLength: 118, apiKey: secret },
          remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }],
        });
      },
    }));

    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(envelope.errors[0]).toEqual({
      code: 'WTM_SOCKET_PATH_TOO_LONG',
      message: 'The WTM daemon socket path is too long.',
      severity: 'error',
      context: {
        apiKey: '[REDACTED]',
        byteLength: 118,
        command: 'status',
        workspaceId: 'workspace-1',
      },
      remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }],
    });
  });

  test('an error carrying a code but no severity is not self-describing', async () => {
    // `code` alone is what Node puts on every `ErrnoException`; it is not a claim to be a WTM
    // error. Letting it through is how an arbitrary exception's message becomes contract text.
    const envelope = await runStatusCommand({ cwd: '/registered/demo' }, source({
      readStatus: async () => {
        throw Object.assign(new Error('internal detail nobody promised'), {
          code: 'WTM_WORKSPACE_NOT_FOUND',
        });
      },
    }));

    expect(envelope.errors[0]).toEqual({
      code: 'GIT_REPOSITORY_DEGRADED',
      message: 'Diagnostic data source failed.',
      severity: 'error',
      context: { command: 'status', workspaceId: 'workspace-1' },
    });
  });

  test('a code that is not in the schema is not trusted to be one', async () => {
    const envelope = await runStatusCommand({ cwd: '/registered/demo' }, source({
      readStatus: async () => {
        throw Object.assign(new Error('internal detail nobody promised'), {
          code: 'ENOENT',
          severity: 'error',
        });
      },
    }));

    expect(envelope.errors[0]?.code).toBe('GIT_REPOSITORY_DEGRADED');
    expect(envelope.errors[0]?.message).toBe('Diagnostic data source failed.');
  });
});

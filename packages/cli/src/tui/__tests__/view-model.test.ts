import { describe, expect, test } from 'bun:test';
import { runDoctorCommand, runStatusCommand, type DiagnosticDataSource, type RegisteredWorkspace } from '../../diagnostics';
import { buildTuiViewModel } from '../view-model';

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
        branch: 'feat/tui',
        headOid: '0123456789abcdef0123456789abcdef01234567',
        isMain: false,
      },
      state: 'RUNNING',
      endpoints: [{
        id: 'lease-1',
        worktreeId: 'worktree-7',
        name: 'web',
        protocol: 'tcp',
        host: '127.0.0.1',
        port: 24007,
        state: 'ACTIVE',
        allocatedAt: '2026-09-20T08:00:00.000Z',
        lastVerifiedAt: '2026-09-20T08:01:00.000Z',
      }],
      processes: [{
        task: 'dev',
        pid: 4242,
        state: 'running',
        startedAt: '2026-09-20T08:00:00.000Z',
        argv: [],
      }],
      resources: [],
    }),
    readDoctor: async () => ({
      workspace,
      findings: [
        { check: 'git', status: 'pass', message: 'Git repository is readable.' },
        { check: 'ports', status: 'warning', message: 'One endpoint has little headroom.' },
      ],
    }),
    readExplain: async () => { throw new Error('not used'); },
    readPlan: async () => { throw new Error('not used'); },
    readEnv: async () => { throw new Error('not used'); },
    readPorts: async () => { throw new Error('not used'); },
    ...overrides,
  };
}

const input = { cwd: '/registered/demo' };

describe('buildTuiViewModel', () => {
  test('reshapes a successful status+doctor pair into a flat view model', async () => {
    const dataSource = source();
    const statusEnvelope = await runStatusCommand(input, dataSource);
    const doctorEnvelope = await runDoctorCommand(input, dataSource);

    const model = buildTuiViewModel({ statusEnvelope, doctorEnvelope, fetchedAt: '2026-09-22T00:00:00.000Z' });

    expect(model.fetchedAt).toBe('2026-09-22T00:00:00.000Z');
    expect(model.workspace).toEqual(workspace);
    expect(model.worktree).toEqual({
      branch: 'feat/tui',
      path: '/registered/demo',
      state: 'RUNNING',
      isMain: false,
      headOid: '0123456789abcdef0123456789abcdef01234567',
      worktreeId: 'worktree-7',
      numericId: 7,
    });
    expect(model.processes).toEqual([{ task: 'dev', pid: 4242, state: 'running', startedAt: '2026-09-20T08:00:00.000Z' }]);
    expect(model.ports).toEqual([{ name: 'web', protocol: 'tcp', host: '127.0.0.1', port: 24007, state: 'ACTIVE' }]);
    // `runDoctorCommand` back-fills every check the source did not answer as `unknown`, in
    // `doctorChecks` order, so the two supplied findings arrive alongside the rest.
    expect(model.health).toEqual([
      { check: 'registration', status: 'unknown', message: 'Registration diagnostics are unavailable.' },
      { check: 'git', status: 'pass', message: 'Git repository is readable.' },
      { check: 'config', status: 'unknown', message: 'Config diagnostics are unavailable.' },
      { check: 'adapters', status: 'unknown', message: 'Adapter diagnostics are unavailable.' },
      { check: 'resources', status: 'unknown', message: 'Resource diagnostics are unavailable.' },
      { check: 'ports', status: 'warning', message: 'One endpoint has little headroom.' },
      { check: 'process-records', status: 'unknown', message: 'Process record diagnostics are unavailable.' },
      { check: 'platform', status: 'unknown', message: 'Platform diagnostics are unavailable.' },
      { check: 'socket-path', status: 'unknown', message: 'Socket path diagnostics are unavailable.' },
    ]);
    expect(model.statusErrors).toEqual([]);
    expect(model.doctorErrors).toEqual([]);
  });

  test('reports empty panels and no worktree when nothing is registered here, without throwing', async () => {
    const dataSource: DiagnosticDataSource = { ...source(), listRegisteredWorkspaces: async () => [] };
    const statusEnvelope = await runStatusCommand(input, dataSource);
    const doctorEnvelope = await runDoctorCommand(input, dataSource);

    expect(statusEnvelope.ok).toBe(false);
    const model = buildTuiViewModel({ statusEnvelope, doctorEnvelope, fetchedAt: '2026-09-22T00:00:00.000Z' });

    expect(model.workspace).toBeNull();
    expect(model.worktree).toBeNull();
    expect(model.processes).toEqual([]);
    expect(model.ports).toEqual([]);
    expect(model.health).toEqual([]);
    expect(model.statusErrors.length).toBeGreaterThan(0);
    expect(model.statusErrors[0]?.code).toBe('WTM_NOT_INITIALIZED');
    expect(model.doctorErrors.length).toBeGreaterThan(0);
  });

  test('falls back to the doctor envelope for workspace identity when status alone failed', async () => {
    const dataSource: DiagnosticDataSource = {
      ...source(),
      readStatus: async () => { throw new Error('status backend unavailable'); },
    };
    const statusEnvelope = await runStatusCommand(input, dataSource);
    const doctorEnvelope = await runDoctorCommand(input, dataSource);

    expect(statusEnvelope.ok).toBe(false);
    expect(doctorEnvelope.ok).toBe(true);
    const model = buildTuiViewModel({ statusEnvelope, doctorEnvelope, fetchedAt: '2026-09-22T00:00:00.000Z' });

    expect(model.workspace).toEqual(workspace);
    expect(model.worktree).toBeNull();
    expect(model.statusErrors.length).toBeGreaterThan(0);
    expect(model.doctorErrors).toEqual([]);
  });
});

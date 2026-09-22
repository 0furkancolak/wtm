import { describe, expect, test } from 'bun:test';
import type { WtmError } from '@wtm/protocol';
import type { TuiLogsView } from '../logs-view';
import { renderTuiFatalFrame, renderTuiFrame, renderTuiLogsFrame, type TuiPanel } from '../render';
import type { TuiViewModel } from '../view-model';

const emptyModel: TuiViewModel = {
  fetchedAt: '2026-09-22T00:00:00.000Z',
  workspace: null,
  worktree: null,
  processes: [],
  ports: [],
  health: [],
  statusErrors: [],
  doctorErrors: [],
  resources: null,
};

const filledModel: TuiViewModel = {
  fetchedAt: '2026-09-22T00:00:01.000Z',
  workspace: { id: 'workspace-1', name: 'demo', root: '/registered/demo', scope: 'local' },
  worktree: {
    branch: 'feat/tui',
    path: '/registered/demo/feat-tui',
    state: 'RUNNING',
    isMain: false,
    headOid: '0123456789abcdef0123456789abcdef01234567',
    worktreeId: 'worktree-7',
    numericId: 7,
  },
  processes: [{ task: 'dev', pid: 4242, state: 'running', startedAt: '2026-09-20T08:00:00.000Z' }],
  ports: [{ name: 'web', protocol: 'tcp', host: '127.0.0.1', port: 24007, state: 'ACTIVE' }],
  health: [
    { check: 'git', status: 'pass', message: 'Git repository is readable.' },
    { check: 'ports', status: 'warning', message: 'One endpoint has little headroom.' },
  ],
  statusErrors: [],
  doctorErrors: [],
  resources: {
    fetchedAt: '2026-09-22T00:00:00.000Z',
    disk: {
      totals: { logicalBytes: 3_145_728, allocatedBytes: 4_194_304 },
      owned: { objects: 12, logicalBytes: 1_048_576, allocatedBytes: 1_048_576 },
      unknown: { objects: 1, logicalBytes: 2_097_152, allocatedBytes: 2_097_152 },
      worktree: { objects: 3, logicalBytes: 1_048_576, allocatedBytes: 1_048_576 },
    },
    gc: {
      planned: 1,
      excluded: 2,
      items: [{ path: '/registered/demo/.resources/cache-1', outcome: 'would-delete' }],
    },
    errors: [],
  },
};

const size = { columns: 80, rows: 40 };

describe('renderTuiFrame', () => {
  test('opens with the alt-screen clear-and-home sequence', () => {
    const frame = renderTuiFrame(emptyModel, size);
    expect(frame.startsWith('\x1b[H\x1b[2J')).toBe(true);
  });

  test('shows a placeholder for every empty panel rather than nothing', () => {
    const frame = renderTuiFrame(emptyModel, size);
    expect(frame).toContain('(no registered workspace for this directory)');
    expect(frame).toContain('(no worktree resolved for this directory)');
    expect(frame).toContain('(no managed processes recorded for this worktree)');
    expect(frame).toContain('(no active endpoint leases)');
    expect(frame).toContain('(no doctor findings)');
    expect(frame).toContain('(not yet fetched — this panel refreshes less often than the rest)');
    expect(frame).toContain('q / ctrl+c quit   r refresh now');
  });

  test('renders workspace, worktree, process, port and health content', () => {
    const frame = renderTuiFrame(filledModel, size);
    expect(frame).toContain('demo  [local]');
    expect(frame).toContain('/registered/demo');
    expect(frame).toContain('feat/tui');
    expect(frame).toContain('state=RUNNING');
    expect(frame).toContain('dev');
    expect(frame).toContain('pid=4242');
    expect(frame).toContain('127.0.0.1:24007/tcp');
    expect(frame).toContain('[ok]');
    expect(frame).toContain('[!!]');
    expect(frame).toContain('refreshed 2026-09-22T00:00:01.000Z');
  });

  test('renders disk totals and gc dry-run candidates', () => {
    const frame = renderTuiFrame(filledModel, size);
    expect(frame).toContain('disk total');
    expect(frame).toContain('3.0 MB logical');
    expect(frame).toContain('4.0 MB allocated');
    expect(frame).toContain('gc dry-run   1 candidate, 2 excluded');
    expect(frame).toContain('would-delete');
    expect(frame).toContain('/registered/demo/.resources/cache-1');
    expect(frame).toContain('resources refreshed 2026-09-22T00:00:00.000Z');
  });

  test('is honest about empty gc evidence instead of implying a clean sweep', () => {
    const model: TuiViewModel = {
      ...filledModel,
      resources: { ...filledModel.resources!, gc: { planned: 0, excluded: 0, items: [] } },
    };
    const frame = renderTuiFrame(model, size);
    expect(frame).toContain('no ephemeral-storage GC evidence recorded yet');
  });

  test('reports resource-lifecycle unavailability instead of a blank section', () => {
    const model: TuiViewModel = {
      ...emptyModel,
      resources: {
        fetchedAt: '2026-09-22T00:00:00.000Z',
        disk: null,
        gc: null,
        errors: [{ code: 'WTM_NOT_INITIALIZED', message: 'Resource lifecycle state is unavailable.', severity: 'error' }],
      },
    };
    const frame = renderTuiFrame(model, size);
    expect(frame).toContain('disk: (resource lifecycle state unavailable)');
    expect(frame).toContain('gc: (resource lifecycle state unavailable)');
    expect(frame).toContain('[WTM_NOT_INITIALIZED] Resource lifecycle state is unavailable.');
  });

  test('surfaces envelope-level errors from either command', () => {
    const errors: WtmError[] = [{ code: 'WTM_DAEMON_UNAVAILABLE', message: 'The daemon is not answering.', severity: 'error' }];
    const model: TuiViewModel = { ...emptyModel, statusErrors: errors };
    const frame = renderTuiFrame(model, size);
    expect(frame).toContain('== Errors ==');
    expect(frame).toContain('[WTM_DAEMON_UNAVAILABLE] The daemon is not answering.');
  });

  test('clips a line wider than the terminal instead of wrapping it', () => {
    const wide: TuiPanel = { id: 'wide', title: 'Wide', lines: () => ['x'.repeat(200)] };
    const frame = renderTuiFrame(emptyModel, { columns: 40, rows: 40 }, [wide]);
    const contentLine = frame.split('\r\n').find((line) => line.startsWith('x'));
    expect(contentLine).toBeDefined();
    expect(contentLine?.length).toBe(40);
    expect(contentLine?.endsWith('…')).toBe(true);
  });

  test('truncates to the given row count rather than overflowing the terminal', () => {
    const many: TuiPanel = { id: 'many', title: 'Many', lines: () => Array.from({ length: 50 }, (_, index) => `line-${index}`) };
    const frame = renderTuiFrame(emptyModel, { columns: 80, rows: 10 }, [many]);
    const lines = frame.slice('\x1b[H\x1b[2J'.length).split('\r\n');
    expect(lines.length).toBe(10);
  });

  test('is deterministic for the same model and size', () => {
    expect(renderTuiFrame(filledModel, size)).toBe(renderTuiFrame(filledModel, size));
  });
});

describe('renderTuiFatalFrame', () => {
  test('reports the failure message and keeps the quit/refresh hint', () => {
    const frame = renderTuiFatalFrame('socket ECONNREFUSED', size);
    expect(frame.startsWith('\x1b[H\x1b[2J')).toBe(true);
    expect(frame).toContain('wtm tui — refresh failed');
    expect(frame).toContain('socket ECONNREFUSED');
    expect(frame).toContain('q / ctrl+c quit   r refresh now');
  });
});

describe('renderTuiLogsFrame', () => {
  const logsView: TuiLogsView = {
    fetchedAt: '2026-09-22T00:00:02.000Z',
    entries: [
      { processId: 'process-1', taskName: 'dev', stdoutLines: ['booted on :24007'], stderrLines: [] },
      { processId: 'process-2', taskName: 'web', stdoutLines: [], stderrLines: ['warn: slow start'] },
    ],
    truncated: false,
    errors: [],
  };

  test('opens with the alt-screen clear-and-home sequence', () => {
    expect(renderTuiLogsFrame(logsView, size).startsWith('\x1b[H\x1b[2J')).toBe(true);
  });

  test('stacks every task\'s stdout and stderr', () => {
    const frame = renderTuiLogsFrame(logsView, size);
    expect(frame).toContain('== dev (process-1) ==');
    expect(frame).toContain('booted on :24007');
    expect(frame).toContain('== web (process-2) ==');
    expect(frame).toContain('warn: slow start');
    expect(frame).toContain('refreshed 2026-09-22T00:00:02.000Z');
    expect(frame).toContain('l / esc back to dashboard   r refresh now   q / ctrl+c quit');
  });

  test('shows a placeholder rather than nothing when no tasks have recorded logs', () => {
    const frame = renderTuiLogsFrame({ ...logsView, entries: [] }, size);
    expect(frame).toContain('(no managed processes with recorded logs for this worktree)');
  });

  test('shows a fetching placeholder before the first fetch completes', () => {
    const frame = renderTuiLogsFrame(null, size);
    expect(frame).toContain('(fetching logs…)');
  });

  test('says the view is unavailable rather than pretending to fetch when readLogs is not wired in', () => {
    const frame = renderTuiLogsFrame(null, size, { available: false });
    expect(frame).toContain('(log tail is not available in this session)');
  });

  test('surfaces envelope-level errors', () => {
    const errors: WtmError[] = [{ code: 'WTM_DAEMON_UNAVAILABLE', message: 'WTM daemon is unavailable.', severity: 'error' }];
    const frame = renderTuiLogsFrame({ ...logsView, errors }, size);
    expect(frame).toContain('== Errors ==');
    expect(frame).toContain('[WTM_DAEMON_UNAVAILABLE] WTM daemon is unavailable.');
  });

  test('notes truncation instead of silently showing a partial tail', () => {
    const frame = renderTuiLogsFrame({ ...logsView, truncated: true }, size);
    expect(frame).toContain('(log output truncated to fit the response budget)');
  });
});

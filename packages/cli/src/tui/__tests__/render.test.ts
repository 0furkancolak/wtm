import { describe, expect, test } from 'bun:test';
import type { WtmError } from '@wtm/protocol';
import { renderTuiFatalFrame, renderTuiFrame, type TuiPanel } from '../render';
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

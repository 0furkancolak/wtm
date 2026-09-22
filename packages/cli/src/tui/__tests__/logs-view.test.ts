import { describe, expect, test } from 'bun:test';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import { buildTuiLogsView } from '../logs-view';

function logsEnvelope(data: unknown, errors: WtmError[] = []): JsonEnvelope<unknown> {
  return errors.length === 0
    ? { schemaVersion: 1, ok: true, command: 'logs', data, warnings: [], errors: [] }
    : { schemaVersion: 1, ok: false, command: 'logs', data, warnings: [], errors: errors as [WtmError, ...WtmError[]] };
}

describe('buildTuiLogsView', () => {
  test('reshapes a successful multi-task logs response', () => {
    const view = buildTuiLogsView(logsEnvelope({
      logs: [
        { processId: 'process-1', taskName: 'dev', stdout: 'line one\nline two\n', stderr: '' },
        { processId: 'process-2', taskName: 'web', stdout: 'booting\n', stderr: 'warn: slow start\n' },
      ],
    }), '2026-09-22T00:00:00.000Z');

    expect(view.fetchedAt).toBe('2026-09-22T00:00:00.000Z');
    expect(view.entries).toEqual([
      { processId: 'process-1', taskName: 'dev', stdoutLines: ['line one', 'line two'], stderrLines: [] },
      { processId: 'process-2', taskName: 'web', stdoutLines: ['booting'], stderrLines: ['warn: slow start'] },
    ]);
    expect(view.truncated).toBe(false);
    expect(view.errors).toEqual([]);
  });

  test('drops the trailing blank line a final newline leaves, without dropping real blank lines', () => {
    const view = buildTuiLogsView(logsEnvelope({
      logs: [{ processId: 'process-1', taskName: 'dev', stdout: 'a\n\nb\n', stderr: '' }],
    }), '2026-09-22T00:00:00.000Z');

    expect(view.entries[0]?.stdoutLines).toEqual(['a', '', 'b']);
  });

  test('keeps only the trailing N lines of a stream', () => {
    const stdout = Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n');
    const view = buildTuiLogsView(logsEnvelope({
      logs: [{ processId: 'process-1', taskName: 'dev', stdout, stderr: '' }],
    }), '2026-09-22T00:00:00.000Z', 3);

    expect(view.entries[0]?.stdoutLines).toEqual(['line-7', 'line-8', 'line-9']);
  });

  test('carries the truncated flag through', () => {
    const view = buildTuiLogsView(logsEnvelope({
      logs: [{ processId: 'process-1', taskName: 'dev', stdout: '', stderr: '' }],
      truncated: true,
    }), '2026-09-22T00:00:00.000Z');

    expect(view.truncated).toBe(true);
  });

  test('reports an empty entry list and surfaces envelope errors when the daemon is unavailable', () => {
    const error = { code: 'WTM_DAEMON_UNAVAILABLE' as const, message: 'WTM daemon is unavailable.', severity: 'error' as const };
    const view = buildTuiLogsView(logsEnvelope(null, [error]), '2026-09-22T00:00:00.000Z');

    expect(view.entries).toEqual([]);
    expect(view.truncated).toBe(false);
    expect(view.errors).toEqual([error]);
  });

  test('treats a malformed payload as no entries rather than throwing', () => {
    const view = buildTuiLogsView(logsEnvelope({ logs: 'not-an-array' }), '2026-09-22T00:00:00.000Z');
    expect(view.entries).toEqual([]);
  });
});

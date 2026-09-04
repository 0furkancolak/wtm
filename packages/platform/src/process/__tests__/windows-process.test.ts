import { describe, expect, test } from 'bun:test';
import { observedCommandFingerprint } from '../identity';
import {
  createWindowsProcessPlatform, WindowsProcessGroupNotFoundError,
  type WindowsProcessQueryRunner, type WindowsTaskkillRunner,
} from '../windows';

/**
 * There is no Windows kernel here to run `powershell.exe` or `taskkill.exe` against — the same
 * position `windows.test.ts` (ACL) and `windows-service.test.ts` (`schtasks`) are already in. What
 * these tests prove is the parsing of a captured `Get-CimInstance ... | ConvertTo-Json` shape and
 * the tree walk/decision built on it; nothing here proves a real Windows process table looks like
 * this, or that `taskkill` really exits 128 for "not found" — Increment D2's CI leg is where that
 * is measured, not assumed.
 */

function cimProcess(overrides: Partial<{
  ProcessId: number; ParentProcessId: number; CreationDate: string; Name: string; CommandLine: string;
}> = {}): Record<string, unknown> {
  return {
    ProcessId: 100,
    ParentProcessId: 4,
    CreationDate: '2026-09-04T10:00:00.0000000-07:00',
    Name: 'wtm.exe',
    CommandLine: 'wtm.exe __wtm_internal_anchor deadbeef',
    ...overrides,
  };
}

function queryReturning(...processes: Array<Record<string, unknown>>): WindowsProcessQueryRunner {
  const json = processes.length === 1 ? JSON.stringify(processes[0]) : JSON.stringify(processes);
  return async () => ({ stdout: json });
}

function queryRecorder(respond: WindowsProcessQueryRunner): { run: WindowsProcessQueryRunner; scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    run: async (script) => {
      scripts.push(script);
      return await respond(script);
    },
  };
}

function taskkillReturning(status: number | null, stdout = '', stderr = ''): WindowsTaskkillRunner {
  return () => ({ status, stdout, stderr });
}

describe('inspectProcess', () => {
  test('reports a present process, with pgid equal to its own pid', async () => {
    const platform = createWindowsProcessPlatform({ runQuery: queryReturning(cimProcess()) });
    expect(await platform.inspectProcess(100)).toEqual({
      status: 'present',
      identity: {
        pid: 100,
        pgid: 100,
        processStartTime: '2026-09-04T10:00:00.0000000-07:00',
        commandFingerprint: observedCommandFingerprint(
          'wtm.exe', 'wtm.exe __wtm_internal_anchor deadbeef',
        ),
      },
    });
  });

  test('asks Get-CimInstance for exactly the pid it was given', async () => {
    const { run, scripts } = queryRecorder(queryReturning(cimProcess()));
    await createWindowsProcessPlatform({ runQuery: run }).inspectProcess(100);
    expect(scripts[0]).toContain("Get-CimInstance Win32_Process -Filter 'ProcessId=100'");
  });

  test('reports absence when Get-CimInstance returns nothing', async () => {
    const platform = createWindowsProcessPlatform({ runQuery: async () => ({ stdout: '' }) });
    expect(await platform.inspectProcess(404)).toEqual({ status: 'absent' });
  });

  test('reports failure, not absence, when powershell.exe itself fails', async () => {
    const platform = createWindowsProcessPlatform({
      runQuery: async () => { throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }); },
    });
    expect(await platform.inspectProcess(100)).toEqual({ status: 'failed', reason: 'ETIMEDOUT' });
  });

  test('reports failure on unparseable output', async () => {
    const platform = createWindowsProcessPlatform({ runQuery: async () => ({ stdout: 'not json' }) });
    expect(await platform.inspectProcess(100)).toEqual({ status: 'failed', reason: 'POWERSHELL_PARSE_FAILED' });
  });

  test('rejects a non-positive pid without asking powershell anything', async () => {
    const { run, scripts } = queryRecorder(queryReturning(cimProcess()));
    const platform = createWindowsProcessPlatform({ runQuery: run });
    expect(await platform.inspectProcess(0)).toEqual({ status: 'absent' });
    expect(await platform.inspectProcess(-5)).toEqual({ status: 'absent' });
    expect(scripts).toEqual([]);
  });
});

describe('readStartTime', () => {
  test('resolves the creation date for a present process', async () => {
    const platform = createWindowsProcessPlatform({ runQuery: queryReturning(cimProcess()) });
    expect(await platform.readStartTime(100)).toBe('2026-09-04T10:00:00.0000000-07:00');
  });

  test('resolves null for an absent process', async () => {
    const platform = createWindowsProcessPlatform({ runQuery: async () => ({ stdout: '' }) });
    expect(await platform.readStartTime(404)).toBeNull();
  });
});

describe('inspectProcessGroup', () => {
  test('walks the tree rooted at pgid, root inclusive', async () => {
    const root = cimProcess({ ProcessId: 100, ParentProcessId: 4 });
    const child = cimProcess({
      ProcessId: 101, ParentProcessId: 100, CreationDate: '2026-09-04T10:00:01.0000000-07:00', Name: 'node.exe',
    });
    const grandchild = cimProcess({
      ProcessId: 102, ParentProcessId: 101, CreationDate: '2026-09-04T10:00:02.0000000-07:00', Name: 'child.exe',
    });
    const unrelated = cimProcess({ ProcessId: 200, ParentProcessId: 4, Name: 'unrelated.exe' });
    const platform = createWindowsProcessPlatform({
      runQuery: queryReturning(root, child, grandchild, unrelated),
    });
    const result = await platform.inspectProcessGroup(100);
    expect(result.status).toBe('present');
    expect(result.status === 'present' && result.pids.slice().sort((a, b) => a - b)).toEqual([100, 101, 102]);
  });

  test('excludes a reused-pid impostor whose declared parent predates it', async () => {
    // The real 101 exited; an unrelated later process reused pid 101 and Windows never rewrote its
    // own ParentProcessId, which still points at 100 — but this impostor was created before 100
    // (the tree root) even existed, which the real child at pid 101 could never have been.
    const root = cimProcess({ ProcessId: 100, ParentProcessId: 4, CreationDate: '2026-09-04T10:00:00.0000000-07:00' });
    const impostor = cimProcess({
      ProcessId: 101, ParentProcessId: 100, CreationDate: '2026-09-04T09:00:00.0000000-07:00', Name: 'impostor.exe',
    });
    const platform = createWindowsProcessPlatform({ runQuery: queryReturning(root, impostor) });
    const result = await platform.inspectProcessGroup(100);
    expect(result).toEqual({ status: 'present', pids: [100] });
  });

  test('reports absence when the root pid is not in the table', async () => {
    const platform = createWindowsProcessPlatform({ runQuery: queryReturning(cimProcess({ ProcessId: 999 })) });
    expect(await platform.inspectProcessGroup(100)).toEqual({ status: 'absent' });
  });

  test('still finds an orphaned child when the root itself has already exited', async () => {
    // Windows never rewrites a child's ParentProcessId when the parent exits, so the edge to a
    // live orphan survives even though pid 100's own row is gone from the table.
    const orphan = cimProcess({ ProcessId: 101, ParentProcessId: 100, Name: 'orphan.exe' });
    const platform = createWindowsProcessPlatform({ runQuery: queryReturning(orphan) });
    expect(await platform.inspectProcessGroup(100)).toEqual({ status: 'present', pids: [101] });
  });

  test('scans the whole table, not one filtered pid', async () => {
    const { run, scripts } = queryRecorder(queryReturning(cimProcess()));
    await createWindowsProcessPlatform({ runQuery: run }).inspectProcessGroup(100);
    expect(scripts[0]).toContain('Get-CimInstance Win32_Process |');
    expect(scripts[0]).not.toContain('-Filter');
  });
});

describe('signalProcessGroup', () => {
  test('runs taskkill against the whole tree, forcefully', () => {
    const calls: Array<readonly string[]> = [];
    const runTaskkill: WindowsTaskkillRunner = (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; };
    createWindowsProcessPlatform({ runTaskkill }).signalProcessGroup(100, 'SIGTERM');
    expect(calls).toEqual([['/PID', '100', '/T', '/F']]);
  });

  test('throws an ESRCH-coded error when taskkill reports the process already gone', () => {
    const platform = createWindowsProcessPlatform({ runTaskkill: taskkillReturning(128, '', 'ERROR: not found') });
    expect(() => platform.signalProcessGroup(100, 'SIGKILL')).toThrow(WindowsProcessGroupNotFoundError);
    try {
      platform.signalProcessGroup(100, 'SIGKILL');
      throw new Error('unreachable');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ESRCH');
    }
  });

  test('throws for any other non-zero exit', () => {
    const platform = createWindowsProcessPlatform({ runTaskkill: taskkillReturning(1, '', 'ERROR: access denied') });
    expect(() => platform.signalProcessGroup(100, 'SIGKILL')).toThrow(/access denied/);
  });

  test('throws the spawn error itself when taskkill cannot even run', () => {
    const spawnError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const runTaskkill: WindowsTaskkillRunner = () => ({ status: null, stdout: '', stderr: '', error: spawnError });
    const platform = createWindowsProcessPlatform({ runTaskkill });
    expect(() => platform.signalProcessGroup(100, 'SIGKILL')).toThrow(spawnError);
  });
});

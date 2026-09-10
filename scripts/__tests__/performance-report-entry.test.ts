import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../packages/testkit/src/scenario-child';

const entry = fileURLToPath(new URL('../performance-report.ts', import.meta.url));
for (const blocked of [false, true]) {
  test(`performance report entry writes actual JSON and maps measured blockers to exit status: ${String(blocked)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-report-entry-'));
    try {
      const outputPath = join(root, 'report.json');
      // Only the costly measurement child boundary is a fixture. The script, imports, report
      // assembly, filesystem write and process exit are real. Native measurements stay in
      // test:perf; this must not be read as CPU/RSS performance evidence.
      const preload = `data:text/javascript,${encodeURIComponent([
        "import childProcess from 'node:child_process';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'const original = childProcess.spawnSync;',
        'childProcess.spawnSync = (command, args, options) => {',
        '  const path = args?.at(-1); let data;',
        "  if (path === 'packages/core/src/state/__tests__/workspace-scale.scenario.ts') data = { fixture: { repositories: 10, worktrees: 100, runningTasks: 3 }, warmGlobalStatus: { status: 'pass' }, singleRepositoryReconciliation: { status: 'warning' } };",
        `  else if (path === 'packages/daemon/src/__tests__/idle-daemon.scenario.ts') data = { cpuP95: { status: '${blocked ? 'blocker' : 'pass'}' }, rss: { status: 'pass' } };`,
        "  else if (path === 'packages/daemon/src/__tests__/source-edit-storm.scenario.ts') data = { path: 'WtmDaemon -> StructuralWatcher -> adapterDiscovery', edits: 1000, scheduledSignals: 0, adapterDiscoveries: 0, adapterSpawns: 0, status: 'pass' };",
        '  else return original(command, args, options);',
        "  return { status: 0, signal: null, stdout: JSON.stringify(data), stderr: '' };",
        '}; syncBuiltinESMExports();',
      ].join('\n'))}`;
      const result = runScenario('node', ['--import', 'tsx', '--import', preload, entry, outputPath]);
      expect(result.status, result.stderr || result.stdout).toBe(blocked ? 1 : 0);
      expect(result.stderr).toBe('');
      const report = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(report.schemaVersion).toBe(1);
      expect(report.fixture).toEqual({ repositories: 10, worktrees: 100, runningTasks: 3 });
      expect(report.release).toEqual({ blockers: blocked ? 1 : 0, warnings: 1 });
      expect(report.idle.cpuP95.status).toBe(blocked ? 'blocker' : 'pass');
      expect(report.sourceEditStorm.edits).toBe(1000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

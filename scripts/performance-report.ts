import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runScenario } from './packages/testkit/src/scenario-child';

interface Measurement { status: 'pass' | 'warning' | 'blocker' }

const scale = runMeasurement('packages/core/src/state/__tests__/workspace-scale.scenario.ts') as {
  fixture: { repositories: number; worktrees: number; runningTasks: number };
  warmGlobalStatus: Measurement;
  singleRepositoryReconciliation: Measurement;
};
const idle = runMeasurement('packages/daemon/src/__tests__/idle-daemon.scenario.ts') as {
  cpuP95: Measurement;
  rss: Measurement;
};
const sourceEditStorm = runMeasurement('packages/daemon/src/__tests__/source-edit-storm.scenario.ts') as Measurement & {
  path: string; edits: number; scheduledSignals: number; adapterDiscoveries: number; adapterSpawns: number;
};
const measurements = [scale.warmGlobalStatus, scale.singleRepositoryReconciliation, idle.cpuP95, idle.rss, sourceEditStorm];
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  fixture: scale.fixture,
  sourceEditStorm,
  warmGlobalStatus: scale.warmGlobalStatus,
  singleRepositoryReconciliation: scale.singleRepositoryReconciliation,
  idle,
  release: {
    blockers: measurements.filter(({ status }) => status === 'blocker').length,
    warnings: measurements.filter(({ status }) => status === 'warning').length,
  },
};
const outputPath = resolve(process.argv[2] ?? 'artifacts/performance.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${outputPath}\n`);
if (report.release.blockers > 0) process.exitCode = 1;

function runMeasurement(path: string): unknown {
  const result = runScenario('node', ['--import', 'tsx', path]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Scenario failed: ${path}`);
  return JSON.parse(result.stdout);
}

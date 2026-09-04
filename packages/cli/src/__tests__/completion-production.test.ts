import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./completion-production.scenario.ts', import.meta.url));

// `wtm __complete` opens a real Git checkout and, for the worktree/repo kinds, a real SQLite
// state database, so — like `production-commands.test.ts` — this runs the production code path
// under Node rather than exercising it through an injected `completionDataRunner`.
test('wtm __complete reads real task names, worktree branches, and workspace names', () => {
  const reportRoot = mkdtempSync(join(tmpdir(), 'wtm-completion-production-report-'));
  const reportPath = join(reportRoot, 'report.json');

  try {
    const result = runScenario('node', ['--import', 'tsx', scenarioPath, reportPath]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, [number, string[]]>;

    const [taskExitCode, taskLines] = report['taskNamesFromWtmToml'] as [number, string[]];
    expect(taskExitCode).toBe(0);
    expect(taskLines).toEqual(['build', 'dev']);

    const [worktreeExitCode, worktreeLines] = report['worktreeSelectorsFromGitTopology'] as [number, string[]];
    expect(worktreeExitCode).toBe(0);
    expect(worktreeLines).toContain('feature/completion');

    const [repoExitCode, repoLines] = report['repoSelectorsFromStateStore'] as [number, string[]];
    expect(repoExitCode).toBe(0);
    expect(repoLines).toEqual(['production']);
  } finally {
    rmSync(reportRoot, { recursive: true, force: true });
  }
}, 30_000);

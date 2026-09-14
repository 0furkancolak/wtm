import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('task commands reach the selected worktree of a multi-repository workspace from its root', () => {
  const scenarioPath = fileURLToPath(new URL('./worktree-selector.scenario.ts', import.meta.url));
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  const { apiAuth, webAuth, requests, results } = JSON.parse(result.stdout);

  for (const name of ['start', 'stop', 'restart', 'logs', 'exec', 'enqueue']) {
    expect(results[name].envelope.ok, name).toBe(true);
  }
  expect(requests.map(({ arguments: args }: { arguments: { cwd: string } }) => args.cwd)).toEqual([apiAuth, apiAuth, apiAuth, apiAuth, apiAuth, apiAuth]);
  expect(results.ambiguous.envelope).toMatchObject({ ok: false, errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', context: { matchCount: 2 } }] });
  expect(results.ambiguous.envelope.errors[0].remediation.map(({ argv }: { argv: string[] }) => argv.at(-1)).sort()).toEqual(['api', 'web']);
  expect(results.unknownRepo.envelope).toMatchObject({ ok: false, errors: [{ code: 'WTM_CONFIG_INVALID' }] });
  expect(results.workspaceRoot.envelope).toMatchObject({
    ok: false,
    errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'start', 'dev', '--worktree', '<selector>'] }] }],
  });
  expect(results.workspaceRoot.envelope.errors[0].context.candidates.map(({ path }: { path: string }) => path)).toEqual(expect.arrayContaining([apiAuth, webAuth]));
  // `resolve` returns the ResolvedTask (`packages/core/src/runtime/task-resolver.ts`), whose `cwd`
  // is the worktree root for a task with no `cwd` of its own.
  expect(results.resolveTarget.envelope).toMatchObject({ ok: true, data: { cwd: webAuth } });
});

import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import { runScenario } from '../../../testkit/src/scenario-child';

test('ignored content has its own CLI contract and survives removal, including inspection failures', () => {
  const scenario = fileURLToPath(new URL('./ignored-content.scenario.ts', import.meta.url));
  const output = runScenario('node', ['--import', 'tsx', scenario]);
  expect(output.status, output.stderr || output.stdout).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(result.analyze.envelope.data.workingTree).toMatchObject({
    classifications: ['ignored'],
    counts: { untracked: 0, ignored: 1 },
    paths: { untracked: [], ignored: ['.env'] },
  });
  expect(result.remove.exitCode).toBe(3);
  expect(jsonEnvelopeSchema.parse(result.remove.envelope)).toMatchObject({
    ok: false, errors: [{ code: 'GIT_IGNORED_CONTENT', context: { count: 1, paths: ['.env'] } }],
  });
  expect(result.preservedContent).toBe('private content\n');
  expect(result.unreadableExitCode).toBe(1);
  expect(result.unreadableEnvelope.ok).toBe(false);
  expect(result.unreadableContentPreserved).toBe('private content\n');
});

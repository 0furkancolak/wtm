/**
 * Proves that the CLI's known-code set tracks `wtmErrorCodeSchema` instead of copying it.
 *
 * A literal list that happens to agree with the schema and a set derived from the schema are
 * indistinguishable while the two agree. The only thing that tells them apart is the schema growing
 * — which is exactly what happens next in this increment. So this child grows it: it replaces
 * `@wtm/protocol` with the real module plus one extra code, then hands `toGitSafetyError` an error
 * carrying that code. A derived set reports the code as itself; a hand-written one has never heard
 * of it and remaps it to `GIT_REPOSITORY_DEGRADED`, taking the caller's exit code with it.
 *
 * Two departures from the other scenarios in this repo, both forced:
 * - it runs under `bun`, not `node --import tsx`, because `mock.module` is Bun's;
 * - it runs in a child at all because `mock.module` rewrites the registry for the whole process and
 *   would otherwise outlive this file for the rest of the suite.
 */
import { mock } from 'bun:test';
import * as protocol from '@wtm/protocol';
import { z } from 'zod';

const futureCode = 'WTM_CODE_ADDED_AFTER_THIS_FILE_WAS_WRITTEN';

mock.module('@wtm/protocol', () => ({
  ...protocol,
  wtmErrorCodeSchema: z.enum([futureCode, ...protocol.wtmErrorCodeSchema.options]),
}));

const { toGitSafetyError } = await import('../git-error');

const failure = Object.assign(new Error('a refusal this file was never told about'), {
  code: futureCode,
  context: { worktreePath: '/tmp/example' },
  remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }],
});

process.stdout.write(`${JSON.stringify({
  futureCode,
  reported: toGitSafetyError(failure, 'remove'),
})}\n`);

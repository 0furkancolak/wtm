import { describe, expect, it } from 'bun:test';
import { wtmErrorSchema } from './errors.js';

describe('wtmErrorSchema', () => {
  it('accepts a documented error and command-suggestion remediation', () => {
    expect(
      wtmErrorSchema.parse({
        code: 'GIT_HEAD_NOT_REMOTE_PERSISTED',
        message: 'HEAD is not reachable from an allowed remote-tracking ref.',
        severity: 'error',
        context: { worktreeId: 7, branch: 'feat/auth' },
        remediation: [
          {
            kind: 'command-suggestion',
            argv: ['git', '-C', '/path/to/wt', 'push', '-u', 'origin', 'HEAD'],
          },
        ],
      }),
    ).toMatchObject({ code: 'GIT_HEAD_NOT_REMOTE_PERSISTED', severity: 'error' });
  });

  it('rejects a remediation command with no argv', () => {
    expect(() =>
      wtmErrorSchema.parse({
        code: 'GIT_COMMAND_FAILED',
        message: 'Git failed.',
        severity: 'error',
        remediation: [{ kind: 'command-suggestion', argv: [] }],
      }),
    ).toThrow();
  });

  it('rejects error codes outside the stable V1 contract', () => {
    expect(() =>
      wtmErrorSchema.parse({
        code: 'UNDOCUMENTED_ERROR',
        message: 'Not stable.',
        severity: 'error',
      }),
    ).toThrow();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, test } from 'bun:test';
import { wtmErrorCodeSchema, wtmErrorSchema } from '../errors';

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

describe('WTM_OPERATION_CONFLICT', () => {
  test('is accepted as a stable V1 error code', () => {
    expect(
      wtmErrorSchema.parse({
        code: 'WTM_OPERATION_CONFLICT',
        message: 'Another process holds a destructive-operation lease on this repository.',
        severity: 'error',
        context: {
          repositoryId: 3,
          operation: 'remove',
          holderPid: 4242,
          acquiredAt: '2026-08-31T10:00:00.000Z',
          stage: null,
          abandoned: false,
        },
      }),
    ).toMatchObject({ code: 'WTM_OPERATION_CONFLICT', severity: 'error' });
  });
});

describe('docs/18-errors-json-contract.md', () => {
  test('lists exactly the codes in wtmErrorCodeSchema', () => {
    const documented = documentedErrorCodes();
    const declared = new Set<string>(wtmErrorCodeSchema.options);
    const onlyInDocs = [...documented].filter((code) => !declared.has(code)).sort();
    const onlyInEnum = [...declared].filter((code) => !documented.has(code)).sort();

    expect({ onlyInDocs, onlyInEnum }).toEqual({ onlyInDocs: [], onlyInEnum: [] });
  });
});

function documentedErrorCodes(): ReadonlySet<string> {
  const document = readFileSync(
    new URL('../../../../docs/18-errors-json-contract.md', import.meta.url),
    'utf8',
  );
  const families = document.split(/^## Stable V1 error families$/m)[1]?.split(/^## /m)[0];
  if (families === undefined) throw new Error('"## Stable V1 error families" section not found.');

  const codes = new Set<string>();
  for (const block of families.matchAll(/^```text$\n([\s\S]*?)^```$/gm)) {
    for (const line of (block[1] ?? '').split('\n')) {
      const code = line.trim();
      if (code.length > 0) codes.add(code);
    }
  }
  if (codes.size === 0) throw new Error('No fenced text blocks with error codes were found.');
  return codes;
}

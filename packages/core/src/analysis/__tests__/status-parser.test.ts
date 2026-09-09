import { describe, expect, test } from 'bun:test';
import { parseStatusPorcelainV2, WorktreeAnalysisError } from '../worktree-analysis';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const oid = '0123456789012345678901234567890123456789';

describe('parseStatusPorcelainV2', () => {
  test('accepts empty porcelain output as a clean worktree', () => {
    expect(parseStatusPorcelainV2(encode(''))).toMatchObject({
      classifications: ['clean'],
      counts: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, unmerged: 0, submoduleDirty: 0 },
    });
  });

  test('keeps ignored paths separate from untracked paths, including unusual filenames', () => {
    const parsed = parseStatusPorcelainV2(encode(
      '? notes.txt\0! .env\0! cache/\0? line\nbreak.txt\0! private cache\0! .env\0',
    ));
    expect(parsed.counts).toMatchObject({ untracked: 2, ignored: 3 });
    expect(parsed.paths.untracked).toEqual(['line\nbreak.txt', 'notes.txt']);
    expect(parsed.paths.ignored).toEqual(['.env', 'cache/', 'private cache']);
    expect(parsed.classifications).toEqual(['untracked', 'ignored']);
  });

  test('does not classify an ignored-only worktree as clean or untracked', () => {
    expect(parseStatusPorcelainV2(encode('! .env\0'))).toMatchObject({
      classifications: ['ignored'],
      counts: { untracked: 0, ignored: 1 },
      paths: { untracked: [], ignored: ['.env'] },
    });
    expectDegraded('! \0', 'missing-path');
  });

  test('rejects an unknown porcelain-v2 record type', () => {
    expect(() => parseStatusPorcelainV2(encode('x unknown\0'))).toThrow(WorktreeAnalysisError);
    expectDegraded('x unknown\0', 'unknown-record-type');
  });

  for (const recordType of ['?', '!']) {
    test(`rejects invalid UTF-8 in a ${recordType} pathname instead of changing its identity`, () => {
      const output = new Uint8Array([recordType.charCodeAt(0), 32, 255, 46, 101, 110, 118, 0]);
      expect(() => parseStatusPorcelainV2(output)).toThrow(WorktreeAnalysisError);
      try {
        parseStatusPorcelainV2(output);
      } catch (error) {
        expect(error).toMatchObject({ code: 'GIT_REPOSITORY_DEGRADED', context: { reason: 'invalid-utf8' } });
      }
    });
  }

  test('preserves valid Unicode, including a literal replacement character in a pathname', () => {
    expect(parseStatusPorcelainV2(encode('! özel-�.env\0')).paths.ignored).toEqual(['özel-�.env']);
  });

  test('rejects invalid XY and submodule fields instead of treating the record as clean', () => {
    expectDegraded(
      '1 ZZ N... 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 file.txt\0',
      'invalid-xy',
    );
    expectDegraded(
      '1 M. SXYZ 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 file.txt\0',
      'invalid-submodule',
    );
  });

  test('rejects a truncated ordinary record with missing fixed fields', () => {
    expectDegraded('1 M. N... 100644 file.txt\0', 'missing-fields');
  });

  test('rejects a malformed rename before an otherwise valid untracked record', () => {
    const malformedRename = [
      '2 R. N... 100644 100644 100644 0123456789012345678901234567890123456789',
      '0123456789012345678901234567890123456789 R100',
      '? must-not-be-consumed.txt',
      '',
    ].join('\0');

    expectDegraded(malformedRename, 'missing-fields');
  });

  test('rejects a type-2 rename without its source-path NUL companion', () => {
    const rename = [
      '2 R. N... 100644 100644 100644',
      '0123456789012345678901234567890123456789',
      '0123456789012345678901234567890123456789 R100 renamed.txt\0',
    ].join(' ');

    expectDegraded(rename, 'missing-rename-source');
  });

  test('consumes a type-2 source pathname positionally even when it resembles another record', () => {
    for (const sourcePath of ['? old-name.txt', '! ignored-name.txt', '1 ordinary-looking.txt']) {
      const parsed = parseStatusPorcelainV2(encode(
        `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed.txt\0${sourcePath}\0`,
      ));

      expect(parsed.paths.staged).toEqual(['renamed.txt']);
      expect(parsed.paths.untracked).toEqual([]);
      expect(parsed.paths.ignored).toEqual([]);
    }
  });

  test('rejects semantically impossible type-1 and type-2 XY states', () => {
    expectDegraded(
      `1 .. N... 100644 100644 100644 ${oid} ${oid} unchanged.txt\0`,
      'invalid-xy-semantics',
    );
    expectDegraded(
      `1 R. N... 100644 100644 100644 ${oid} ${oid} misplaced-rename.txt\0`,
      'invalid-xy-semantics',
    );
    expectDegraded(
      `2 M. N... 100644 100644 100644 ${oid} ${oid} R100 not-a-rename.txt\0old.txt\0`,
      'invalid-xy-semantics',
    );
  });

  test('accepts valid ordinary modified, renamed, and dirty-submodule records', () => {
    const parsed = parseStatusPorcelainV2(encode([
      `1 M. N... 100644 100644 100644 ${oid} ${oid} staged.txt`,
      `1 .M N... 100644 100644 100644 ${oid} ${oid} unstaged.txt`,
      `1 .A N... 000000 100644 100644 ${oid} ${oid} intent-to-add.txt`,
      `1 .. S.M. 160000 160000 160000 ${oid} ${oid} dirty-submodule`,
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed.txt`,
      'old-name.txt',
      '',
    ].join('\0')));

    expect(parsed.paths).toMatchObject({
      staged: ['renamed.txt', 'staged.txt'],
      unstaged: ['dirty-submodule', 'intent-to-add.txt', 'unstaged.txt'],
      submoduleDirty: ['dirty-submodule'],
    });
  });

  test('rejects non-empty output without the required terminal NUL', () => {
    expectDegraded('? untracked.txt', 'missing-terminal-nul');
  });
});

function expectDegraded(porcelain: string, reason: string): void {
  try {
    parseStatusPorcelainV2(encode(porcelain));
    throw new Error('Expected parser to reject malformed porcelain');
  } catch (error) {
    expect(error).toMatchObject({
      name: 'WorktreeAnalysisError',
      code: 'GIT_REPOSITORY_DEGRADED',
      context: { reason },
    });
  }
}

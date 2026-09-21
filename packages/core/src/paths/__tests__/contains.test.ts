import { describe, expect, test } from 'bun:test';
import { join, resolve, sep } from 'node:path';
import { containsPath, samePath } from '../contains';

describe('containsPath', () => {
  test('a directory contains itself', () => {
    expect(containsPath('/a/b', '/a/b')).toBe(true);
  });

  test('a directory contains what is under it', () => {
    expect(containsPath('/a/b', '/a/b/c/d')).toBe(true);
  });

  test('a sibling is not contained', () => {
    expect(containsPath('/a/b', '/a/c')).toBe(false);
  });

  test('a shorter unrelated path is not contained', () => {
    expect(containsPath('/projects/other/analytics-api', '/projects/lab/api')).toBe(false);
  });

  test('a name the root only prefixes is not contained', () => {
    expect(containsPath('/a/api', '/a/api-feat')).toBe(false);
  });

  test('a parent is not contained by its child', () => {
    expect(containsPath('/a/b/c', '/a/b')).toBe(false);
  });

  test('relative segments are resolved before comparing', () => {
    expect(containsPath('/a/b', '/a/b/c/..')).toBe(true);
    expect(containsPath('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('samePath', () => {
  test('a path is the same as itself, and a sibling is not', () => {
    expect(samePath('/a/b', '/a/b')).toBe(true);
    expect(samePath('/a/b', '/a/c')).toBe(false);
    expect(samePath('/a/api', '/a/api-feat')).toBe(false);
  });

  test('relative segments are resolved before comparing', () => {
    expect(samePath('/a/b', '/a/b/c/..')).toBe(true);
    expect(samePath('/a/b', '/a/../a/b')).toBe(true);
    expect(samePath('/a/b', '/a/b/..')).toBe(false);
  });

  /**
   * The host decides what one directory's several legal spellings are, which is the whole reason
   * this is not `===`. On Windows the separator and the drive letter's case are both free, and
   * `node:path`'s own `relative` applies that rule; on POSIX neither is, and the same call applies
   * *that* rule. The assertion is therefore written against the host's own `join`, not against one
   * platform's spelling — a POSIX runner proves the strict half and a windows-latest runner the
   * permissive half, from one line.
   */
  test('a path joined by this host is the same as the string it names', () => {
    expect(samePath(join('/a', 'b', 'c'), '/a/b/c')).toBe(true);
    expect(samePath(join('/a', 'b'), join('/a', 'b') + sep)).toBe(true);
  });

  /**
   * Stated as a limit rather than left to be discovered: these callers ask about registrations
   * whose directory may already be gone, so nothing here touches the filesystem and no spelling
   * that only `realpath` could reconcile is reconciled.
   */
  test('is lexical, so a relative path is only resolved against the working directory', () => {
    expect(samePath('b', resolve('b'))).toBe(true);
  });
});

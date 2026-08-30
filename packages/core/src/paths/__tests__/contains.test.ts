import { describe, expect, test } from 'bun:test';
import { containsPath } from '../contains';

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

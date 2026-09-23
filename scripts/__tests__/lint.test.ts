import { describe, expect, test } from 'bun:test';
import { extensionfulRelativeImportSpecifiers } from '../lint-rules';

/**
 * `scripts/lint.ts`'s extensionless-relative-import check is the sole enforcement of CLAUDE.md's
 * "Relative imports are extensionless" rule -- `tsconfig.base.json` uses `moduleResolution:
 * "Bundler"`, which accepts either spelling without error, and there is no ESLint. This had no
 * test at all until round 27 of the adversarial audit found the matcher missed three real import
 * forms (a bare side-effect import, `require(...)`, and a multi-line dynamic `import(...)`) --
 * latent, since a repo-wide grep found none of them in use, but a regression here would otherwise
 * ship silently. These fixtures pin every form the matcher is meant to catch and a representative
 * sample of what it must not.
 *
 * `q()` keeps each fixture's quoted specifier out of a literal, contiguous `from '...'`-shaped
 * run of characters in *this file's own source* -- `lint.ts` scans raw file text, not parsed AST,
 * so a fixture written as a plain string literal would trip its own subject when `bun run lint`
 * scans this file. The `${...}` interpolation breaks that contiguity at the source level while
 * still producing the intended plain string at runtime, which is all `extensionfulRelativeImportSpecifiers`
 * ever sees.
 */
function q(path: string): string {
  return `'${path}'`;
}

describe('extensionfulRelativeImportSpecifiers', () => {
  test('flags a static named import with a recognized extension', () => {
    expect(extensionfulRelativeImportSpecifiers(`import { foo } from ${q('./sibling.ts')};`))
      .toEqual(['./sibling.ts']);
  });

  test('flags a bare side-effect import with no `from`', () => {
    expect(extensionfulRelativeImportSpecifiers(`import ${q('./sibling.ts')};`))
      .toEqual(['./sibling.ts']);
  });

  test('flags a CommonJS require', () => {
    expect(extensionfulRelativeImportSpecifiers(`const sibling = require(${q('./legacy.js')});`))
      .toEqual(['./legacy.js']);
  });

  test('flags a single-line dynamic import', () => {
    expect(extensionfulRelativeImportSpecifiers(`const mod = await import(${q('./deferred.ts')});`))
      .toEqual(['./deferred.ts']);
  });

  test('flags a dynamic import whose specifier is on its own line', () => {
    expect(extensionfulRelativeImportSpecifiers(`const mod = import(\n  ${q('./deferred.ts')}\n);`))
      .toEqual(['./deferred.ts']);
  });

  test('flags a re-export', () => {
    expect(extensionfulRelativeImportSpecifiers(`export { foo } from ${q('./sibling.ts')};`))
      .toEqual(['./sibling.ts']);
  });

  test('flags every extension this repository resolves relatively', () => {
    const source = [
      `import a from ${q('./a.js')};`,
      `import b from ${q('./b.jsx')};`,
      `import c from ${q('./c.ts')};`,
      `import d from ${q('./d.tsx')};`,
    ].join('\n');
    expect(extensionfulRelativeImportSpecifiers(source)).toEqual(['./a.js', './b.jsx', './c.ts', './d.tsx']);
  });

  test('does not flag an already-extensionless relative import', () => {
    expect(extensionfulRelativeImportSpecifiers("import { foo } from './sibling';")).toEqual([]);
  });

  test('does not flag a bare package import', () => {
    expect(extensionfulRelativeImportSpecifiers("import { z } from 'zod';")).toEqual([]);
  });

  test('does not flag a scoped package import', () => {
    expect(extensionfulRelativeImportSpecifiers("import { z } from '@wtm/core';")).toEqual([]);
  });

  test('does not flag an unrelated identifier that merely contains "import"', () => {
    expect(extensionfulRelativeImportSpecifiers("const reimportSetting = './x.ts';")).toEqual([]);
  });

  test('does not flag an external-adapter fixture using an extension outside this repository\'s own module graph', () => {
    // Mirrors `packages/core/src/plan/__tests__/external-adapter.test.ts`'s own fixtures: text
    // written to a temp file and run as a separate Node process, not a real relative import.
    expect(extensionfulRelativeImportSpecifiers(`import ${q('./dependency.mjs')};`)).toEqual([]);
  });
});

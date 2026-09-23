/**
 * The specifier alternatives that precede a relative import/require target this repository cares
 * about: a static `from '...'`, a bare side-effect `import '...'` (no `from`), a dynamic
 * `import(...)` (its `(` and the quote may be separated by whitespace or a newline -- `\s` matches
 * both), a re-export `export ... from '...'`, and a CommonJS `require(...)`. `\b` anchors each
 * alternative to a real word start so this does not fire inside an unrelated identifier.
 */
const relativeSpecifier = /\b(?:from\s*|import\s*\(\s*|import\s*|export\s+[^'"\n]*from\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * A relative import this repository requires to stay extensionless (CLAUDE.md's TypeScript
 * rules). Deliberately not widened to `.mjs`/`.cjs`/`.mts`/`.cts`: those extensions appear in this
 * repository's own tests as *fixture* import/require text for untrusted external-adapter scripts
 * (`packages/core/src/plan/__tests__/external-adapter.test.ts`), written to a temp file and run as
 * a genuinely separate Node process outside this repo's own module graph -- not a real relative
 * import CLAUDE.md's rule is about. This scanner has no way to tell fixture text from real source,
 * so widening the extension list there produces false positives on legitimate, unrelated code.
 */
const extensionfulRelativeImport = /\.(?:js|jsx|ts|tsx)$/;

/** Every relative import/require specifier in `source` that carries a file extension it should not. */
export function extensionfulRelativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(relativeSpecifier)) {
    const specifier = match[1];
    if (specifier !== undefined && extensionfulRelativeImport.test(specifier)) specifiers.push(specifier);
  }
  return specifiers;
}

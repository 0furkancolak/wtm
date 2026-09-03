/**
 * Keeps a raw `process.getuid()` call, or a raw group/other-access mode-bit check, from coming
 * back into `@wtm/core` (spec `2026-09-03-windows-trust-and-transport-seam.md`, D4).
 *
 * Before that increment, `process.getuid()` and a `stat.mode & 0o022` / `& 0o077` comparison were
 * the inline form of "does this belong to the current user" and "is this writable by anyone else"
 * — repeated across 8 files (`guard.ts`, `preparation.ts`, `removal.ts`, `materializer.ts`,
 * `gc.ts`, `adapter-trust.ts`, `private-directory.ts`) before each was migrated to ask
 * `FileTrustPolicy` (`../file-trust-policy.ts`) instead. `process.getuid()` returns `undefined` on
 * Windows and the two masks compare against bits that do not carry the same meaning there, so an
 * inline check that reappears is not merely undoing a refactor — it is a place a `WindowsPlatformRuntime`
 * cannot answer for.
 *
 * Two rules, not the broader "no `stat.mode`/`.nlink`/`.uid` at all" D4 first considered: this
 * migration also left a wide, legitimate residue behind — `(dev, ino, uid)` TOCTOU identity tuples
 * compared against a *previously observed* value (never `process.getuid()`), and POSIX-only checks
 * with no Windows analogue at all (an owner-execute bit, an exact `0o700`/`0o600` mode equality).
 * A guard broad enough to catch those too would need a reviewed exception on nearly every line of
 * `gc.ts` and `materializer.ts`, which is exactly the noise D8's own reviewed-exception discipline
 * exists to avoid manufacturing. `process.getuid()` and the two denial masks are what a
 * *reintroduced* inline check would actually look like — narrow, and (checked when this guard was
 * written) matching nothing left in the tree, so it needs no exceptions of its own yet.
 */
import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const scannedRoot = 'packages/core/src';
/** The port's own implementation is the one place these primitives legitimately live. */
const portFile = join(scannedRoot, 'file-trust-policy.ts');

interface StructuralRule {
  name: string;
  why: string;
  pattern: RegExp;
}

const rules: readonly StructuralRule[] = [
  {
    name: 'process.getuid',
    why: 'Undefined on Windows. "Is this owned by the current user" goes through FileTrustPolicy.isOwnedByCurrentUser.',
    pattern: /process\.getuid\b/,
  },
  {
    name: 'raw-owner-only-mask',
    why:
      'A `mode & 0o022` (no group/other write) or `mode & 0o077` (no group/other access) compared '
      + 'directly, rather than through FileTrustPolicy.isWritableOnlyByOwner — the two masks the '
      + 'migrated call sites actually asked with, not every mode-bit expression (an exact `0o700`/'
      + '`0o600` equality or an executable-bit check has no port method to call, and stays raw).',
    pattern: /mode\)?\s*&\s*0o0(?:22|77)\b/,
  },
];

interface ReviewedException {
  file: string;
  rule: string;
  occurrences: number;
  requires: string;
  reason: string;
}

/**
 * Every production call site of either pattern was migrated to call the port (checked when this
 * guard was written — see the file-by-file count in
 * `2026-09-03-windows-trust-and-transport-seam.md`'s outcome). The three entries below are not
 * production logic: they are a test *asserting on the real filesystem's mode* after materialization
 * ran, which is a legitimate thing for a test to check directly and is not the inline
 * ownership/write decision this guard exists to keep out of `@wtm/core` itself.
 */
const reviewedExceptions: readonly ReviewedException[] = [
  {
    file: 'packages/core/src/resources/__tests__/materializer.test.ts',
    rule: 'raw-owner-only-mask',
    occurrences: 3,
    requires: "mode & 0o077).toBe(0)",
    reason:
      'A test oracle reading the real mode `applyMaterializationPlan` left on disk, not an inline '
      + 'reimplementation of the ownership/write decision — the code under test already goes '
      + 'through `FileTrustPolicy.isWritableOnlyByOwner`, and this is what confirms its effect.',
  },
];

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const selfPath = relative(repositoryRoot, fileURLToPath(import.meta.url));

async function scannedFiles(): Promise<string[]> {
  const found: string[] = [];
  await collect(join(repositoryRoot, scannedRoot), found);
  return found
    .map((path) => relative(repositoryRoot, path))
    .filter((path) => path !== selfPath && path !== portFile)
    .sort();
}

async function collect(directory: string, found: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, found);
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
}

function exceptionFor(file: string, rule: string): ReviewedException | undefined {
  return reviewedExceptions.find((entry) => entry.file === file && entry.rule === rule);
}

async function findViolations(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await scannedFiles()) {
    const lines = (await readFile(join(repositoryRoot, file), 'utf8')).split('\n');
    for (const rule of rules) {
      const exception = exceptionFor(file, rule.name);
      let excused = 0;
      lines.forEach((text, index) => {
        if (!rule.pattern.test(text)) return;
        if (exception !== undefined && text.includes(exception.requires) && excused < exception.occurrences) {
          excused += 1;
          return;
        }
        violations.push({ file, line: index + 1, rule: rule.name, text: text.trim() });
      });
    }
  }
  return violations;
}

test('no file-ownership or mode check in @wtm/core bypasses FileTrustPolicy', async () => {
  const violations = await findViolations();

  expect(violations.map(({ file, line, rule, text }) => `${file}:${String(line)} [${rule}] ${text}`))
    .toEqual([]);
});

test('the guard actually looks at core, and exempts only the port itself', async () => {
  const files = await scannedFiles();

  expect(files.length).toBeGreaterThan(50);
  expect(files).toContain(join('packages', 'core', 'src', 'resources', 'guard.ts'));
  expect(files).toContain(join('packages', 'core', 'src', 'state', 'private-directory.ts'));
  expect(files).not.toContain(portFile);
  expect(files).not.toContain(selfPath);
});

test('every rule matches the thing it was written to catch, and nothing it should leave alone', async () => {
  const positiveSamples: Record<string, string> = {
    'process.getuid': '  const currentUid = process.getuid?.();',
    'raw-owner-only-mask': '  if ((stat.mode & 0o022) !== 0) deny(\'writable\', {});',
  };

  expect(Object.keys(positiveSamples).sort()).toEqual(rules.map(({ name }) => name).sort());
  for (const rule of rules) {
    expect(`${rule.name}: ${String(rule.pattern.test(positiveSamples[rule.name] as string))}`)
      .toBe(`${rule.name}: true`);
  }

  // What `raw-owner-only-mask` must not catch: a TOCTOU tuple comparison against a previously
  // observed value, an exact `0o700`/`0o600` equality with no denial mask involved, and calling
  // the port itself (`isWritableOnlyByOwner(..., 0o022)` is a function argument, not a raw AND).
  const maskRule = rules.find(({ name }) => name === 'raw-owner-only-mask') as StructuralRule;
  expect(maskRule.pattern.test('if (stat.uid !== candidate.uid) throw x;')).toBe(false);
  expect(maskRule.pattern.test('if ((Number(stat.mode) & 0o700) !== 0o700) throw x;')).toBe(false);
  expect(maskRule.pattern.test('await fileTrust.isWritableOnlyByOwner(stat, path, 0o022)')).toBe(false);
});

test('every reviewed exception still describes something that is really there', async () => {
  for (const exception of reviewedExceptions) {
    const rule = rules.find(({ name }) => name === exception.rule);
    expect(`${exception.rule} is a known rule: ${String(rule !== undefined)}`)
      .toBe(`${exception.rule} is a known rule: true`);
    expect(exception.reason.length).toBeGreaterThan(40);

    const lines = (await readFile(join(repositoryRoot, exception.file), 'utf8')).split('\n');
    const matched = lines.filter((text) =>
      (rule as StructuralRule).pattern.test(text) && text.includes(exception.requires));
    expect(`${exception.file} [${exception.rule}]: ${String(matched.length)}`)
      .toBe(`${exception.file} [${exception.rule}]: ${String(exception.occurrences)}`);
  }
});

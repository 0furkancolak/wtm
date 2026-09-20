/**
 * Fails when a dependency the installer claims to have installed cannot actually be loaded.
 *
 * `bun install --frozen-lockfile` can exit 0 having written an incomplete package. On 2026-09-18
 * a win32 leg installed `zod@4.4.3` without its `v4/locales/` directory; because the install
 * reported success, the retry loop in `ci.yml` had nothing to retry, and 154 of 238 test files
 * then aborted at import in under a second each. The leg reported that number as though it were
 * an inventory of Windows failures. It was not: the suite had barely run.
 *
 * An exit code says what the installer believed. Only a load says what the tree can do.
 *
 * This runs under whichever runtime starts it, and CI runs it under both bun and node, because
 * the suite uses both: test files run under `bun test`, and the scenario children they spawn run
 * under `node --import tsx`. The two resolve different entry points of the same package -- that
 * zod break surfaced as `../locales/en.js` under bun and as `v4/locales/index.js` under node --
 * so a tree that satisfies one resolver can still fail the other.
 *
 * Only external dependencies are checked. `workspace:*` entries resolve to directories in this
 * repository, which git either checked out or did not.
 *
 * Usage: bun scripts/verify-install.ts | node --import tsx scripts/verify-install.ts
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface Manifest {
  dependencies?: Record<string, string>;
}

/** Declared runtime dependencies that come from a registry, sorted, workspace links dropped. */
export function externalDependencies(manifest: Manifest): string[] {
  return Object.entries(manifest.dependencies ?? {})
    .filter(([, range]) => !range.startsWith('workspace:'))
    .map(([name]) => name)
    .sort();
}

/** Each name that would not import, paired with the reason, in the order given. */
export async function unloadable(names: readonly string[]): Promise<string[]> {
  const failures: string[] = [];
  for (const name of names) {
    try {
      await import(name);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

export async function main(): Promise<number> {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  const names = externalDependencies(manifest);
  if (names.length === 0) {
    process.stderr.write('verify-install: no external dependencies declared, nothing to verify\n');
    return 1;
  }
  const failures = await unloadable(names);
  if (failures.length > 0) {
    const report = failures.map((line) => `  ${line}`).join('\n');
    process.stderr.write(
      `verify-install: the install is incomplete -- ${String(failures.length)} of ${String(names.length)} dependencies could not be loaded:\n${report}\n`,
    );
    return 1;
  }
  process.stdout.write(`verify-install: ${String(names.length)} dependencies loaded\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}

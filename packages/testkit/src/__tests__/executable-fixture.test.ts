import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '../fake-adapter';
import { fixtureHashbang, writeExecutableFixture } from '../executable-fixture';

/**
 * The invariant these pin is cross-platform on purpose, and it is the win32 leg that decides
 * them: on darwin/linux the source has always started with the hashbang, so a green run here
 * proves only that the shared helper still writes what it always wrote. win32 is where the
 * fixture used to write `body` alone, which left every fake adapter failing
 * `assertExactV1AdapterDeclaration` — a file that could not be trusted for a reason that had
 * nothing to do with the code under test.
 */
test('writes the same hashbang-led source on every platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtm-executable-fixture-'));
  try {
    const fixture = await writeExecutableFixture(join(root, 'shim'), 'process.exit(0);\n');
    const source = await readFile(fixture.scriptPath, 'utf8');
    expect(source.split(/\r?\n/u, 2)).toEqual([fixtureHashbang, 'process.exit(0);']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves the fake adapter declaring itself on the two lines v1 requires', async () => {
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  try {
    const source = await readFile(adapter.executablePath, 'utf8');
    expect(source.split(/\r?\n/u, 2))
      .toEqual([fixtureHashbang, '// wtm-adapter-v1: self-contained']);
  } finally {
    await adapter.cleanup();
  }
});

import { execFileSync } from 'node:child_process';

/**
 * The absolute path of `name`, resolved the way a shell on this machine would resolve it.
 *
 * Every scenario that shadows a real executable on `PATH` (`git`, almost always) needs to know
 * where the real one lives, so its shim can delegate to it for every command the scenario is not
 * specifically about. `which` answers that on darwin/linux; it has no Windows analogue, and `where`
 * is the closest equivalent — except that, unlike `which`, it prints one match per line when
 * several installations shadow each other on `PATH`. Only the first is the one that would actually
 * run, so only it is kept, on every platform.
 *
 * This lives in `testkit` rather than next to the four call sites that used to each spawn `which`
 * inline, because one of those call sites is in `@wtm/core`, and `core` and `protocol` are
 * structurally forbidden from branching on `process.platform` themselves (spec D8, enforced by
 * `platform-independence.test.ts`) — the branch belongs in the fixture that needs it, not in the
 * package being tested. The other three call sites gain nothing from duplicating it either.
 */
export function resolveRealExecutablePath(name: string): string {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const output = execFileSync(command, [name], { encoding: 'utf8' });
  return (output.split(/\r?\n/)[0] ?? '').trim();
}

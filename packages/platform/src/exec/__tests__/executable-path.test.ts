import { sep } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createWindowsExecutablePathResolver, executablePathResolverFor, posixExecutablePathResolver,
} from '../executable-path';

describe('the identity resolution', () => {
  test('hands the name back unchanged, on purpose: this is what execvp already does', () => {
    expect(posixExecutablePathResolver('git')).toBe('git');
    expect(posixExecutablePathResolver('/usr/local/bin/git')).toBe('/usr/local/bin/git');
  });

  test('darwin and linux both get the identity resolution', () => {
    expect(executablePathResolverFor('darwin')).toBe(posixExecutablePathResolver);
    expect(executablePathResolverFor('linux')).toBe(posixExecutablePathResolver);
  });
});

/**
 * The exact bug this resolver exists to fix: a `git.cmd` earlier on `PATH` than a real `git.exe`
 * is invisible to `spawn('git')`, because libuv only appends `.com`/`.exe` to a bare name — never
 * `.cmd`, whatever `PATHEXT` says. Every WTM scenario that shadows `git` by writing a fixture and
 * prepending its directory to `PATH` relies on this being fixed to run on win32 at all.
 */
describe('the win32 resolver', () => {
  function resolverOver(files: readonly string[], env: NodeJS.ProcessEnv) {
    // Case-insensitive, the same way NTFS itself resolves a filename: `PATHEXT` is conventionally
    // uppercase (`.EXE`) while a real installed file's extension usually is not (`git.exe`), and a
    // resolver that only matched byte-for-byte would never find one on a real Windows host either.
    const present = new Set(files.map((file) => file.toLowerCase()));
    return createWindowsExecutablePathResolver({ env, isFile: (path) => present.has(path.toLowerCase()) });
  }

  test('finds a .cmd shim on an earlier PATH entry over a later real .exe', () => {
    const env = { PATH: String.raw`C:\shim;C:\real`, PATHEXT: '.COM;.EXE;.CMD' };
    const resolve = resolverOver([String.raw`C:\shim\git.cmd`, String.raw`C:\real\git.exe`], env);

    expect(resolve('git')).toBe(String.raw`C:\shim\git.CMD`);
  });

  test('tries every PATHEXT extension in order within one PATH entry before moving on', () => {
    const env = { PATH: String.raw`C:\bin`, PATHEXT: '.COM;.EXE;.CMD' };
    const resolve = resolverOver([String.raw`C:\bin\git.exe`], env);

    // `.COM` is tried first and misses (case-insensitively, matching a real filesystem lookup);
    // `.EXE` is what the resolver actually built the candidate from, so the extension's casing in
    // the result is `PATHEXT`'s own rather than whatever case the file happens to be on disk --
    // which is exactly as meaningful to `spawn` on Windows as any other casing, since NTFS is
    // case-insensitive.
    expect(resolve('git')).toBe(String.raw`C:\bin\git.EXE`);
  });

  test('falls back to the default PATHEXT list when the environment has none', () => {
    const env = { PATH: String.raw`C:\bin` };
    const resolve = resolverOver([String.raw`C:\bin\git.cmd`], env);

    expect(resolve('git')).toBe(String.raw`C:\bin\git.CMD`);
  });

  test('returns the bare name unresolved when nothing on PATH matches, same as a failed lookup', () => {
    const env = { PATH: String.raw`C:\empty`, PATHEXT: '.EXE' };
    const resolve = resolverOver([], env);

    expect(resolve('git')).toBe('git');
  });

  test('leaves a name that already carries a directory or an extension alone', () => {
    const env = { PATH: String.raw`C:\bin`, PATHEXT: '.EXE' };
    const resolve = resolverOver([String.raw`C:\bin\git.exe`], env);

    expect(resolve(String.raw`C:\other\git.exe`)).toBe(String.raw`C:\other\git.exe`);
    expect(resolve('git.exe')).toBe('git.exe');
    expect(resolve(`.${sep}git`)).toBe(`.${sep}git`);
  });

  test('skips an empty PATH entry rather than reading it as the current directory', () => {
    // cmd.exe reads an empty PATH segment as ".", but resolving a bare command out of the
    // process's own cwd is exactly how a repository under analysis could choose which `git` a
    // daemon runs -- so this resolver never does it.
    const env = { PATH: String.raw`;C:\bin`, PATHEXT: '.EXE' };
    const resolve = resolverOver([String.raw`.\git.exe`, String.raw`C:\bin\git.exe`], env);

    expect(resolve('git')).toBe(String.raw`C:\bin\git.EXE`);
  });

  test('is what executablePathResolverFor hands back for win32', () => {
    expect(typeof executablePathResolverFor('win32')).toBe('function');
    expect(executablePathResolverFor('win32')).not.toBe(posixExecutablePathResolver);
  });
});

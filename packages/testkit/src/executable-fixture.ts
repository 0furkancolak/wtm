import { chmod, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * What every darwin/linux fixture in this codebase used to be by itself: a `#!/usr/bin/env node`
 * file the OS could execute directly. The OS reads that line off the front and dispatches straight
 * to Node, which is the entire reason `writeFile` + `chmod` was ever enough. Windows has no such
 * dispatch — `CreateProcess` does not read the first line of a file to decide what runs it, so an
 * extensionless text file marked "executable" is still just a text file there.
 *
 * What Windows *does* recognise is a `.cmd` file: `child_process.spawn` sees that extension and
 * re-launches it through `cmd.exe` on its own. But that recognition happens on the extension of
 * the name the caller hands to `spawn`, not on what the file's sibling happens to be — a caller
 * still holding the bare, extension-less POSIX name gets `ENOENT`, not an automatic upgrade. So on
 * win32 this fixture is two files (a plain script holding `body`, and a `.cmd` one-liner that
 * `exec`s it through `node`) standing in for the one file darwin/linux gets, and `path` below is
 * whichever of them a caller must actually name to run it.
 */
export interface ExecutableFixture {
  /** What a caller should hand to `spawn`/`execFile`, or put on `PATH`, to *run* this fixture. */
  readonly path: string;
  /**
   * Where `body` actually landed. Equal to `path` on darwin/linux, where the one file is both —
   * but on win32 `path` is the `.cmd` trampoline, and content-level inspection (reading the source,
   * hashing it, asserting what its first line says) needs the file that source is actually *in*.
   */
  readonly scriptPath: string;
}

export interface ExecutableFixtureOptions {
  /**
   * POSIX file mode, applied with an explicit `chmod` after the write rather than trusted to
   * `writeFile`'s own `mode` option — the same belt-and-suspenders every call site already used,
   * because `writeFile`'s `mode` is filtered through the process `umask`, and a CI runner's umask
   * is not this codebase's to assume. Meaningless on win32 (no `chmod` runs there at all: a `.cmd`
   * file needs no execute bit, and Windows `chmod` cannot grant one).
   *
   * Defaults to `0o755`, matching every call site except the fake external adapter's `0o700`.
   */
  mode?: number;
  /**
   * The module system `body` is written in. `'commonjs'` (the default) covers every
   * `require(...)`-based shim in this codebase; the one caller whose body uses `import`/`export`
   * passes `'module'` so the win32 companion script gets an `.mjs` extension, which forces ESM
   * regardless of any `package.json` `"type"` field a temp directory happens to inherit — exactly
   * what that caller's own `.mjs` `basePath` already guarantees on darwin/linux.
   */
  module?: 'commonjs' | 'module';
  /**
   * Whether the write must fail if `basePath` (or its win32 companions) already exists —
   * `fs.writeFile`'s `'wx'` flag. Defaults to `true`, matching every call site that writes its
   * fixture once into a fixture directory it just created, where a silent overwrite would hide a
   * naming collision instead of failing loudly. The one caller that rewrites the same path to
   * change what running it does (`createFakeAdapter`'s `setScenario`) passes `false`.
   */
  exclusive?: boolean;
}

/**
 * Writes `body` — a Node.js program, without a hashbang of its own — to `basePath` so that running
 * {@link ExecutableFixture.path} executes it, on every platform WTM supports.
 *
 * darwin/linux: `path` is `basePath` itself, and the file at it is byte-for-byte what every one of
 * these fixtures wrote before this helper existed — `#!/usr/bin/env node` followed by `body`,
 * `chmod`ed executable. That is not incidental: it is the whole reason this exists as one function
 * migrated call sites can share rather than a rewrite of what they were doing, so a regression here
 * would be a regression in every scenario test that depends on a fake `git`.
 *
 * win32: `path` is `${basePath}.cmd`. `body` is written unmodified to a same-directory sibling
 * script and left to run under `node`, unmodified — a caller that put `process.platform` branches
 * in its own script *body* for the two OSes would be solving a problem this helper already removes.
 */
export async function writeExecutableFixture(
  basePath: string,
  body: string,
  options: ExecutableFixtureOptions = {},
): Promise<ExecutableFixture> {
  const { mode = 0o755, module = 'commonjs', exclusive = true } = options;
  const flag = exclusive ? 'wx' : 'w';

  if (process.platform === 'win32') {
    // The companion script keeps the exact module semantics `body` was written for: `.cjs` for
    // `require(...)`, `.mjs` for `import`/`export`. Either is unambiguous to Node by extension
    // alone, unlike `.js`, whose meaning depends on a `package.json` this fixture does not control.
    // A `basePath` that already ends in that extension (the fake adapter's own `.mjs` name) is
    // reused as-is rather than doubled into `name.mjs.mjs`.
    const expectedExtension = module === 'module' ? '.mjs' : '.cjs';
    const scriptPath = basePath.endsWith(expectedExtension) ? basePath : `${basePath}${expectedExtension}`;
    await writeFile(scriptPath, body, { flag });
    const cmdPath = `${basePath}.cmd`;
    await writeFile(cmdPath, [
      '@echo off',
      // `%~dp0` is the `.cmd` file's own directory, trailing backslash included — resolving the
      // sibling script relative to it (rather than embedding an absolute path) keeps this working
      // if the fixture directory is ever moved, and sidesteps quoting a path that may contain
      // spaces anywhere but here.
      `node "%~dp0${basename(scriptPath)}" %*`,
      // Without this, `.cmd`'s own exit code is whatever `cmd.exe` last set for unrelated reasons,
      // not the child's. `spawn` in the caller reads *this* process's exit code, so losing it here
      // would silently turn a fixture's designed failure into a reported success.
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'), { flag });
    return { path: cmdPath, scriptPath };
  }

  await writeFile(basePath, `#!/usr/bin/env node\n${body}`, { mode, flag });
  await chmod(basePath, mode);
  return { path: basePath, scriptPath: basePath };
}

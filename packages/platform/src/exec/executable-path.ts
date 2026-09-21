import { existsSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { PlatformId } from '../ports';

/**
 * How a command name becomes something `child_process.spawn` can actually start.
 *
 * On darwin and linux this question does not exist: `execvp` walks `PATH` itself and runs whatever
 * it finds, hashbang and all, so the name *is* the answer and this resolver hands it back
 * untouched. Nothing about a POSIX spawn changes because this exists.
 *
 * Windows has no `execvp`. libuv appends `.com` and `.exe` to an extension-less name and nothing
 * else — not `.cmd`, not `.bat`, whatever `PATHEXT` says — because those two are the only
 * extensions `CreateProcess` can start on its own. So a `git` that is installed as `git.cmd`
 * (a wrapper, a shim, a version manager) is invisible to `spawn('git')`, which either finds a
 * different `git.exe` further along `PATH` or fails with `ENOENT`. Neither outcome names the
 * problem, and the first is worse: WTM silently runs a `git` the user's `PATH` says should have
 * been shadowed.
 *
 * That is also, exactly, why every WTM scenario that shadows `git` or `gh` by writing a fixture
 * into a directory it puts first on `PATH` reported zero invocations on the win32 CI leg rather
 * than an error: `writeExecutableFixture` writes `git.cmd` there, and `spawn('git')` never looked
 * at it. The fixtures were made Windows-correct; the search that has to find them was not.
 *
 * So on win32 the resolution is done here, the way a shell does it — `PATH` in order, `PATHEXT`
 * within each entry — and `spawn` is handed the full path it produced. A name that already carries
 * a directory or an extension is its own answer and is returned unchanged; a name nothing matches
 * is returned unchanged too, so the failure the caller gets is still `spawn`'s own `ENOENT` and
 * not a different error invented here.
 */
export interface ExecutablePathResolver {
  (name: string): string;
}

/** The identity resolution: what `execvp` already does, said out loud. */
export const posixExecutablePathResolver: ExecutablePathResolver = (name) => name;

/**
 * `PATHEXT`'s documented default, used when the environment does not set it.
 *
 * `.COM` and `.EXE` are in the list although libuv would have found them by itself: this resolver
 * answers "what would a shell run", and a shell consults the whole list in order. Leaving them out
 * would make a directory holding both `git.exe` and `git.cmd` resolve to the `.cmd`, which is not
 * what the user's `PATH` means.
 */
const defaultPathExt = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

export interface WindowsExecutablePathResolverOptions {
  /** Defaults to `process.env`. Read on every call, never captured: a caller may change `PATH`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to a real `statSync`. The seam this resolver's own test resolves against. */
  isFile?: (path: string) => boolean;
}

function realIsFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); }
  catch { return false; }
}

export function createWindowsExecutablePathResolver(
  options: WindowsExecutablePathResolverOptions = {},
): ExecutablePathResolver {
  const isFile = options.isFile ?? realIsFile;
  return (name) => {
    if (name.length === 0) return name;
    // A name carrying a directory is a path, not a `PATH` lookup, and one carrying an extension
    // already says what it is -- `CreateProcess` and libuv both try it literally first.
    if (win32.isAbsolute(name) || name.includes('/') || name.includes('\\')) return name;
    if (win32.extname(name) !== '') return name;
    const env = options.env ?? process.env;
    const extensions = (env['PATHEXT'] ?? defaultPathExt)
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    for (const directory of (env['PATH'] ?? '').split(win32.delimiter)) {
      // An empty `PATH` entry means the current directory to `cmd.exe`, and deliberately does not
      // here: resolving a command out of the process's cwd is how a repository being analysed
      // gets to choose which `git` runs.
      if (directory.length === 0) continue;
      for (const extension of extensions) {
        const candidate = win32.join(directory, `${name}${extension}`);
        if (isFile(candidate)) return candidate;
      }
    }
    return name;
  };
}

/** The resolver for a platform, with the POSIX pair sharing the identity one. */
export function executablePathResolverFor(platform: PlatformId): ExecutablePathResolver {
  return platform === 'win32' ? createWindowsExecutablePathResolver() : posixExecutablePathResolver;
}

/**
 * The resolver for the host this process is running on.
 *
 * Unlike `selectPlatformRuntime`, an unrecognised `process.platform` is not an error here: the
 * identity resolution is what every platform but Windows needs, and it is also the honest answer
 * for a platform WTM has no backend for. Refusing to resolve a command name is not how a caller
 * should learn that its OS is unsupported.
 */
export function hostExecutablePathResolver(): ExecutablePathResolver {
  return process.platform === 'win32' ? createWindowsExecutablePathResolver() : posixExecutablePathResolver;
}

/**
 * Where each platform keeps WTM's files.
 *
 * The two resolvers have no shared derivation on purpose. macOS answers "where do my files go?"
 * with one directory — `~/Library/Application Support/WTM` holds the state database, the socket
 * and the global config together, because that is what the platform means by application support.
 * Linux answers it with four separate directories chosen by four separate environment variables,
 * because that is what the XDG base directory spec means by keeping state, configuration and
 * runtime files apart. Factoring the two into a common shape would produce a macOS layout wearing
 * XDG names, or an XDG layout with a hardcoded root; neither is either platform's convention.
 *
 * Nothing here reads `process.env` or `os.homedir()`. That is not a testing convenience: it is the
 * only reason the Linux layout can be resolved, asserted on and reviewed from a macOS development
 * machine, which is the entire premise of landing the Linux backend before there is a Linux CI job
 * to run it. A single ambient read would make the Linux resolver untestable here and the bug would
 * not surface until C2.
 */
import { isAbsolute, join } from 'node:path';
import type { PlatformId, PlatformPaths, PlatformPathsInput } from '../ports';

/** The global configuration file's name, on every platform. Only its directory differs. */
const configFileName = 'config.toml';

/**
 * macOS, which ignores the XDG variables entirely.
 *
 * A macOS user may well have `XDG_CONFIG_HOME` exported for some other tool. Honouring it here
 * would relocate an existing installation's state database the first time that user's shell
 * profile changed, which reads as data loss rather than as a configuration change — the daemon
 * would come up with an empty workspace and no explanation. So the variables are not consulted at
 * all, and `env` is accepted only to keep both resolvers one interface.
 */
export function darwinPlatformPaths({ home }: PlatformPathsInput): PlatformPaths {
  const libraryDirectory = join(home, 'Library');
  const dataRoot = join(libraryDirectory, 'Application Support', 'WTM');
  return {
    dataRoot,
    configPath: join(dataRoot, configFileName),
    logRoot: join(libraryDirectory, 'Logs', 'WTM'),
    // The socket has always lived beside the database here, and Increment B measured that path
    // against macOS's 104-byte `sun_path`. macOS offers no shorter per-user runtime directory to
    // move it to, so this stays a deliberate equality rather than a coincidence.
    socketRoot: dataRoot,
    serviceRoot: join(libraryDirectory, 'LaunchAgents'),
  };
}

/**
 * Linux, following the XDG base directory spec.
 *
 * `socketRoot` is the one field that is genuinely not a derivation of `dataRoot`:
 * `$XDG_RUNTIME_DIR` is normally `/run/user/<uid>`, which is both where the platform says sockets
 * belong — tmpfs, 0700, cleared at logout — and far shorter than any home directory, which is the
 * same address-length defect macOS had to be measured for. Its fallback is load-bearing: the
 * variable is absent inside containers and across `su`, and refusing to start there would be a
 * worse outcome than a long socket path that the preflight measures anyway.
 */
export function linuxPlatformPaths({ home, env }: PlatformPathsInput): PlatformPaths {
  const stateHome = xdgDirectory(env.XDG_STATE_HOME, join(home, '.local', 'state'));
  const configHome = xdgDirectory(env.XDG_CONFIG_HOME, join(home, '.config'));
  const runtimeDirectory = absoluteOrNull(env.XDG_RUNTIME_DIR);
  const dataRoot = join(stateHome, 'wtm');
  return {
    dataRoot,
    configPath: join(configHome, 'wtm', configFileName),
    // Logs follow the data root rather than `$XDG_CACHE_HOME`: they are the daemon's record of
    // what it did, which a user expects to survive a cache clear.
    logRoot: join(dataRoot, 'logs'),
    socketRoot: runtimeDirectory === null ? dataRoot : join(runtimeDirectory, 'wtm'),
    serviceRoot: join(configHome, 'systemd', 'user'),
  };
}

/**
 * Indexed rather than branched, so that widening `PlatformId` — Windows is a later increment — is
 * a type error here instead of a silent fall-through to the Linux layout.
 */
const resolvers: Readonly<Record<PlatformId, (input: PlatformPathsInput) => PlatformPaths>> = {
  darwin: darwinPlatformPaths,
  linux: linuxPlatformPaths,
};

export function platformPathsFor(id: PlatformId, input: PlatformPathsInput): PlatformPaths {
  return resolvers[id](input);
}

function xdgDirectory(value: string | undefined, fallback: string): string {
  return absoluteOrNull(value) ?? fallback;
}

/**
 * An XDG variable counts only when it holds an absolute path; the spec calls anything else
 * invalid and says to use the default. This is not pedantry about a rarely-read document:
 * `XDG_RUNTIME_DIR=tmp` would otherwise place the daemon's socket relative to whatever working
 * directory the service manager happened to start it in, so a client and a daemon that read the
 * same variable could still disagree about the address. An empty value is caught by the same
 * check, which is exactly what the spec asks for — it treats empty as unset.
 */
function absoluteOrNull(value: string | undefined): string | null {
  return value !== undefined && isAbsolute(value) ? value : null;
}

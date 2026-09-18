import { homedir } from 'node:os';
import { isAbsolute as posixIsAbsolute, resolve as posixResolve } from 'node:path/posix';
import { isAbsolute as win32IsAbsolute, resolve as win32Resolve } from 'node:path/win32';
import type { Remediation } from '@wtm/protocol';
import { createUnixSocketPublisher, createWindowsIpcPublisher } from './ipc';
import { platformPathsFor } from './paths';
import { socketAddressPolicyFor } from './socket';
import {
  createDarwinProcessPlatform,
  createLinuxProcessPlatform,
  createWindowsProcessPlatform,
} from './process';
import { darwinServiceBackend, linuxServiceBackend, windowsServiceBackend } from './service';
import {
  createCurrentWindowsUserSidReader,
  createWindowsAclReader,
  createWindowsFileTrustPolicy,
  posixFileTrustPolicy,
} from './trust';
import type { FileTrustPolicy, IpcServerPublisher, PlatformId, PlatformRuntime } from './ports';

/**
 * The one place in WTM that decides which operating system it is running on.
 *
 * Everything downstream takes a `PlatformRuntime` and asks it questions. That is the whole point of
 * the seam: a second `process.platform` branch anywhere else is a second place that has to be found
 * and changed when a platform is added, and the reason this increment exists is that WTM had those
 * branches scattered through core, the daemon and the CLI.
 */
export const supportedPlatforms: readonly PlatformId[] = ['darwin', 'linux', 'win32'];

/**
 * Raised when WTM is started somewhere it has no backend for.
 *
 * Carries a `WtmErrorCode` and an explicit `severity`, so the envelope and the exit code follow from
 * the error itself rather than from whichever handler catches it — the rule Increment B established
 * after a startup failure reached the user as a bare string.
 */
export class UnsupportedPlatformError extends Error {
  readonly code = 'WTM_PLATFORM_UNSUPPORTED' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;
  readonly remediation: readonly Remediation[];

  constructor(platform: string) {
    super(
      `WTM has no backend for ${platform}. Supported platforms: ${supportedPlatforms.join(', ')}.`,
    );
    this.name = 'UnsupportedPlatformError';
    this.context = { platform, supported: [...supportedPlatforms] };
    this.remediation = [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }];
  }
}

const processPlatforms = {
  darwin: createDarwinProcessPlatform,
  linux: createLinuxProcessPlatform,
  win32: createWindowsProcessPlatform,
} as const;

const serviceBackends = {
  darwin: darwinServiceBackend,
  linux: linuxServiceBackend,
  win32: windowsServiceBackend,
} as const;

/**
 * Built once, not per `selectPlatformRuntime` call, because both default readers share one pooled
 * `powershell.exe` session (`trust/windows-powershell-session.ts`) and a second policy object
 * would be a second pool. The "spawn per call" this used to do is exactly what made a *passing*
 * `logs.test.ts` burn ten minutes of the win32 CI budget; the pool keeps the same refusal
 * semantics and stops paying the cold-start import per ACL question.
 */
const windowsFileTrustPolicy: FileTrustPolicy = createWindowsFileTrustPolicy({
  readAcl: createWindowsAclReader(),
  currentUserSid: createCurrentWindowsUserSidReader(),
});

const fileTrustPolicies: Readonly<Record<PlatformId, FileTrustPolicy>> = {
  darwin: posixFileTrustPolicy,
  linux: posixFileTrustPolicy,
  win32: windowsFileTrustPolicy,
};

/**
 * The one port keyed on the **host**, not on the platform the caller asked for.
 *
 * Every other field of a `PlatformRuntime` describes a *target*: `paths` computes where macOS
 * would keep its state, `socket` states Linux's `sun_path` limit, `service` renders a systemd
 * unit. None of them touch the machine running the call, which is exactly why a Linux runtime can
 * be constructed and asserted from a macOS laptop. `fileTrust` is not like them. It answers "does
 * the current user own this directory, and can anyone else write it?" about a real path on the
 * real filesystem this process is looking at, through `fs.Stats` and, on Windows, a real
 * `powershell.exe`. Picking the implementation by the requested platform picks an implementation
 * of the *host's* APIs: ask a Windows runner for a `linux` runtime and it hands back
 * `posixFileTrustPolicy`, whose every answer is derived from `process.getuid()` — which does not
 * exist there. It cannot answer, so it fails closed, and the caller sees
 * `PrivateDirectoryError: WTM private directory is unavailable.` for a directory that is
 * perfectly fine.
 *
 * That is what turned `runtime-factory.test.ts`'s `a path only macOS refuses is accepted under
 * the Linux runtime` red on win32: a test about a 106-byte socket path could not get as far as
 * measuring one, because creating its own temporary data root was refused by a policy chosen for
 * an operating system the files are not on.
 *
 * Resolved on first use rather than at import, like the Windows reader pool above: a module-level
 * selection would make importing this file throw on a platform WTM has no backend for.
 */
let hostFileTrust: FileTrustPolicy | null = null;
function hostFileTrustPolicy(): FileTrustPolicy {
  if (hostFileTrust === null) {
    const host = process.platform;
    hostFileTrust = isSupported(host) ? fileTrustPolicies[host] : posixFileTrustPolicy;
  }
  return hostFileTrust;
}

/** Stateless, like `posixFileTrustPolicy` above — one instance is shared across every call. */
const unixSocketPublisher: IpcServerPublisher = createUnixSocketPublisher();
const windowsIpcPublisher: IpcServerPublisher = createWindowsIpcPublisher();

const ipcPublishers: Readonly<Record<PlatformId, IpcServerPublisher>> = {
  darwin: unixSocketPublisher,
  linux: unixSocketPublisher,
  win32: windowsIpcPublisher,
};

export interface SelectPlatformRuntimeOptions {
  platform?: NodeJS.Platform | string;
  env?: Readonly<Partial<Record<string, string>>>;
  home?: string;
}

/**
 * `platform`, `env` and `home` are all arguments rather than reads of the ambient process. That is
 * not a testing convenience: it is the only reason the Linux runtime can be constructed and
 * exercised from a macOS development machine, which is what lets the Linux backend be written in
 * the same increment as the seam instead of after it.
 *
 * `home` is validated here and nowhere else. The individual ports deliberately do not repeat the
 * check — a rule duplicated into four resolvers is a rule that will eventually disagree with
 * itself, and every port passes through this function.
 */
export function selectPlatformRuntime(options: SelectPlatformRuntimeOptions = {}): PlatformRuntime {
  const platform = options.platform ?? process.platform;
  if (!isSupported(platform)) throw new UnsupportedPlatformError(String(platform));
  // `platform` names which filesystem's path rules `home` was written in, and that can differ from
  // the host actually running this call -- the whole point of taking it as an argument (see this
  // function's own doc comment). The default `node:path` follows the *host*, so on a Windows host
  // asked for a `darwin`/`linux` runtime it mangled a POSIX `home` like `/Users/x` into
  // `D:\Users\x` (a real CI leg surfaced this). `isAbsolute`/`resolve` are picked by the injected
  // platform instead, the same way `platform-paths.ts` and `socket-path.ts` already choose their
  // path module explicitly rather than trusting the default.
  const { isAbsolute, resolve } = platform === 'win32'
    ? { isAbsolute: win32IsAbsolute, resolve: win32Resolve }
    : { isAbsolute: posixIsAbsolute, resolve: posixResolve };
  const rawHome = options.home ?? homedir();
  if (rawHome.length === 0 || !isAbsolute(rawHome)) {
    throw new TypeError(`WTM needs an absolute home directory, received ${JSON.stringify(rawHome)}`);
  }
  const home = resolve(rawHome);
  const env = options.env ?? process.env;
  return {
    id: platform,
    paths: platformPathsFor(platform, { home, env }),
    socket: socketAddressPolicyFor(platform),
    process: processPlatforms[platform](),
    service: serviceBackends[platform],
    // The host's, deliberately -- see `hostFileTrustPolicy`.
    fileTrust: hostFileTrustPolicy(),
    ipc: ipcPublishers[platform],
  };
}

function isSupported(value: NodeJS.Platform | string): value is PlatformId {
  return (supportedPlatforms as readonly string[]).includes(value);
}

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
 * Built once, not per `selectPlatformRuntime` call, because it wires two default readers that
 * each spawn a fresh `powershell.exe`, and every existing port in this package already treats
 * "spawn per call" as the norm for the platform it actually runs commands on — this is no
 * different.
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
    fileTrust: fileTrustPolicies[platform],
    ipc: ipcPublishers[platform],
  };
}

function isSupported(value: NodeJS.Platform | string): value is PlatformId {
  return (supportedPlatforms as readonly string[]).includes(value);
}

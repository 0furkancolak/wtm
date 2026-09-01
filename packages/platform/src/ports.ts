/**
 * What WTM needs to know about the machine it is running on, stated as ports.
 *
 * Everything the daemon does that differs by operating system reduces to four questions: where do
 * my files go, how long may a socket address be, how do I recognise a process I started, and how do
 * I make myself start at login. Each port answers exactly one of them. Nothing else in WTM is
 * allowed to ask the operating system directly — `@wtm/core` in particular must not, because item 9
 * of the roadmap makes "core is platform-independent" an acceptance criterion, and a core that
 * imports a platform is not made independent by the import being tidy.
 *
 * The ports are plain objects of functions. There is deliberately no abstract base class: the macOS
 * and Linux implementations share their signatures and nothing else, so a base class would exist
 * only to be overridden away.
 *
 * Every implementation takes `home` and `env` as arguments rather than reading `process`. That is
 * not a testing convenience bolted on afterwards — it is the only reason the Linux runtime can be
 * constructed, exercised and reasoned about from a macOS development machine at all.
 */

export type PlatformId = 'darwin' | 'linux';

/**
 * Where this platform keeps things.
 *
 * `socketRoot` is a field rather than a derivation from `dataRoot` because on Linux it genuinely is
 * one: `$XDG_RUNTIME_DIR` is the correct home for a Unix socket and is also far shorter than any
 * user's home directory, which is the same length defect macOS had to be measured for.
 */
export interface PlatformPaths {
  /** Holds the state database. */
  dataRoot: string;
  /** The global configuration file, not the directory holding it. */
  configPath: string;
  logRoot: string;
  /** Holds the daemon socket. Not necessarily inside `dataRoot`. */
  socketRoot: string;
  /** Where the service definition is published: `LaunchAgents`, or systemd's user unit directory. */
  serviceRoot: string;
}

export interface PlatformPathsInput {
  home: string;
  env: Readonly<Partial<Record<string, string>>>;
}

/**
 * How long a Unix socket address may be, and how the server derives the private path it binds
 * before linking the advertised name onto the same inode.
 *
 * The limit is `sizeof(sun_path)` for the platform and counts bytes, not characters: a home
 * directory holding non-ASCII is longer than it looks.
 */
export interface SocketAddressPolicy {
  limitBytes: number;
  boundPathFor(publishedPath: string): string;
}

/** The process is gone. Any other outcome is a failure, never an absence. */
export interface ProcessAbsent { status: 'absent' }
export interface ProcessPresent { status: 'present'; identity: ObservedProcessIdentity }
export interface ProcessInspectionFailed { status: 'failed'; reason: string }
export type ProcessInspection = ProcessAbsent | ProcessPresent | ProcessInspectionFailed;

export interface ObservedProcessIdentity {
  pid: number;
  pgid: number;
  /**
   * Opaque, compared only for equality, and never interpreted. Its spelling differs by platform on
   * purpose: macOS stores a `ps` `lstart` string, Linux stores `<btime>:<starttime>` in decimal, and
   * the two can never be equal — which is why one schema column holds both without a version tag.
   */
  processStartTime: string;
  commandFingerprint: string;
}

export type ProcessGroupInspection =
  | ProcessAbsent
  | { status: 'present'; pids: number[] }
  | ProcessInspectionFailed;

export interface ProcessPlatform {
  /**
   * The start time alone, for lease ownership. Resolves `null` when the process is absent, and
   * throws for anything else: a wrong `null` releases somebody else's lease.
   */
  readStartTime(pid: number): Promise<string | null>;
  inspectProcess(pid: number): Promise<ProcessInspection>;
  inspectProcessGroup(pgid: number): Promise<ProcessGroupInspection>;
}

export interface ServiceDefinitionOptions {
  label: string;
  executable: string;
  args: readonly string[];
  workingDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
  pathEnvironment: string;
  home: string;
}

/**
 * What the *publisher* concludes about the service, having seen both the manager and the disk.
 * `installed-not-loaded` is deliberately not something a backend can report on its own.
 */
export type ServiceStatusState = 'loaded' | 'installed-not-loaded' | 'absent';

/**
 * The service port is declared in `./service/types.ts`, beside its two implementations, and the
 * declaration there is authoritative.
 *
 * This file originally carried its own `ServiceBackend`, `ServiceCommandSet` and
 * `ServiceCommandResult`, written before anyone had read the 2580-line module they were meant to
 * describe. Two of those shapes were wrong, and task C1-4 reported them rather than bending the
 * code to fit:
 *
 * - `ServiceCommandResult` was modelled as a raw child-process result, `{ code, signal, ... }`.
 *   What the publisher actually needs is the runner's *classification* of the exit status, because
 *   `launchctl` reports a missing service as exit 113 and `systemctl` as exit 5, and treating that
 *   as a failure rather than as an absence is the entire difference between `uninstall` being
 *   idempotent and `uninstall` throwing.
 * - `interpretStatus` was typed to return `installed-not-loaded`, which no command result can
 *   establish: that state is a manager without the job *plus* a definition still on disk, and only
 *   the shared publisher sees both.
 *
 * The sketch also omitted six things that turned out to be genuine backend knowledge — the
 * directory plan, the definition suffix, the default `PATH`, two refusal wordings, and the command
 * name a failure names. Keeping the sketch here beside the corrected declaration would leave two
 * descriptions of one port, and the wrong one would win an argument eventually. So it is deleted,
 * and `PlatformRuntime` below refers to the real thing.
 */
export type {
  LegacyServiceMigration,
  ManagedDirectory,
  ObservedServiceState,
  ServiceBackend,
  ServiceCommandOutcome,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceCommandSet,
  ServiceDirectoryInput,
  ServiceDirectoryPlan,
  ServiceProcessInspection,
  ServiceProcessInspector,
} from './service/types';

export interface PlatformRuntime {
  readonly id: PlatformId;
  readonly paths: PlatformPaths;
  readonly socket: SocketAddressPolicy;
  readonly process: ProcessPlatform;
  readonly service: import('./service/types').ServiceBackend;
}

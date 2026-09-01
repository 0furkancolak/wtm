/**
 * What a service manager is, to the code that publishes a definition for it.
 *
 * `packages/daemon/src/service-lifecycle.ts` is a transactional publisher: an operation lock, a
 * journal, file-identity checks, an atomic publish and removal, and interrupted-transaction
 * recovery. None of that is launchd knowledge, and none of it is systemd knowledge. What *is*
 * platform knowledge is small and enumerable, and this is the list of it: the label, the
 * definition file's body, the directories it lives under, the argument vectors, how to read a
 * status out of the manager's own output, and — on macOS only — the label migration a previous
 * increment left behind.
 *
 * This file is the authoritative declaration of the service port. `../ports.ts` originally carried
 * its own sketch of it, written before anyone had read the module it was meant to describe, and two
 * of its shapes were wrong:
 *
 * 1. `ServiceCommandResult` was a raw child-process result, `{ code, signal, stdout, stderr }`.
 *    What the publisher needs is the runner's *classification* of the exit status: `launchctl`
 *    reports a missing service as exit 113 and `systemctl` as exit 5, and treating that as a
 *    failure rather than as an absence is the whole difference between `uninstall` being idempotent
 *    and `uninstall` throwing. Adopting the sketch would have meant rewriting the fake runner in
 *    ~60 pre-existing tests — the one change this refactor was forbidden to make.
 * 2. `interpretStatus` was typed to return `installed-not-loaded`, which no command result can
 *    establish: that state is a manager without the job *plus* a definition still on disk, and only
 *    the shared publisher sees both. It is narrowed here to the two states a result can support,
 *    and the narrowed type is still drawn from the port's so the narrowing is visible as one.
 *
 * The mismatch was reported rather than papered over, and `../ports.ts` was corrected: it now
 * re-exports these declarations instead of restating them, so there is one description of this port
 * rather than two free to drift apart.
 */
import type {
  PlatformId,
  PlatformPaths,
  PlatformPathsInput,
  ServiceDefinitionOptions,
  ServiceStatusState,
} from '../ports';

/**
 * How a command's exit status is classified, by the runner that ran it.
 *
 * `not-found` is not a failure. It is the manager saying it does not know this service, which is
 * a legitimate answer to `print`, to `bootout` and to `stop`, and the classification lives with
 * the runner because the exit code that means it (113 for `launchctl`, 5 for `systemctl`) is the
 * one piece of this that is neither the argument vector nor the state machine.
 */
export type ServiceCommandOutcome = 'success' | 'not-found' | 'failure';

export interface ServiceCommandResult {
  outcome: ServiceCommandOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ServiceCommandRunner = (argv: readonly string[]) => Promise<ServiceCommandResult>;

/**
 * The argument vectors this manager understands.
 *
 * `reload` and `disable` are optional because launchd has neither: it reads the definition at
 * `bootstrap` time and has no separate registration to undo. systemd has both, and omitting either
 * would leave a stale unit cached or a dangling `default.target.wants` symlink behind an
 * uninstall. Every step the shared lifecycle takes for them is skipped entirely when they are
 * absent, which is what makes the macOS sequence provably unchanged.
 */
export interface ServiceCommandSet {
  /** Reports the loaded service, if any. */
  print: readonly string[];
  /** Reports the user domain itself, which distinguishes "no service" from "no session". */
  printDomain: readonly string[];
  /** Makes a newly published definition visible to the service manager. */
  reload?: readonly string[];
  enable: readonly string[];
  disable?: readonly string[];
  bootstrap: readonly string[];
  bootout: readonly string[];
  kickstart: readonly string[];
}

/** What a command result can establish on its own about the manager's view of the service. */
export type ObservedServiceState = Extract<ServiceStatusState, 'loaded' | 'absent'>;

export interface ServiceProcessInspection {
  state: 'live' | 'dead' | 'unknown';
  startIdentity: string | null;
}

/**
 * How the lock names its owner. `unknown` is not `dead`: a lock whose owner cannot be observed is
 * left alone, because stealing it would remove the only mutual exclusion two processes share.
 */
export interface ServiceProcessInspector {
  current(): Promise<{ pid: number; startIdentity: string }>;
  inspect(pid: number): Promise<ServiceProcessInspection>;
}

/**
 * The definition an earlier version of this product published under a different name, and how to
 * recognise the copy that belongs to this HOME.
 *
 * macOS only. Linux has never published a WTM unit under any name, so its descriptor omits this
 * and every migration step disappears with it — there is no Linux hook here to keep true.
 */
export interface LegacyServiceMigration {
  /** The bare label every installation used before the label was derived per HOME. */
  label: string;
  /**
   * Whether a legacy definition found on disk is *this* HOME's. The publisher checks containment,
   * ownership, mode and link count but never authorship, so the definition has to say for itself
   * which HOME it belongs to.
   */
  declaresHome(content: string, home: { home: string; stdoutPath: string }): boolean;
}

/** A directory the lifecycle creates and then requires to keep its identity. */
export interface ManagedDirectory {
  path: string;
  /** Whether group and other bits must be clear, not merely the write bits. */
  ownerOnly: boolean;
}

export interface ServiceDirectoryPlan {
  /** The outermost directory the publisher validates down from and may never escape. */
  root: string;
  /** Ensured before every operation: the chain down to the definition directory. */
  definition: readonly ManagedDirectory[];
  /** Ensured before `install`: the definition chain, plus the data and log roots. */
  install: readonly ManagedDirectory[];
}

export interface ServiceDirectoryInput {
  home: string;
  serviceRoot: string;
  dataRoot: string;
  logRoot: string;
}

export interface ServiceBackend {
  readonly id: PlatformId;
  /** How a user names this service manager to themselves: `launchd`, `systemd`. */
  readonly managerName: string;
  /** The executable the argument vectors invoke, named in the error a failed command raises. */
  readonly commandName: string;
  /** Refusal wording when the manager itself cannot be reached: no session, no bus, no domain. */
  readonly domainUnavailableMessage: string;
  /** The definition file's extension, including the dot. Every managed filename is built on it. */
  readonly definitionSuffix: string;
  /** What `PATH` an installed service gets when the installing process has none to pass on. */
  readonly defaultPathEnvironment: string;
  /** Refusal wording when the host is not this backend's platform. */
  readonly unsupportedPlatformMessage: string;
  /**
   * The same resolver `PlatformRuntime.paths` uses, reachable from the backend so a lifecycle can
   * still be constructed from a HOME alone. The CLI does exactly that today; once the composition
   * roots pass a `PlatformRuntime` (C1-6, C1-7) they will pass the resolved paths instead, and
   * this stays the answer for every caller that has only a HOME.
   */
  resolvePaths(input: PlatformPathsInput): PlatformPaths;
  labelFor(home: string): string;
  definitionPath(input: { serviceRoot: string; label: string }): string;
  directories(input: ServiceDirectoryInput): ServiceDirectoryPlan;
  renderDefinition(options: ServiceDefinitionOptions): string;
  commands(input: { uid: number; label: string; definitionPath: string }): ServiceCommandSet;
  /**
   * What a successful `print` says about the manager's view of the service. Called only for a
   * `success` result: a `not-found` is already an absence, and a `failure` is reported as one.
   */
  interpretStatus(result: ServiceCommandResult): ObservedServiceState;
  /** The manager's own word for what the job is doing, reported verbatim to the user. */
  runState(result: ServiceCommandResult): string | null;
  defaultCommandRunner: ServiceCommandRunner;
  defaultProcessInspector: ServiceProcessInspector;
  legacyMigration?: LegacyServiceMigration;
}

/**
 * The transactional publisher for a service definition, over a backend descriptor.
 *
 * This module was `launchd.ts`, and roughly four-fifths of it never was launchd knowledge: an
 * operation lock, a journal, file-identity checks, an atomic publish and removal, and
 * interrupted-transaction recovery. All of that is what it takes to change one file that another
 * program reads, safely, from a process that may be killed between any two syscalls, while a
 * second copy of itself is doing the same thing. None of it changes when the program reading the
 * file is `systemd` rather than `launchd`.
 *
 * What does change is small and enumerable, and it lives in `@wtm/platform/service`: the label,
 * the definition body, the directories it goes in, the argument vectors, and how to read a status
 * out of the manager's own output. This module knows none of those and asks the backend.
 *
 * **The error codes still spell `LAUNCHD`, on both platforms, and so does the wording of most of
 * the messages.** That is deliberate. `packages/cli/src/commands/daemon.ts` maps exactly those
 * codes onto the JSON envelope and `docs/18-errors-json-contract.md` publishes them; neither is
 * owned by this task, and renaming them here would change a published contract as a side effect
 * of a refactor whose entire premise is that the macOS behaviour is unchanged afterwards. The
 * messages that name a *command* are the exception -- `launchctl print failed.` would be a lie
 * about systemd rather than merely a stale word -- and those come from the backend.
 */
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ServiceLifecycleError,
  assertAbsolutePath,
  configurationError,
  pathError,
  sanitizeCommandOutput,
  sanitizePathEnvironment,
  transactionPathError,
} from '@wtm/platform/service';
/**
 * The identity primitive, shared rather than restated.
 *
 * `sameInode` and its 57 call sites below are not the defect the first Linux CI run exposed --
 * `readSafeManagedFile` is. It opens the plist, describes it, and closes the descriptor before the
 * description is ever compared against anything. A description of an object is forgeable on a
 * filesystem that reissues inode numbers; a reference to one is not. Holding the descriptor across
 * the check-then-use window makes every one of those 57 comparisons true again without editing a
 * single one, and gives the boundaries below a positive answer -- `nlink === 0` -- for the case the
 * tuple cannot see. `@wtm/core/resources/guard` owns the primitive because the resource sandbox
 * needed exactly the same repair; the alternative was the same twenty lines in two packages, and
 * a duplicated safety predicate is how the two halves drift apart.
 */
import { pinInode, type InodePin } from '@wtm/core/resources/guard';
import type {
  LegacyServiceMigration,
  ManagedDirectory,
  ServiceBackend,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceCommandSet,
  ServiceProcessInspection,
  ServiceProcessInspector,
} from '@wtm/platform/service';

const maxManagedDefinitionBytes = 64 * 1024;
const maxTransactionMetadataBytes = 16 * 1024;
const maxOwnerPredecessors = 8;

/**
 * Every path one HOME's service occupies, resolved once.
 *
 * `root` is not always `home`. On macOS it is: everything launchd reads is under `~/Library`. On
 * Linux an XDG variable may put the unit directory outside the home entirely, and the directory
 * the publisher walks down from and may never escape is then that base, not a home the files have
 * nothing to do with.
 */
export interface ServicePaths {
  home: string;
  /** The label this HOME publishes under; every managed filename is built from it. */
  label: string;
  /** The outermost directory the publisher validates from and may never escape. */
  root: string;
  serviceDirectory: string;
  /**
   * Whether the definition directory must be owner-only, or merely unwritable by anyone else.
   *
   * It is the backend's answer because it is a question about who owns the directory.
   * `~/Library/LaunchAgents` is WTM's to keep at 0700; `~/.config/systemd/user` is shared with
   * `systemctl enable`'s symlinks and is 0755 on every machine with the standard umask. The check
   * that actually defends the daemon -- no group or other *write*, so nobody else can plant a
   * definition it would execute -- applies either way, and the definition file itself is 0600 on
   * both platforms, so the looser directory does not expose it.
   */
  serviceDirectoryOwnerOnly: boolean;
  definitionPath: string;
  /** `.plist`, `.service`: the suffix every managed sibling filename is built on. */
  definitionSuffix: string;
  /** The label an installation made before the label was derived used, where there is one. */
  legacyLabel: string | null;
  /** Where such an installation left its definition. */
  legacyDefinitionPath: string | null;
  definitionDirectories: readonly ManagedDirectory[];
  installDirectories: readonly ManagedDirectory[];
  dataRoot: string;
  logRoot: string;
  stdoutPath: string;
  stderrPath: string;
}

/** What a managed-file helper needs to know: what it may not escape, and what it is publishing into. */
export interface ServiceScope {
  root: string;
  serviceDirectory: string;
  serviceDirectoryOwnerOnly: boolean;
}

export type ServiceTransactionPhase =
  | 'lock-linked'
  | 'lock-owned'
  | 'before-stale-lock-claim'
  | 'takeover-claim-linked'
  | 'takeover-claim-owned'
  | 'before-claim-recovery-move'
  | 'stale-lock-moved'
  | 'restore-linked'
  | 'before-restore-link'
  | 'publish-prepared'
  | 'temporary-written'
  | 'temporary-adopted'
  | 'journal-temporary-adopted'
  | 'journal-temporary-removed'
  | 'temporary-created'
  | 'old-quarantined'
  | 'new-linked'
  | 'temporary-unlinked'
  | 'before-enable'
  | 'after-enable'
  | 'after-bootstrap'
  | 'final-cleanup'
  | 'removal-prepared'
  | 'removal-quarantined'
  | 'removal-cleaned';

export type ServiceInstallState = 'installed' | 'reinstalled' | 'restarted' | 'already-installed';
export type ServiceUninstallState = 'uninstalled' | 'already-absent';
export type ServiceStatusState = 'loaded' | 'installed-not-loaded' | 'absent';

export interface ServiceLifecycleResult<State extends string> {
  action: 'install' | 'uninstall' | 'status';
  state: State;
  label: string;
  definitionPath: string;
}

export interface ServiceStatusResult extends ServiceLifecycleResult<ServiceStatusState> {
  /**
   * The manager's own word for the job: `running` while a process is alive, `not running` when
   * launchd has the job but it is idle, systemd's substate where that is what answered, and
   * `null` when the manager does not know the job at all.
   */
  runState: string | null;
}

export interface ServiceLifecycle {
  install(): Promise<ServiceLifecycleResult<ServiceInstallState>>;
  uninstall(): Promise<ServiceLifecycleResult<ServiceUninstallState>>;
  status(): Promise<ServiceStatusResult>;
}

export interface ServiceLifecycleOptions {
  backend: ServiceBackend;
  home?: string;
  /** Read only by backends whose paths depend on it; macOS ignores it, XDG does not. */
  env?: Readonly<Partial<Record<string, string>>>;
  uid?: number;
  fileOwnerUid?: number;
  platform?: NodeJS.Platform;
  programArguments: readonly string[];
  pathEnvironment?: string;
  commandRunner?: ServiceCommandRunner;
  absencePollAttempts?: number;
  publicationHook?: (
    phase: 'before-publish' | 'before-replace-move' | 'before-link',
    definitionPath: string,
  ) => void | Promise<void>;
  removalHook?: (phase: 'before-remove' | 'before-quarantine', definitionPath: string) => void | Promise<void>;
  processInspector?: ServiceProcessInspector;
  lockPollAttempts?: number;
  transactionHook?: (phase: ServiceTransactionPhase) => 'continue' | 'interrupt' | Promise<'continue' | 'interrupt'>;
  metadataReadHook?: (path: string) => void | Promise<void>;
}

/**
 * Where this HOME's service lives, on this backend.
 *
 * `home` is validated and resolved here and nowhere below: every managed filename, the label and
 * the containment check are all built from the one resolved value, so there is no second reading
 * of it that could disagree.
 */
export function servicePathsFor(
  backend: ServiceBackend,
  input: { home: string; env?: Readonly<Partial<Record<string, string>>> },
): ServicePaths {
  assertAbsolutePath(input.home, `${backend.managerName} home`);
  const home = resolve(input.home);
  const platformPaths = backend.resolvePaths({ home, env: input.env ?? {} });
  const label = backend.labelFor(home);
  const serviceDirectory = platformPaths.serviceRoot;
  const plan = backend.directories({
    home,
    serviceRoot: serviceDirectory,
    dataRoot: platformPaths.dataRoot,
    logRoot: platformPaths.logRoot,
  });
  // The plan's last definition entry *is* the service directory, and its mode requirement is the
  // one every check below applies. Asserting it here rather than trusting it keeps a backend from
  // publishing into a directory the lifecycle then vouches for under different terms.
  const definitionDirectory = plan.definition.at(-1);
  if (definitionDirectory === undefined || resolve(definitionDirectory.path) !== resolve(serviceDirectory)) {
    throw configurationError(`${backend.managerName} directory plan must end at the service directory`);
  }
  const migration = backend.legacyMigration;
  return {
    home,
    label,
    root: plan.root,
    serviceDirectory,
    serviceDirectoryOwnerOnly: definitionDirectory.ownerOnly,
    definitionPath: backend.definitionPath({ serviceRoot: serviceDirectory, label }),
    definitionSuffix: backend.definitionSuffix,
    legacyLabel: migration?.label ?? null,
    legacyDefinitionPath: migration === undefined
      ? null
      : backend.definitionPath({ serviceRoot: serviceDirectory, label: migration.label }),
    definitionDirectories: plan.definition,
    installDirectories: plan.install,
    dataRoot: platformPaths.dataRoot,
    logRoot: platformPaths.logRoot,
    stdoutPath: join(platformPaths.logRoot, 'daemon.log'),
    stderrPath: join(platformPaths.logRoot, 'daemon.error.log'),
  };
}

export function createServiceLifecycle(options: ServiceLifecycleOptions): ServiceLifecycle {
  const backend = options.backend;
  const manager = backend.managerName;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const paths = servicePathsFor(backend, { home, env: options.env ?? process.env });
  const uid = nonNegativeInteger(options.uid ?? process.getuid?.() ?? -1, `${manager} uid`);
  const ownerUid = nonNegativeInteger(options.fileOwnerUid ?? process.getuid?.() ?? uid, `${manager} file owner uid`);
  const migration = backend.legacyMigration;
  const commands = backend.commands({ uid, label: paths.label, definitionPath: paths.definitionPath });
  const legacyCommands = paths.legacyDefinitionPath === null || migration === undefined
    ? null
    : backend.commands({ uid, label: migration.label, definitionPath: paths.legacyDefinitionPath });
  const runner = options.commandRunner ?? backend.defaultCommandRunner;
  const pollAttempts = positiveInteger(options.absencePollAttempts ?? 20, `${manager} absence poll attempts`);
  const lockPollAttempts = positiveInteger(options.lockPollAttempts ?? 100, `${manager} lock poll attempts`);
  const processInspector = options.processInspector ?? backend.defaultProcessInspector;
  const pathEnvironment = sanitizePathEnvironment(
    options.pathEnvironment ?? process.env.PATH ?? backend.defaultPathEnvironment,
    manager,
  );
  if (options.programArguments.length === 0) throw configurationError(`${manager} argv must not be empty`);
  const definition = backend.renderDefinition({
    label: paths.label,
    executable: options.programArguments[0] as string,
    args: options.programArguments.slice(1),
    workingDirectory: paths.home,
    standardOutPath: paths.stdoutPath,
    standardErrorPath: paths.stderrPath,
    pathEnvironment,
    home: paths.home,
  });

  const commandContext = (operation: string, result: ServiceCommandResult): Record<string, string | number | null> => ({
    operation,
    exitCode: result.exitCode,
    stdout: sanitizeCommandOutput(result.stdout),
    stderr: sanitizeCommandOutput(result.stderr),
  });

  const commandError = (operation: string, result: ServiceCommandResult): ServiceLifecycleError =>
    // Every operation funnels through here, which is why the unreachable-manager case is answered
    // here rather than at each of the dozen call sites. A manager that never answered has not
    // failed at the thing it was asked to do; saying `${backend.commandName} print failed` sends
    // the reader to debug a service nobody ever got to ask about. macOS reached this conclusion
    // through `printDomain` and had a code for it since before the seam existed -- Linux was
    // reporting the identical condition as an unclassified failure at exit 1, where macOS reports
    // it as `WTM_DAEMON_UNAVAILABLE` at exit 4.
    result.outcome === 'manager-unreachable'
      ? new ServiceLifecycleError(
        'LAUNCHD_DOMAIN_UNAVAILABLE',
        backend.domainUnavailableMessage,
        commandContext(operation, result),
      )
      : new ServiceLifecycleError(
        'LAUNCHD_COMMAND_FAILED',
        `${backend.commandName} ${operation} failed.`,
        commandContext(operation, result),
      );

  /** The manager saying it does not know this service, however it chose to say it. */
  const isAbsentResult = (result: ServiceCommandResult): boolean => result.outcome === 'not-found';
  const printedAbsent = (result: ServiceCommandResult): boolean => isAbsentResult(result)
    || (result.outcome === 'success' && backend.interpretStatus(result) === 'absent');

  const assertPlatform = () => {
    if (platform !== backend.id) {
      throw new ServiceLifecycleError('LAUNCHD_UNSUPPORTED_PLATFORM', backend.unsupportedPlatformMessage);
    }
  };

  const describe = async (): Promise<{ loaded: boolean; runState: string | null }> => {
    const service = await runner(commands.print);
    if (service.outcome === 'success' && backend.interpretStatus(service) === 'loaded') {
      return { loaded: true, runState: backend.runState(service) };
    }
    if (!printedAbsent(service)) throw commandError('print', service);
    const domain = await runner(commands.printDomain);
    if (domain.outcome !== 'success') {
      throw new ServiceLifecycleError(
        'LAUNCHD_DOMAIN_UNAVAILABLE',
        backend.domainUnavailableMessage,
        commandContext('print-domain', domain),
      );
    }
    return { loaded: false, runState: null };
  };

  const loaded = async (): Promise<boolean> => (await describe()).loaded;

  const waitUntilAbsent = async (print: readonly string[] = commands.print): Promise<void> => {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const result = await runner(print);
      if (printedAbsent(result)) return;
      if (result.outcome !== 'success') throw commandError('print', result);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(10 * (attempt + 1), 50)));
    }
    throw new ServiceLifecycleError('LAUNCHD_COMMAND_FAILED', `${manager} service did not stop in time`, {
      operation: 'bootout', attempts: pollAttempts,
    });
  };

  /**
   * Makes a newly published definition visible to a manager that caches them. launchd has no such
   * command and this is skipped entirely there, which is what keeps the macOS command sequence
   * exactly what it was.
   */
  const reloadDefinitions = async (transaction: ServiceTransaction): Promise<void> => {
    if (commands.reload === undefined) return;
    await transaction.assertOwned();
    const reloaded = await runner(commands.reload);
    if (reloaded.outcome !== 'success') throw commandError('reload', reloaded);
  };

  /**
   * Undoes the registration `enable` made. Absent on launchd, where `bootout` leaves nothing
   * behind; on systemd it is the `default.target.wants` symlink, and an uninstall that skipped it
   * would leave the unit pointing at a file it has just deleted.
   */
  const disableService = async (transaction: ServiceTransaction): Promise<void> => {
    if (commands.disable === undefined) return;
    await transaction.assertOwned();
    const disabled = await runner(commands.disable);
    if (disabled.outcome !== 'success' && !isAbsentResult(disabled)) throw commandError('disable', disabled);
  };

  const legacyServiceLoaded = async (): Promise<boolean> => {
    const printed = await runner((legacyCommands as ServiceCommandSet).print);
    if (printed.outcome === 'success' && backend.interpretStatus(printed) === 'loaded') return true;
    if (!printedAbsent(printed)) throw commandError('legacy-print', printed);
    return false;
  };

  const bootOutLegacyService = async (transaction: ServiceTransaction): Promise<void> => {
    if (!await legacyServiceLoaded()) return;
    await transaction.assertOwned();
    const bootout = await runner((legacyCommands as ServiceCommandSet).bootout);
    if (bootout.outcome !== 'success' && !isAbsentResult(bootout)) throw commandError('legacy-bootout', bootout);
    await waitUntilAbsent((legacyCommands as ServiceCommandSet).print);
  };

  /**
   * The only legacy service this HOME may touch is the one its own definition declares. A legacy
   * service loaded from another HOME's definition is that HOME's daemon: booting it out would turn
   * a reporting bug into a destructive one, so nothing here is done unless this HOME's own legacy
   * definition is present and names this HOME.
   *
   * The sweep is unconditional. The derived label is what makes an old-label journal, lock or
   * quarantine unreachable -- `validateJournal` rebuilds those names from the label and rejects
   * anything else as an unsafe path -- so this is the last code that can still recognise them.
   */
  const takeOverLegacyLabel = async (transaction: ServiceTransaction): Promise<FileSnapshot | null> => {
    const legacy = await readAdoptableLegacyDefinition(paths, migration, ownerUid);
    if (legacy !== null) await bootOutLegacyService(transaction);
    await sweepLegacyLabelArtifacts(paths, ownerUid, processInspector, transaction);
    return legacy;
  };

  const removeLegacyDefinition = async (legacy: FileSnapshot, transaction: ServiceTransaction): Promise<void> => {
    const current = await readAdoptableLegacyDefinition(paths, migration, ownerUid);
    // Anything but the exact file the takeover examined is left alone: it is no longer the
    // definition this migration reasoned about.
    if (current === null || !sameFileIdentity(legacy.identity, current.identity)) return;
    await transaction.assertOwned();
    await removeSafeManagedFile(paths, paths.legacyDefinitionPath as string, ownerUid, current.identity);
  };

  /** Deletes the old definition only once this HOME's own is published in its place. */
  const retireLegacyDefinition = async (legacy: FileSnapshot, transaction: ServiceTransaction): Promise<void> => {
    if (await readSafeManagedFile(paths, paths.definitionPath, ownerUid) === null) return;
    await removeLegacyDefinition(legacy, transaction);
  };

  /**
   * `status` finishes a takeover; it never starts one it cannot finish. It has no definition to
   * publish, so it removes the legacy definition only when this HOME's own is already published,
   * and boots the legacy service out only when this HOME's own service is loaded to answer in its
   * place. Where those do not hold it reports the derived label's own truth and touches nothing:
   * a command that reads state must not stop the only daemon the user has.
   */
  const finishLegacyLabelMigration = async (): Promise<void> => {
    const legacy = await readAdoptableLegacyDefinition(paths, migration, ownerUid);
    if (legacy === null && (await legacyLabelArtifactNames(paths)).length === 0) return;
    const published = await readSafeManagedFile(paths, paths.definitionPath, ownerUid);
    const handOver = legacy !== null && published !== null
      && (!await legacyServiceLoaded() || await loaded());
    await withServiceOperationLock(
      paths, ownerUid, processInspector, lockPollAttempts, options.transactionHook, options.metadataReadHook,
      async (transaction) => {
        if (handOver) await bootOutLegacyService(transaction);
        await sweepLegacyLabelArtifacts(paths, ownerUid, processInspector, transaction);
        if (handOver) await retireLegacyDefinition(legacy as FileSnapshot, transaction);
      },
    );
  };

  /**
   * The install proper, under this HOME's derived label. It is a named step so the legacy
   * takeover can bracket it: the old service is booted out before this publishes, and the old
   * definition is only deleted once this has succeeded -- a failure here rolls back to the
   * previous derived definition and leaves the legacy one exactly where it was found.
   */
  const publishDerivedInstall = async (
    transaction: ServiceTransaction,
  ): Promise<ServiceLifecycleResult<ServiceInstallState>> => {
    const existing = await readSafeManagedFile(paths, paths.definitionPath, ownerUid);
    const wasLoaded = await loaded();
    if (wasLoaded && existing?.content === definition) {
      await transaction.assertOwned();
      const enable = await runner(commands.enable);
      if (enable.outcome !== 'success') throw commandError('enable', enable);
      // The definition names the executable by path, so installing a new build over the
      // old one leaves this definition byte-identical while the manager goes on running the
      // previous binary. Returning here was what let `make install` report success and
      // change nothing: every command afterwards was answered by the daemon installed
      // before it, and verifying the new build was impossible. Restarting the service in
      // place is both the fix and the cheapest guarantee that the daemon now running is
      // the one just installed.
      await transaction.assertOwned();
      const kickstart = await runner(commands.kickstart);
      if (kickstart.outcome !== 'success') throw commandError('kickstart', kickstart);
      return lifecycleResult('install', 'restarted', paths);
    }

    const changed = existing?.content !== definition;
    let publishedIdentity: FileIdentity | undefined;
    let bootoutAccepted = false;
    try {
      if (wasLoaded) {
        await transaction.assertOwned();
        const bootout = await runner(commands.bootout);
        if (bootout.outcome !== 'success' && !isAbsentResult(bootout)) throw commandError('bootout', bootout);
        bootoutAccepted = true;
        await waitUntilAbsent();
      }
      if (changed) {
        publishedIdentity = await publishSafeManagedFile(
          paths,
          paths.definitionPath,
          definition,
          ownerUid,
          options.publicationHook,
          transaction,
        );
        await reloadDefinitions(transaction);
      }
      await runTransactionHook(transaction, 'before-enable');
      await transaction.assertOwned();
      const enable = await runner(commands.enable);
      if (enable.outcome !== 'success') throw commandError('enable', enable);
      await runTransactionHook(transaction, 'after-enable');
      await transaction.assertOwned();
      const bootstrap = await runner(commands.bootstrap);
      if (bootstrap.outcome === 'success') {
        await runTransactionHook(transaction, 'after-bootstrap');
        await runTransactionHook(transaction, 'final-cleanup');
        return lifecycleResult('install', wasLoaded ? 'reinstalled' : 'installed', paths);
      }
      const concurrentWinner = await loaded().catch(() => false);
      if (concurrentWinner) return lifecycleResult('install', 'already-installed', paths);
      throw commandError('bootstrap', bootstrap);
    } catch (installError) {
      if (isTransactionInterruption(installError)) throw installError;
      if (!bootoutAccepted && publishedIdentity === undefined) throw installError;
      transaction.failureContext = installError instanceof ServiceLifecycleError ? installError.context : {};
      try {
        await restorePreviousDefinition(paths, ownerUid, existing, publishedIdentity, transaction);
        if (publishedIdentity !== undefined) await reloadDefinitions(transaction);
        if (bootoutAccepted) {
          if (existing === null) throw new Error('Previous loaded definition has no recoverable definition file');
          await transaction.assertOwned();
          const rollbackEnable = await runner(commands.enable);
          let rollbackBootstrap = rollbackEnable;
          if (rollbackEnable.outcome === 'success') {
            await transaction.assertOwned();
            rollbackBootstrap = await runner(commands.bootstrap);
          }
          if (rollbackBootstrap.outcome !== 'success') throw commandError('rollback-bootstrap', rollbackBootstrap);
        }
      } catch (rollbackError) {
        if (isTransactionInterruption(rollbackError)) throw rollbackError;
        if (rollbackError instanceof ServiceLifecycleError && rollbackError.code === 'LAUNCHD_ROLLBACK_CONFLICT') {
          throw new ServiceLifecycleError(
            'LAUNCHD_ROLLBACK_CONFLICT',
            'launchd installation failed and a concurrent definition prevented rollback.',
            {
              ...(installError instanceof ServiceLifecycleError ? installError.context : {}),
              rollback: 'conflict',
            },
            { cause: rollbackError },
          );
        }
        throw new ServiceLifecycleError(
          'LAUNCHD_ROLLBACK_FAILED',
          'launchd installation failed and the previous definition could not be restored.',
          installError instanceof ServiceLifecycleError ? installError.context : {},
          { cause: rollbackError },
        );
      }
      throw installError;
    }
  };

  return {
    install: async () => {
      assertPlatform();
      await ensureManagedDirectories(paths.root, paths.installDirectories, ownerUid);
      return await withServiceOperationLock(paths, ownerUid, processInspector, lockPollAttempts, options.transactionHook, options.metadataReadHook, async (transaction) => {
        const legacy = await takeOverLegacyLabel(transaction);
        const result = await publishDerivedInstall(transaction);
        if (legacy !== null) await retireLegacyDefinition(legacy, transaction);
        return result;
      });
    },

    uninstall: async () => {
      assertPlatform();
      await ensureManagedDirectories(paths.root, paths.definitionDirectories, ownerUid);
      return await withServiceOperationLock(paths, ownerUid, processInspector, lockPollAttempts, options.transactionHook, options.metadataReadHook, async (transaction) => {
        // A service published under the previous label is this HOME's service under an older
        // name. Uninstall is exactly the request to remove it, so it is booted out and deleted
        // rather than left running under a name nothing addresses any more.
        const legacy = await readAdoptableLegacyDefinition(paths, migration, ownerUid);
        if (legacy !== null) await bootOutLegacyService(transaction);
        await sweepLegacyLabelArtifacts(paths, ownerUid, processInspector, transaction);
        const wasLoaded = await loaded();
        const existing = await readSafeManagedFile(paths, paths.definitionPath, ownerUid);
        if (wasLoaded) {
          await transaction.assertOwned();
          const bootout = await runner(commands.bootout);
          if (bootout.outcome !== 'success' && !isAbsentResult(bootout)) throw commandError('bootout', bootout);
          await waitUntilAbsent();
        }
        // Before the file is removed, because a manager that keeps its own registration cannot
        // undo one for a definition that is no longer there to name.
        if (wasLoaded || existing !== null) await disableService(transaction);
        if (existing !== null) {
          await removeSafeManagedFile(
            paths,
            paths.definitionPath,
            ownerUid,
            existing.identity,
            options.removalHook,
            transaction,
          );
        }
        if (legacy !== null) await removeLegacyDefinition(legacy, transaction);
        if (existing !== null || legacy !== null) await reloadDefinitions(transaction);
        await runTransactionHook(transaction, 'final-cleanup');
        return lifecycleResult(
          'uninstall',
          wasLoaded || existing !== null || legacy !== null ? 'uninstalled' : 'already-absent',
          paths,
        );
      });
    },

    status: async () => {
      assertPlatform();
      if (migration !== undefined) await finishLegacyLabelMigration();
      const service = await describe();
      const existing = await readSafeManagedFile(paths, paths.definitionPath, ownerUid);
      const state = service.loaded ? 'loaded' : existing === null ? 'absent' : 'installed-not-loaded';
      // `loaded` only says the manager knows the job. Reporting whether a process is actually
      // alive is what separates "the daemon is down" from "the request itself failed", and
      // without it every failed command looks like a dead daemon.
      return { ...lifecycleResult('status', state, paths), runState: service.runState };
    },
  };
}

function lifecycleResult<Action extends 'install' | 'uninstall' | 'status', State extends string>(
  action: Action,
  state: State,
  paths: ServicePaths,
): ServiceLifecycleResult<State> & { action: Action } {
  // The label and the definition path are read off the same resolved HOME the state was read for,
  // so the answer cannot name one service and report another's state.
  return { action, state, label: paths.label, definitionPath: paths.definitionPath };
}


/**
 * Every filename an interrupted old-label operation could have left behind. The list is exact
 * rather than a prefix over the whole label, so the derived label -- which begins with the legacy
 * one -- can never be swept by the code that retires it.
 */
function legacyLabelArtifactPrefixes(paths: ServicePaths): readonly string[] {
  if (paths.legacyLabel === null) return [];
  const definition = `${paths.legacyLabel}${paths.definitionSuffix}`;
  return [
    `${definition}.tmp-`,
    `${definition}.replaced-`,
    `${definition}.removed-`,
    `.${paths.legacyLabel}.transaction`,
    `.${paths.legacyLabel}.operation-lock`,
  ];
}

async function legacyLabelArtifactNames(paths: ServicePaths): Promise<string[]> {
  const prefixes = legacyLabelArtifactPrefixes(paths);
  if (prefixes.length === 0) return [];
  let names: string[];
  try { names = await readdir(paths.serviceDirectory); }
  catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw pathError('Could not read the launchd agents directory', error);
  }
  return names
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .sort();
}

/**
 * This HOME's own legacy definition, or null. `readSafeManagedFile` checks containment,
 * ownership, mode and link count but never authorship, so the plist has to say for itself which
 * HOME it belongs to: a definition naming another HOME is another HOME's, wherever it is sitting,
 * and is neither adopted nor touched.
 */
async function readAdoptableLegacyDefinition(
  paths: ServicePaths,
  migration: LegacyServiceMigration | undefined,
  uid: number,
): Promise<FileSnapshot | null> {
  if (migration === undefined || paths.legacyDefinitionPath === null) return null;
  let snapshot: FileSnapshot | null;
  try { snapshot = await readSafeManagedFile(paths, paths.legacyDefinitionPath, uid); }
  catch (error) {
    // A legacy plist this process cannot vouch for is left exactly where it is; the derived
    // label's own install is unaffected by it and reports any real problem on its own path.
    if (error instanceof ServiceLifecycleError) return null;
    throw error;
  }
  if (snapshot === null) return null;
  return migration.declaresHome(snapshot.content, paths) ? snapshot : null;
}



/**
 * Removes what the label change stranded. The operation lock and the transaction journal are
 * named after the label, and `validateJournal` rebuilds the `.tmp-`/`.replaced-`/`.removed-`
 * siblings from it too, so after the label is derived nothing else will ever read these again --
 * an old-label journal is not recoverable, only removable.
 *
 * Anything that is not a plain file this uid owns at an owner-only mode is left where it is: the
 * old directory-shaped lock this file has always refused to adopt is refused here too.
 */
async function sweepLegacyLabelArtifacts(
  paths: ServicePaths,
  uid: number,
  inspector: ServiceProcessInspector,
  transaction: ServiceTransaction,
): Promise<void> {
  const names = await legacyLabelArtifactNames(paths);
  if (names.length === 0) return;
  const parent = await assertSafeDirectory(paths.serviceDirectory, uid, paths.serviceDirectoryOwnerOnly);
  await assertLegacyLockAbandoned(paths, uid, inspector);
  for (const name of names) {
    const path = join(paths.serviceDirectory, name);
    assertContained(paths.serviceDirectory, path);
    await transaction.assertOwned();
    const identity = await readOwnedIdentity(path, uid, [1, 2]).catch(() => null);
    if (identity === null) continue;
    await removeExactFile(path, identity, uid, [1, 2]);
  }
  await assertDirectoryIdentity(paths.serviceDirectory, parent, uid, paths.serviceDirectoryOwnerOnly);
}

/**
 * An old binary still using the constant label cannot know about the derived one, so its lock is
 * the only signal that it is mid-operation. Refuse rather than race it: sweeping a live owner's
 * lock would remove the only mutual exclusion the two processes still share.
 */
async function assertLegacyLockAbandoned(
  paths: ServicePaths,
  uid: number,
  inspector: ServiceProcessInspector,
): Promise<void> {
  if (paths.legacyLabel === null) return;
  const lockPath = join(paths.serviceDirectory, `.${paths.legacyLabel}.operation-lock`);
  let snapshot: { content: string; identity: FileIdentity } | null;
  try { snapshot = await readOwnedFile(lockPath, uid, [1, 2]); }
  catch { return; }
  if (snapshot === null) return;
  let owner: LockOwnerMetadata;
  try { owner = parseOwnerMetadata(snapshot.content); }
  catch { return; }
  const observed = await inspector.inspect(owner.pid);
  if (observed.state === 'live' && observed.startIdentity === owner.startIdentity) {
    throw new ServiceLifecycleError(
      'LAUNCHD_OPERATION_BUSY',
      'A launchd lifecycle operation under the previous label is still in progress.',
      { operation: 'legacy-migration', owner: 'live' },
    );
  }
}

/**
 * The directories an operation requires, in the order the backend listed them.
 *
 * Each one is created below the directory that precedes it in the plan, which is why the plan is
 * an ordered list rather than a set: `~/Library` has to exist and be vouched for before
 * `~/Library/LaunchAgents` can be created inside it, and the same is true one level at a time all
 * the way down. The root is asserted first and separately, because it is the one directory in the
 * chain this code will never create -- a missing HOME is not a directory to make, it is a reason
 * to stop.
 */
async function ensureManagedDirectories(
  root: string,
  directories: readonly ManagedDirectory[],
  uid: number,
): Promise<void> {
  await assertSafeDirectory(root, uid);
  for (const directory of directories) {
    await ensureSafeChildDirectory(dirname(directory.path), directory.path, uid, directory.ownerOnly);
  }
}

async function withServiceOperationLock<T>(
  paths: ServicePaths,
  uid: number,
  inspector: ServiceProcessInspector,
  pollAttempts: number,
  hook: ServiceLifecycleOptions['transactionHook'],
  metadataReadHook: ServiceLifecycleOptions['metadataReadHook'],
  operation: (transaction: ServiceTransaction) => Promise<T>,
): Promise<T> {
  const lockPath = join(paths.serviceDirectory, `.${paths.label}.operation-lock`);
  const journalPath = join(paths.serviceDirectory, `.${paths.label}.transaction`);
  const parent = await assertSafeDirectory(paths.serviceDirectory, uid, paths.serviceDirectoryOwnerOnly);
  const currentOwner = await inspector.current();
  const baseOwner: LockOwnerMetadata = {
    version: 1,
    ...currentOwner,
    transactionId: crypto.randomUUID(),
    predecessorTransactionIds: [],
  };
  validateOwnerMetadata(baseOwner);
  let owner = baseOwner;
  const transaction: ServiceTransaction = {
    id: owner.transactionId,
    paths,
    uid,
    journalPath,
    hook,
    metadataReadHook,
    assertOwned: async () => { throw transactionPathError('lock ownership is not established'); },
  };
  let lockIdentity: FileIdentity | undefined;
  let lockClaimPath: string | undefined;
  let unknownMetadataOwner = false;
  let busyAttempts = 0;
  const structuralAttemptLimit = pollAttempts + maxOwnerPredecessors + 4;
  for (let structuralAttempt = 0;
    lockIdentity === undefined && busyAttempts < pollAttempts && structuralAttempt < structuralAttemptLimit;
    structuralAttempt += 1) {
    const candidate = `${lockPath}.owner-${baseOwner.transactionId}`;
    const baseContent = `${JSON.stringify(baseOwner)}\n`;
    const baseCandidateIdentity = await writeExclusiveManagedFile(candidate, baseContent, uid);
    try {
      await link(candidate, lockPath);
      await syncDirectory(paths.serviceDirectory);
      await runTransactionHook(transaction, 'lock-linked');
      await removeExactFile(candidate, baseCandidateIdentity, uid, [2]);
      const lock = await readOwnedFile(lockPath, uid, [1], maxTransactionMetadataBytes, metadataReadHook);
      if (lock === null || lock.content !== baseContent) throw transactionPathError('lock publication changed');
      owner = baseOwner;
      lockIdentity = lock.identity;
      await assertDirectoryIdentity(paths.serviceDirectory, parent, uid, paths.serviceDirectoryOwnerOnly);
      break;
    } catch (error) {
      if (isTransactionInterruption(error)) throw error;
      await removeExactFileIfPresent(candidate, baseCandidateIdentity, uid, [1, 2]);
      if (!isNodeError(error, 'EEXIST')) throw error;
      await assertDirectoryIdentity(paths.serviceDirectory, parent, uid, paths.serviceDirectoryOwnerOnly);
      let existingStat: Awaited<ReturnType<typeof lstat>>;
      try { existingStat = await lstat(lockPath); }
      catch (readError) { if (isNodeError(readError, 'ENOENT')) continue; throw readError; }
      let existingOwner: LockOwnerMetadata | null = null;
      let existingIdentity: FileIdentity | DirectoryIdentity;
      let existingContent: string | undefined;
      let ownerCompanionPath: string | undefined;
      let reclaim = false;
      if (existingStat.isDirectory() && !existingStat.isSymbolicLink()) {
        existingIdentity = await assertSafeDirectory(lockPath, uid, true);
        if ((existingIdentity.mode & 0o777) !== 0o700) throw transactionPathError('legacy lock mode changed');
        unknownMetadataOwner = true;
      } else {
        const existing = await readOwnedFile(
          lockPath,
          uid,
          [1, 2],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        if (existing === null) continue;
        if (existing === null || (existing.identity.mode & 0o777) !== 0o600) throw transactionPathError('lock metadata is unsafe');
        existingIdentity = existing.identity;
        existingContent = existing.content;
        existingOwner = parseOwnerMetadata(existing.content);
        if (existing.identity.nlink === 2) {
          const ownerCandidate = `${lockPath}.owner-${existingOwner.transactionId}`;
          let linkedCompanion = await readOwnedFile(
            ownerCandidate,
            uid,
            [2],
            maxTransactionMetadataBytes,
            metadataReadHook,
          );
          ownerCompanionPath = ownerCandidate;
          if (linkedCompanion === null && existingOwner.predecessorTransactionIds.length > 0) {
            ownerCompanionPath = `${lockPath}.successor-${existingOwner.predecessorTransactionIds[0]}`;
            linkedCompanion = await readOwnedFile(
              ownerCompanionPath,
              uid,
              [2],
              maxTransactionMetadataBytes,
              metadataReadHook,
            );
          }
          if (linkedCompanion === null || !sameInode(existing.identity, linkedCompanion.identity)
            || linkedCompanion.content !== existing.content) throw transactionPathError('lock hard-link prefix is unverifiable');
        }
        const observed = await inspector.inspect(existingOwner.pid);
        reclaim = observed.state === 'dead'
          || (observed.state === 'live' && observed.startIdentity !== existingOwner.startIdentity);
        if (reclaim && existing.identity.nlink === 2) {
          await removeExactFile(ownerCompanionPath as string, existing.identity, uid, [2]);
          continue;
        }
      }
      if (reclaim) {
        if (existingOwner === null) throw transactionPathError('metadata-less lock cannot be reclaimed');
        const inheritedPredecessors = await inheritedPredecessorTransactionIds(transaction, existingOwner);
        const successorOwner: LockOwnerMetadata = {
          ...baseOwner,
          predecessorTransactionIds: inheritedPredecessors,
        };
        validateOwnerMetadata(successorOwner);
        const successorContent = `${JSON.stringify(successorOwner)}\n`;
        const successorIdentity = await writeExclusiveManagedFile(candidate, successorContent, uid);
        const unchanged = await readOwnedFile(
          lockPath,
          uid,
          [1],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        if (unchanged === null || !sameInode(existingIdentity as FileIdentity, unchanged.identity)
          || unchanged.content !== existingContent) {
          await removeExactFileIfPresent(candidate, successorIdentity, uid, [1]);
          busyAttempts += 1;
          continue;
        }
        await runTransactionHook(transaction, 'before-stale-lock-claim');
        const claimPath = `${lockPath}.successor-${existingOwner.transactionId}`;
        const claimPredecessor = await readOwnedFile(
          lockPath,
          uid,
          [1],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        if (claimPredecessor === null || !sameInode(existingIdentity as FileIdentity, claimPredecessor.identity)
          || claimPredecessor.content !== existingContent) {
          throw transactionPathError('stale owner changed before successor claim');
        }
        const claimCandidate = await readOwnedFile(
          candidate,
          uid,
          [1],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        if (claimCandidate === null || !sameInode(successorIdentity, claimCandidate.identity)
          || claimCandidate.content !== successorContent) {
          throw transactionPathError('successor candidate changed before claim publication');
        }
        try {
          await link(candidate, claimPath);
        } catch (error) {
          await removeExactFile(candidate, successorIdentity, uid, [1]);
          if (!isNodeError(error, 'EEXIST')) throw error;
          const claimBusy = await resolveExistingSuccessorClaim(
            transaction,
            lockPath,
            claimPath,
            existingOwner,
            existingIdentity as FileIdentity,
            existingContent as string,
            inheritedPredecessors,
            inspector,
          );
          if (claimBusy) {
            busyAttempts += 1;
            await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
          }
          continue;
        }
        await syncDirectory(paths.serviceDirectory);
        await runTransactionHook(transaction, 'takeover-claim-linked');
        const exactClaim = await readOwnedFile(
          claimPath,
          uid,
          [2],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        if (exactClaim === null || !sameInode(successorIdentity, exactClaim.identity)
          || exactClaim.content !== successorContent) throw transactionPathError('successor claim changed');
        const exactPredecessor = await readOwnedFile(
          lockPath,
          uid,
          [1],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        if (exactPredecessor === null || !sameInode(existingIdentity as FileIdentity, exactPredecessor.identity)
          || exactPredecessor.content !== existingContent) {
          await removeExactFile(claimPath, successorIdentity, uid, [2]);
          await removeExactFile(candidate, successorIdentity, uid, [1]);
          throw transactionPathError('stale owner changed before replacement');
        }
        await runTransactionHook(transaction, 'takeover-claim-owned');
        const finalPredecessor = await readOwnedFile(
          lockPath,
          uid,
          [1],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        const finalClaim = await readOwnedFile(
          claimPath,
          uid,
          [2],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        const finalCandidate = await readOwnedFile(
          candidate,
          uid,
          [2],
          maxTransactionMetadataBytes,
          metadataReadHook,
        );
        if (finalCandidate === null || finalClaim === null || finalPredecessor === null
          || !sameInode(successorIdentity, finalCandidate.identity)
          || !sameInode(successorIdentity, finalClaim.identity)
          || finalCandidate.content !== successorContent || finalClaim.content !== successorContent
          || !sameInode(existingIdentity as FileIdentity, finalPredecessor.identity)
          || finalPredecessor.content !== existingContent) {
          throw transactionPathError('successor claim changed at replacement boundary');
        }
        await rename(candidate, lockPath);
        await syncDirectory(paths.serviceDirectory);
        owner = successorOwner;
        lockIdentity = successorIdentity;
        lockClaimPath = claimPath;
        await runTransactionHook(transaction, 'stale-lock-moved');
        await assertExactLockOwner(lockPath, lockIdentity, successorContent, uid, metadataReadHook, lockClaimPath);
        await assertDirectoryIdentity(paths.serviceDirectory, parent, uid, paths.serviceDirectoryOwnerOnly);
        break;
      }
      busyAttempts += 1;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  if (lockIdentity === undefined) {
    throw new ServiceLifecycleError(
      'LAUNCHD_OPERATION_BUSY',
      'Another launchd lifecycle operation is still in progress.',
      { operation: 'lock', ...(unknownMetadataOwner ? { owner: 'unknown-metadata' } : {}) },
    );
  }
  const ownerContent = `${JSON.stringify(owner)}\n`;
  transaction.assertOwned = async () => {
    await assertExactLockOwner(
      lockPath,
      lockIdentity as FileIdentity,
      ownerContent,
      uid,
      metadataReadHook,
      lockClaimPath,
    );
  };
  await transaction.assertOwned();
  await recoverInterruptedTransactions(transaction, owner.predecessorTransactionIds);
  await transaction.assertOwned();
  await runTransactionHook(transaction, 'lock-owned');
  await transaction.assertOwned();
  let interrupted = false;
  try {
    return await operation(transaction);
  } catch (error) {
    interrupted = isTransactionInterruption(error);
    throw error;
  } finally {
    if (!interrupted) {
      await transaction.assertOwned();
      await removeJournalIfOwned(transaction);
      await assertDirectoryIdentity(paths.serviceDirectory, parent, uid, paths.serviceDirectoryOwnerOnly);
      await transaction.assertOwned();
      if (lockClaimPath !== undefined) {
        await removeExactFile(lockClaimPath, lockIdentity as FileIdentity, uid, [2]);
        lockClaimPath = undefined;
        await transaction.assertOwned();
      }
      await removeExactFile(lockPath, lockIdentity as FileIdentity, uid, [1]);
      await assertDirectoryIdentity(paths.serviceDirectory, parent, uid, paths.serviceDirectoryOwnerOnly);
    }
  }
}

async function inheritedPredecessorTransactionIds(
  transaction: ServiceTransaction,
  owner: LockOwnerMetadata,
): Promise<string[]> {
  const available = [owner.transactionId, ...owner.predecessorTransactionIds];
  const fixed = await readAuthorizedFixedJournal(transaction, available);
  const recoveryOwners = new Set<string>([owner.transactionId]);
  if (fixed !== null) recoveryOwners.add(fixed.journal.transactionId);
  for (const transactionId of available) {
    if (await readPredecessorJournalTemporary(transaction, transactionId) !== null) {
      recoveryOwners.add(transactionId);
    }
  }
  if (available.length <= maxOwnerPredecessors) return available;
  if (recoveryOwners.size > maxOwnerPredecessors) {
    throw transactionPathError('predecessor recovery lineage exceeds its bound');
  }
  const selected = new Set(available.slice(0, maxOwnerPredecessors));
  for (const recoveryOwner of recoveryOwners) {
    if (selected.has(recoveryOwner)) continue;
    const replaceable = [...available].reverse().find((transactionId) =>
      selected.has(transactionId) && !recoveryOwners.has(transactionId));
    if (replaceable === undefined) throw transactionPathError('predecessor recovery lineage cannot be bounded');
    selected.delete(replaceable);
    selected.add(recoveryOwner);
  }
  return available.filter((transactionId) => selected.has(transactionId));
}

async function resolveExistingSuccessorClaim(
  transaction: ServiceTransaction,
  lockPath: string,
  claimPath: string,
  predecessorOwner: LockOwnerMetadata,
  predecessorIdentity: FileIdentity,
  predecessorContent: string,
  inheritedPredecessors: readonly string[],
  inspector: ServiceProcessInspector,
): Promise<boolean> {
  const claim = await readOwnedFile(
    claimPath,
    transaction.uid,
    [2],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (claim === null) return false;
  const claimOwner = parseOwnerMetadata(claim.content);
  if (claimOwner.predecessorTransactionIds.length !== inheritedPredecessors.length
    || claimOwner.predecessorTransactionIds.some((value, index) => value !== inheritedPredecessors[index])) {
    throw transactionPathError('successor claim lineage is invalid');
  }
  const claimCandidatePath = `${lockPath}.owner-${claimOwner.transactionId}`;
  const claimCandidate = await readOwnedFile(
    claimCandidatePath,
    transaction.uid,
    [2],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  const publishedOwner = await readOwnedFile(
    lockPath,
    transaction.uid,
    [1, 2],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  const candidateCompanion = claimCandidate !== null && sameInode(claim.identity, claimCandidate.identity)
    && claimCandidate.content === claim.content;
  const publishedCompanion = publishedOwner !== null && sameInode(claim.identity, publishedOwner.identity)
    && publishedOwner.content === claim.content;
  if (candidateCompanion === publishedCompanion) {
    throw transactionPathError('successor claim hard-link prefix is unverifiable');
  }
  const observed = await inspector.inspect(claimOwner.pid);
  const reclaim = observed.state === 'dead'
    || (observed.state === 'live' && observed.startIdentity !== claimOwner.startIdentity);
  if (!reclaim) return true;
  if (candidateCompanion) {
    const predecessor = await readOwnedFile(
      lockPath,
      transaction.uid,
      [1],
      maxTransactionMetadataBytes,
      transaction.metadataReadHook,
    );
    if (predecessor === null || !sameInode(predecessorIdentity, predecessor.identity)
      || predecessor.content !== predecessorContent
      || parseOwnerMetadata(predecessor.content).transactionId !== predecessorOwner.transactionId) {
      throw transactionPathError('stale owner changed before successor claim recovery');
    }
    await runTransactionHook(transaction, 'before-claim-recovery-move');
    const finalPredecessor = await readOwnedFile(
      lockPath,
      transaction.uid,
      [1],
      maxTransactionMetadataBytes,
      transaction.metadataReadHook,
    );
    const finalClaim = await readOwnedFile(
      claimPath,
      transaction.uid,
      [2],
      maxTransactionMetadataBytes,
      transaction.metadataReadHook,
    );
    const finalCandidate = await readOwnedFile(
      claimCandidatePath,
      transaction.uid,
      [2],
      maxTransactionMetadataBytes,
      transaction.metadataReadHook,
    );
    if (finalCandidate === null || finalClaim === null || finalPredecessor === null
      || !sameInode(claim.identity, finalCandidate.identity)
      || !sameInode(claim.identity, finalClaim.identity)
      || finalCandidate.content !== claim.content || finalClaim.content !== claim.content
      || !sameInode(predecessorIdentity, finalPredecessor.identity)
      || finalPredecessor.content !== predecessorContent) {
      throw transactionPathError('successor claim changed at recovery boundary');
    }
    await rename(claimCandidatePath, lockPath);
    await syncDirectory(transaction.paths.serviceDirectory);
  }
  return false;
}

async function ensureSafeChildDirectory(parent: string, path: string, uid: number, ownerOnly: boolean): Promise<void> {
  assertContained(parent, path);
  const parentIdentity = await assertSafeDirectory(parent, uid);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (!isNodeError(error, 'EEXIST')) throw pathError('Could not create a safe launchd directory', error); }
  await assertDirectoryIdentity(parent, parentIdentity, uid);
  const identity = await assertSafeDirectory(path, uid);
  if (ownerOnly && (identity.mode & 0o077) !== 0) {
    throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'Managed launchd directories must be owner-only');
  }
}

interface FileSnapshot { content: string; identity: FileIdentity }
interface FileIdentity { dev: number; ino: number; uid: number; mode: number; nlink: number }
interface DirectoryIdentity { dev: number; ino: number; uid: number; mode: number }
interface LockOwnerMetadata {
  version: 1;
  pid: number;
  startIdentity: string;
  transactionId: string;
  predecessorTransactionIds: string[];
}
interface ServiceTransaction {
  id: string;
  paths: ServicePaths;
  uid: number;
  journalPath: string;
  hook: ServiceLifecycleOptions['transactionHook'];
  metadataReadHook: ServiceLifecycleOptions['metadataReadHook'];
  assertOwned(): Promise<void>;
  failureContext?: Readonly<Record<string, string | number | boolean | null>>;
}
interface ExpectedContentIdentity { byteLength: number; sha256: string }
interface TransactionJournal {
  version: 1;
  transactionId: string;
  operation: 'publish' | 'remove';
  phase: 'preparing' | 'prepared' | 'old-quarantined' | 'new-linked' | 'temporary-unlinked'
    | 'removal-quarantined' | 'removal-cleaned';
  temporary: string | null;
  quarantine: string | null;
  original: FileIdentity | null;
  replacement: FileIdentity | null;
  expected: ExpectedContentIdentity | null;
  failure?: Readonly<Record<string, string | number | boolean | null>> | null;
}
interface JournalFileSnapshot extends FileSnapshot { journal: TransactionJournal }

async function readSafeManagedFile(scope: ServiceScope, path: string, uid: number): Promise<FileSnapshot | null> {
  assertContained(scope.root, path);
  const directory = resolve(path, '..');
  const chain = await assertSafeExistingDirectoryChain(scope, directory, uid);
  if (chain === null) return null;
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw pathError('Unsafe launchd plist target', error); }
  try {
    const stat = await handle.stat();
    const identity = assertSafeFileStat(stat, uid);
    if (stat.size > maxManagedDefinitionBytes) throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist is unexpectedly large');
    const content = await readBoundedHandle(handle, maxManagedDefinitionBytes, () => {
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist is unexpectedly large');
    });
    await assertDirectoryIdentity(directory, chain, uid);
    return { content, identity };
  } finally {
    await handle.close();
  }
}

async function publishSafeManagedFile(
  scope: ServiceScope,
  path: string,
  content: string,
  uid: number,
  hook?: ServiceLifecycleOptions['publicationHook'],
  transaction?: ServiceTransaction,
): Promise<FileIdentity> {
  assertContained(scope.root, path);
  const directory = resolve(path, '..');
  const parent = await assertSafeDirectory(directory, uid, scope.serviceDirectoryOwnerOnly);
  const existing = await readSafeManagedFile(scope, path, uid);
  const suffix = transaction?.id ?? crypto.randomUUID();
  const temporary = `${path}.tmp-${suffix}`;
  const quarantine = `${path}.replaced-${suffix}`;
  const expected = expectedContentIdentity(content);
  let handle: FileHandle | null = null;
  let ownedTemporary: FileIdentity | undefined;
  let quarantined: FileIdentity | undefined;
  // Held for as long as `existing.identity` is going to be believed, and acquired immediately
  // before the `try` that releases it. Without it, a racer that deletes the old definition and
  // writes its own at the same path hands every boundary below an object the tuple calls
  // identical, and the publication quarantines and replaces the winner instead of refusing.
  const existingPin = existing === null ? null : await pinInode(path);
  if (existing !== null && (existingPin === null || !await existingPin.holds(existing.identity))) {
    await existingPin?.close();
    throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist was replaced before publication');
  }
  try {
    if (transaction !== undefined) {
      await transaction.assertOwned();
      await writeTransactionJournal(transaction, {
        version: 1, transactionId: transaction.id, operation: 'publish', phase: 'preparing',
        temporary: temporary.split(sep).at(-1) as string,
        quarantine: quarantine.split(sep).at(-1) as string,
        original: existing?.identity ?? null, replacement: null, expected,
      });
      await runTransactionHook(transaction, 'publish-prepared');
      await transaction.assertOwned();
    }
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    ownedTemporary = assertOwnedFileStat(await handle.stat(), uid, [1]);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    const written = assertSafeFileStat(await handle.stat(), uid);
    if (!sameInode(ownedTemporary, written)) throw transactionPathError('launchd temporary identity changed');
    if ((written.mode & 0o777) !== 0o600) throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'Unsafe launchd temporary mode');
    await handle.close();
    handle = null;
    const temporaryStat = assertSafeFileStat(await lstat(temporary), uid);
    assertSameFileIdentity(written, temporaryStat);
    if (transaction !== undefined) {
      await runTransactionHook(transaction, 'temporary-written');
      await transaction.assertOwned();
      await writeTransactionJournal(transaction, {
        version: 1, transactionId: transaction.id, operation: 'publish', phase: 'prepared',
        temporary: temporary.split(sep).at(-1) as string,
        quarantine: quarantine.split(sep).at(-1) as string,
        original: existing?.identity ?? null, replacement: temporaryStat, expected,
      });
      await runTransactionHook(transaction, 'temporary-created');
    }
    await hook?.('before-publish', path);
    await assertDirectoryIdentity(directory, parent, uid, scope.serviceDirectoryOwnerOnly);
    let current = await readSafeManagedFile(scope, path, uid);
    if (!sameOptionalIdentity(existing?.identity, current?.identity)) {
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed during publication');
    }
    if (existing !== null) {
      await hook?.('before-replace-move', path);
      await assertDirectoryIdentity(directory, parent, uid, scope.serviceDirectoryOwnerOnly);
      current = await readSafeManagedFile(scope, path, uid);
      if (current === null || !await pinStillHolds(existingPin, current.identity)) {
        throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist was replaced before replacement');
      }
      await transaction?.assertOwned();
      const exactReplacementSource = await readSafeManagedFile(scope, path, uid);
      if (exactReplacementSource === null || !await pinStillHolds(existingPin, exactReplacementSource.identity)) {
        throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist was replaced at replacement move');
      }
      await rename(path, quarantine);
      await assertDirectoryIdentity(directory, parent, uid, scope.serviceDirectoryOwnerOnly);
      const moved = await readSafeManagedFile(scope, quarantine, uid);
      if (moved === null || !sameFileIdentity(existing.identity, moved.identity)) {
        if (moved !== null) await restoreQuarantinedFile(scope, path, quarantine, uid, parent, moved.identity);
        throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed during replacement');
      }
      quarantined = moved.identity;
      if (transaction !== undefined) {
        await writeTransactionJournal(transaction, {
          version: 1, transactionId: transaction.id, operation: 'publish', phase: 'old-quarantined',
          temporary: temporary.split(sep).at(-1) as string,
          quarantine: quarantine.split(sep).at(-1) as string,
          original: moved.identity, replacement: temporaryStat, expected,
        });
        await runTransactionHook(transaction, 'old-quarantined');
      }
    }

    await hook?.('before-link', path);
    await assertDirectoryIdentity(directory, parent, uid, scope.serviceDirectoryOwnerOnly);
    current = await readSafeManagedFile(scope, path, uid);
    if (current !== null) {
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist target appeared before publication');
    }
    await transaction?.assertOwned();
    const exactTemporary = await readOwnedFile(
      temporary,
      uid,
      [1],
      maxManagedDefinitionBytes,
      transaction?.metadataReadHook,
    );
    if (exactTemporary === null || !sameFileIdentity(temporaryStat, exactTemporary.identity)
      || !sameExpectedContent(expected, exactTemporary.content)) {
      ownedTemporary = undefined;
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd temporary changed before publication');
    }
    try { await link(temporary, path); }
    catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist target won concurrent publication');
      }
      throw error;
    }
    await assertDirectoryIdentity(directory, parent, uid, scope.serviceDirectoryOwnerOnly);
    const linkedTemporary = await readOwnedFile(
      temporary,
      uid,
      [2],
      maxManagedDefinitionBytes,
      transaction?.metadataReadHook,
    );
    const linkedTarget = await readOwnedFile(
      path,
      uid,
      [2],
      maxManagedDefinitionBytes,
      transaction?.metadataReadHook,
    );
    if (linkedTemporary === null || linkedTarget === null
      || !sameInode(temporaryStat, linkedTemporary.identity)
      || !sameInode(temporaryStat, linkedTarget.identity)
      || !sameExpectedContent(expected, linkedTemporary.content)
      || linkedTarget.content !== linkedTemporary.content) {
      if (linkedTemporary !== null && linkedTarget !== null
        && sameInode(linkedTemporary.identity, linkedTarget.identity)) {
        await removeExactFile(path, linkedTarget.identity, uid, [2]);
      }
      ownedTemporary = undefined;
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd linked temporary changed identity');
    }
    if (transaction !== undefined) {
      const linked = linkedTarget.identity;
      await writeTransactionJournal(transaction, {
        version: 1, transactionId: transaction.id, operation: 'publish', phase: 'new-linked',
        temporary: temporary.split(sep).at(-1) as string,
        quarantine: quarantine.split(sep).at(-1) as string,
        original: existing?.identity ?? null, replacement: linked, expected,
      });
      await runTransactionHook(transaction, 'new-linked');
    }
    await transaction?.assertOwned();
    await removeExactFile(temporary, temporaryStat, uid, [2]);
    ownedTemporary = undefined;
    const published = await readSafeManagedFile(scope, path, uid);
    if (published === null) throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist publication disappeared');
    assertSameFileIdentity(temporaryStat, published.identity);
    if (transaction !== undefined) {
      await writeTransactionJournal(transaction, {
        version: 1, transactionId: transaction.id, operation: 'publish', phase: 'temporary-unlinked',
        temporary: temporary.split(sep).at(-1) as string,
        quarantine: quarantine.split(sep).at(-1) as string,
        original: existing?.identity ?? null, replacement: published.identity, expected,
      });
      await runTransactionHook(transaction, 'temporary-unlinked');
    }
    if (quarantined !== undefined) {
      await transaction?.assertOwned();
      await removeOwnedSibling(scope, quarantine, uid, parent, quarantined);
      quarantined = undefined;
    }
    return published.identity;
  } catch (error) {
    if (isTransactionInterruption(error)) throw error;
    await handle?.close().catch(() => {});
    let parentUnchanged = false;
    try { await assertDirectoryIdentity(directory, parent, uid, scope.serviceDirectoryOwnerOnly); parentUnchanged = true; }
    catch { /* Never unlink through a replaced parent path. */ }
    if (parentUnchanged) {
      if (quarantined !== undefined) {
        const restored = await restoreQuarantinedFile(
          scope,
          path,
          quarantine,
          uid,
          parent,
          quarantined,
        ).catch(() => false);
        if (!restored) {
          await removeOwnedSibling(scope, quarantine, uid, parent, quarantined).catch(() => {});
        }
        quarantined = undefined;
      }
      if (ownedTemporary !== undefined) {
        try { await removeExactFile(temporary, ownedTemporary, uid, [1, 2]); }
        catch (cleanupError) {
          if (!isNodeError(cleanupError, 'ENOENT')) {
            throw new ServiceLifecycleError(
              'UNSAFE_LAUNCHD_PATH',
              'Could not clean up the launchd temporary file.',
              {},
              { cause: cleanupError },
            );
          }
        }
      }
    }
    if (error instanceof ServiceLifecycleError) throw error;
    throw pathError('Could not publish launchd plist safely', error);
  } finally {
    await existingPin?.close();
  }
}

async function removeSafeManagedFile(
  scope: ServiceScope,
  path: string,
  uid: number,
  expected?: FileIdentity,
  hook?: ServiceLifecycleOptions['removalHook'],
  transaction?: ServiceTransaction,
): Promise<void> {
  const snapshot = await readSafeManagedFile(scope, path, uid);
  if (snapshot === null) return;
  if (expected !== undefined) assertSameFileIdentity(expected, snapshot.identity);
  // Held from the inspection to the quarantine move, which is the whole of the window a substituted
  // plist has to arrive in. Every boundary below asks the pin, not a second `lstat`: the tuple
  // comparison for this operation lives in one place so that breaking it is visible here, on the
  // platform where the tuple alone would still have looked right.
  const pin = await pinInode(path);
  if (pin === null || !await pin.holds(snapshot.identity)) {
    await pin?.close();
    throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed before removal');
  }
  try {
    const directory = resolve(path, '..');
    const parent = await assertSafeDirectory(directory, uid, scope.serviceDirectoryOwnerOnly);
    await hook?.('before-remove', path);
    let before = await readSafeManagedFile(scope, path, uid);
    if (before === null || !await pinStillHolds(pin, before.identity)) {
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist was replaced before removal');
    }
    await hook?.('before-quarantine', path);
    await assertDirectoryIdentity(directory, parent, uid, scope.serviceDirectoryOwnerOnly);
    before = await readSafeManagedFile(scope, path, uid);
    if (before === null || !await pinStillHolds(pin, before.identity)) {
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist was replaced at removal boundary');
    }
    const suffix = transaction?.id ?? crypto.randomUUID();
    const quarantine = `${path}.removed-${suffix}`;
    if (transaction !== undefined) {
      await transaction.assertOwned();
      await writeTransactionJournal(transaction, {
        version: 1, transactionId: transaction.id, operation: 'remove', phase: 'prepared',
        temporary: null, quarantine: quarantine.split(sep).at(-1) as string,
        original: snapshot.identity, replacement: null, expected: null,
      });
      await runTransactionHook(transaction, 'removal-prepared');
    }
    await transaction?.assertOwned();
    const exactRemovalSource = await readSafeManagedFile(scope, path, uid);
    if (exactRemovalSource === null || !await pinStillHolds(pin, exactRemovalSource.identity)) {
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist was replaced at removal move');
    }
    await rename(path, quarantine);
    await assertDirectoryIdentity(directory, parent, uid, scope.serviceDirectoryOwnerOnly);
    const moved = await readSafeManagedFile(scope, quarantine, uid);
    if (moved === null || !await pinStillHolds(pin, moved.identity)) {
      if (moved !== null) await restoreQuarantinedFile(scope, path, quarantine, uid, parent, moved.identity);
      throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed during removal');
    }
    if (transaction !== undefined) {
      await writeTransactionJournal(transaction, {
        version: 1, transactionId: transaction.id, operation: 'remove', phase: 'removal-quarantined',
        temporary: null, quarantine: quarantine.split(sep).at(-1) as string,
        original: moved.identity, replacement: null, expected: null,
      });
      await runTransactionHook(transaction, 'removal-quarantined');
    }
    await transaction?.assertOwned();
    await removeOwnedSibling(scope, quarantine, uid, parent, moved.identity);
    if (transaction !== undefined) {
      await writeTransactionJournal(transaction, {
        version: 1, transactionId: transaction.id, operation: 'remove', phase: 'removal-cleaned',
        temporary: null, quarantine: quarantine.split(sep).at(-1) as string,
        original: moved.identity, replacement: null, expected: null,
      });
      await runTransactionHook(transaction, 'removal-cleaned');
    }
  } finally {
    await pin.close();
  }
}

/**
 * The one question every boundary in a pinned operation asks.
 *
 * `sameInode` compares two descriptions and is right whenever nothing has been deleted; this
 * compares a description against a *reference*, which is the only form of the question that
 * survives a filesystem willing to reissue an inode number. Named and shared rather than inlined
 * so the boundaries read alike, and so there is exactly one place to break when checking that they
 * are still load-bearing.
 */
async function pinStillHolds(pin: InodePin | null, current: FileIdentity): Promise<boolean> {
  return pin !== null && current.nlink === 1 && await pin.holds(current);
}

async function restorePreviousDefinition(
  paths: ServicePaths,
  uid: number,
  previous: FileSnapshot | null,
  published: FileIdentity | undefined,
  transaction?: ServiceTransaction,
): Promise<void> {
  const current = await readSafeManagedFile(paths, paths.definitionPath, uid);
  if (published === undefined) {
    if (!sameOptionalIdentity(previous?.identity, current?.identity)) throw rollbackConflict();
    return;
  }
  if (current === null || !sameFileIdentity(published, current.identity)) throw rollbackConflict();
  if (previous === null) await removeSafeManagedFile(paths, paths.definitionPath, uid, published, undefined, transaction);
  else await publishSafeManagedFile(paths, paths.definitionPath, previous.content, uid, undefined, transaction);
}

async function restoreQuarantinedFile(
  scope: ServiceScope,
  path: string,
  quarantine: string,
  uid: number,
  parent: DirectoryIdentity,
  expected: FileIdentity,
): Promise<boolean> {
  await assertDirectoryIdentity(resolve(path, '..'), parent, uid, scope.serviceDirectoryOwnerOnly);
  const moved = await readSafeManagedFile(scope, quarantine, uid);
  if (moved === null || !sameFileIdentity(expected, moved.identity)) return false;
  try { await link(quarantine, path); }
  catch (error) { if (isNodeError(error, 'EEXIST')) return false; throw error; }
  await rm(quarantine);
  await assertDirectoryIdentity(resolve(path, '..'), parent, uid, scope.serviceDirectoryOwnerOnly);
  const restored = await readSafeManagedFile(scope, path, uid);
  return restored !== null && sameFileIdentity(expected, restored.identity);
}

async function removeOwnedSibling(
  scope: ServiceScope,
  path: string,
  uid: number,
  parent: DirectoryIdentity,
  expected: FileIdentity,
): Promise<void> {
  await assertDirectoryIdentity(resolve(path, '..'), parent, uid, scope.serviceDirectoryOwnerOnly);
  const current = await readSafeManagedFile(scope, path, uid);
  if (current === null || !sameFileIdentity(expected, current.identity)) {
    throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd owned temporary identity changed');
  }
  await rm(path);
  await assertDirectoryIdentity(resolve(path, '..'), parent, uid, scope.serviceDirectoryOwnerOnly);
}

function rollbackConflict(): ServiceLifecycleError {
  return new ServiceLifecycleError(
    'LAUNCHD_ROLLBACK_CONFLICT',
    'The published launchd definition changed before rollback.',
    { rollback: 'conflict' },
  );
}

async function writeExclusiveManagedFile(path: string, content: string, uid: number): Promise<FileIdentity> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    const identity = assertSafeFileStat(await handle.stat(), uid);
    if ((identity.mode & 0o777) !== 0o600) throw transactionPathError('transaction file mode changed');
    return identity;
  } finally {
    await handle?.close();
  }
}

async function writeTransactionJournal(transaction: ServiceTransaction, journal: TransactionJournal): Promise<void> {
  journal = { ...journal, failure: transaction.failureContext ?? journal.failure ?? null };
  validateJournal(transaction, journal);
  await writeJournalSnapshot(transaction, journal);
}

async function writeRecoveredTransactionJournal(
  transaction: ServiceTransaction,
  journal: TransactionJournal,
): Promise<void> {
  journal = { ...journal, failure: transaction.failureContext ?? journal.failure ?? null };
  validateJournal({ ...transaction, id: journal.transactionId }, journal);
  await writeJournalSnapshot(transaction, journal);
}

async function writeJournalSnapshot(transaction: ServiceTransaction, journal: TransactionJournal): Promise<void> {
  const temporary = `${transaction.journalPath}.tmp-${journal.transactionId}`;
  const content = `${JSON.stringify(journal)}\n`;
  await transaction.assertOwned();
  const previous = await readOwnedFile(
    transaction.journalPath,
    transaction.uid,
    [1],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (previous !== null) {
    let previousJournal: TransactionJournal;
    try { previousJournal = JSON.parse(previous.content) as TransactionJournal; }
    catch (error) { throw transactionPathError('existing transaction journal is invalid', error); }
    validateJournal({ ...transaction, id: previousJournal.transactionId }, previousJournal);
    if (previousJournal.transactionId !== journal.transactionId) {
      throw transactionPathError('existing transaction journal changed owners');
    }
  }
  const temporaryIdentity = await writeExclusiveManagedFile(temporary, content, transaction.uid);
  await transaction.assertOwned();
  const current = await readOwnedFile(
    transaction.journalPath,
    transaction.uid,
    [1],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (!sameOptionalIdentity(previous?.identity, current?.identity) || previous?.content !== current?.content) {
    throw transactionPathError('transaction journal target changed before publication');
  }
  const exactTemporary = await readOwnedFile(
    temporary,
    transaction.uid,
    [1],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (exactTemporary === null || !sameFileIdentity(temporaryIdentity, exactTemporary.identity)
    || exactTemporary.content !== content) {
    throw transactionPathError('transaction journal temporary changed before publication');
  }
  await rename(temporary, transaction.journalPath);
  await syncDirectory(transaction.paths.serviceDirectory);
  const published = await readOwnedFile(
    transaction.journalPath,
    transaction.uid,
    [1],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (published === null || !sameFileIdentity(temporaryIdentity, published.identity)
    || published.content !== content) throw transactionPathError('transaction journal publication changed');
}

async function recoverInterruptedTransactions(
  transaction: ServiceTransaction,
  predecessorTransactionIds: readonly string[],
): Promise<void> {
  if (predecessorTransactionIds.length > maxOwnerPredecessors
    || new Set(predecessorTransactionIds).size !== predecessorTransactionIds.length
    || predecessorTransactionIds.some((transactionId) => !validTransactionId(transactionId))) {
    throw transactionPathError('predecessor recovery lineage is invalid');
  }
  const fixed = await readAuthorizedFixedJournal(transaction, predecessorTransactionIds);
  if (fixed !== null) {
    await reconcilePredecessorJournalTemporary(
      transaction,
      predecessorTransactionIds,
      fixed.journal.transactionId,
    );
    await recoverInterruptedTransaction(transaction, predecessorTransactionIds);
  }
  for (const transactionId of predecessorTransactionIds) {
    if (await readPredecessorJournalTemporary(transaction, transactionId) === null) continue;
    const blockingFixed = await readAuthorizedFixedJournal(transaction, predecessorTransactionIds);
    if (blockingFixed !== null && blockingFixed.journal.transactionId !== transactionId) {
      await recoverInterruptedTransaction(transaction, predecessorTransactionIds);
    }
    await reconcilePredecessorJournalTemporary(transaction, predecessorTransactionIds, transactionId);
    await recoverInterruptedTransaction(transaction, predecessorTransactionIds);
  }
}

async function reconcilePredecessorJournalTemporary(
  transaction: ServiceTransaction,
  predecessorTransactionIds: readonly string[],
  transactionId: string,
): Promise<void> {
  if (!predecessorTransactionIds.includes(transactionId)) {
    throw transactionPathError('journal temporary owner is outside the predecessor lineage');
  }
  const temporaryPath = journalTemporaryPath(transaction, transactionId);
  const temporary = await readPredecessorJournalTemporary(transaction, transactionId);
  if (temporary === null) return;
  const fixed = await readAuthorizedFixedJournal(transaction, predecessorTransactionIds);
  if (fixed !== null && fixed.journal.transactionId !== transactionId) {
    throw transactionPathError('another authorized transaction journal must be recovered first');
  }
  if (fixed !== null && fixed.content === temporary.content) {
    await transaction.assertOwned();
    const exactFixed = await readAuthorizedFixedJournal(transaction, predecessorTransactionIds);
    const exactTemporary = await readPredecessorJournalTemporary(transaction, transactionId);
    if (exactFixed === null || exactTemporary === null
      || exactFixed.journal.transactionId !== transactionId
      || exactFixed.content !== fixed.content || exactTemporary.content !== temporary.content
      || !sameInode(exactFixed.identity, fixed.identity)
      || !sameInode(exactTemporary.identity, temporary.identity)) {
      throw transactionPathError('duplicate journal temporary changed before removal');
    }
    const links = sameInode(exactFixed.identity, exactTemporary.identity) ? [2] : [1];
    await removeExactFile(temporaryPath, exactTemporary.identity, transaction.uid, links);
    await runTransactionHook(transaction, 'journal-temporary-removed');
    const stable = await readOwnedFile(
      transaction.journalPath,
      transaction.uid,
      [1],
      maxTransactionMetadataBytes,
      transaction.metadataReadHook,
    );
    if (stable === null || stable.content !== fixed.content || !sameInode(fixed.identity, stable.identity)) {
      throw transactionPathError('fixed journal did not stabilize after duplicate removal');
    }
    return;
  }
  if (fixed !== null) {
    await transaction.assertOwned();
    const exactFixed = await readAuthorizedFixedJournal(transaction, predecessorTransactionIds);
    const exactTemporary = await readPredecessorJournalTemporary(transaction, transactionId);
    if (exactFixed === null || exactTemporary === null
      || exactFixed.journal.transactionId !== transactionId
      || exactFixed.content !== fixed.content || exactTemporary.content !== temporary.content
      || !sameInode(exactFixed.identity, fixed.identity)
      || !sameInode(exactTemporary.identity, temporary.identity)
      || exactFixed.identity.nlink !== 1 || exactTemporary.identity.nlink !== 1) {
      throw transactionPathError('journal temporary changed before promotion');
    }
    await rename(temporaryPath, transaction.journalPath);
    await syncDirectory(transaction.paths.serviceDirectory);
    await runTransactionHook(transaction, 'journal-temporary-adopted');
    const promoted = await readOwnedFile(
      transaction.journalPath,
      transaction.uid,
      [1],
      maxTransactionMetadataBytes,
      transaction.metadataReadHook,
    );
    if (promoted === null || promoted.content !== temporary.content
      || !sameInode(temporary.identity, promoted.identity)) {
      throw transactionPathError('promoted journal temporary changed');
    }
    return;
  }
  await transaction.assertOwned();
  const exactFixed = await readAuthorizedFixedJournal(transaction, predecessorTransactionIds);
  const exactTemporary = await readPredecessorJournalTemporary(transaction, transactionId);
  if (exactFixed !== null || exactTemporary === null
    || exactTemporary.content !== temporary.content
    || !sameInode(exactTemporary.identity, temporary.identity)
    || exactTemporary.identity.nlink !== 1) {
    throw transactionPathError('journal temporary changed before adoption');
  }
  try { await link(temporaryPath, transaction.journalPath); }
  catch (error) {
    if (isNodeError(error, 'EEXIST')) throw transactionPathError('fixed journal appeared during adoption', error);
    throw error;
  }
  await syncDirectory(transaction.paths.serviceDirectory);
  const linkedFixed = await readAuthorizedFixedJournal(transaction, predecessorTransactionIds);
  const linkedTemporary = await readPredecessorJournalTemporary(transaction, transactionId);
  if (linkedFixed === null || linkedTemporary === null
    || linkedFixed.content !== temporary.content || linkedTemporary.content !== temporary.content
    || !sameInode(temporary.identity, linkedFixed.identity)
    || !sameInode(temporary.identity, linkedTemporary.identity)
    || linkedFixed.identity.nlink !== 2 || linkedTemporary.identity.nlink !== 2) {
    throw transactionPathError('journal temporary adoption changed');
  }
  await runTransactionHook(transaction, 'journal-temporary-adopted');
  await transaction.assertOwned();
  const finalFixed = await readAuthorizedFixedJournal(transaction, predecessorTransactionIds);
  const finalTemporary = await readPredecessorJournalTemporary(transaction, transactionId);
  if (finalFixed === null || finalTemporary === null
    || finalFixed.content !== temporary.content || finalTemporary.content !== temporary.content
    || !sameInode(temporary.identity, finalFixed.identity)
    || !sameInode(temporary.identity, finalTemporary.identity)) {
    throw transactionPathError('adopted journal temporary changed before stabilization');
  }
  await removeExactFile(temporaryPath, finalTemporary.identity, transaction.uid, [2]);
  const stable = await readOwnedFile(
    transaction.journalPath,
    transaction.uid,
    [1],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (stable === null || stable.content !== temporary.content || !sameInode(temporary.identity, stable.identity)) {
    throw transactionPathError('adopted journal temporary did not stabilize');
  }
}

async function readAuthorizedFixedJournal(
  transaction: ServiceTransaction,
  authorizedTransactionIds: readonly string[],
): Promise<JournalFileSnapshot | null> {
  const snapshot = await readOwnedFile(
    transaction.journalPath,
    transaction.uid,
    [1, 2],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (snapshot === null) return null;
  const journal = parseValidatedJournal(transaction, snapshot.content);
  if (!authorizedTransactionIds.includes(journal.transactionId)) {
    throw transactionPathError('transaction journal owner mismatch');
  }
  if (snapshot.identity.nlink === 2) {
    const companion = await readPredecessorJournalTemporary(transaction, journal.transactionId, false);
    if (companion === null || companion.content !== snapshot.content
      || !sameInode(snapshot.identity, companion.identity) || companion.identity.nlink !== 2) {
      throw transactionPathError('fixed journal hard-link prefix is unverifiable');
    }
  }
  return { ...snapshot, journal };
}

async function readPredecessorJournalTemporary(
  transaction: ServiceTransaction,
  transactionId: string,
  verifyLinkedFixed = true,
): Promise<JournalFileSnapshot | null> {
  const path = journalTemporaryPath(transaction, transactionId);
  const snapshot = await readOwnedFile(
    path,
    transaction.uid,
    [1, 2],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (snapshot === null) return null;
  const journal = parseValidatedJournal(transaction, snapshot.content, transactionId);
  if (snapshot.identity.nlink === 2 && verifyLinkedFixed) {
    const fixed = await readOwnedFile(
      transaction.journalPath,
      transaction.uid,
      [2],
      maxTransactionMetadataBytes,
      transaction.metadataReadHook,
    );
    if (fixed === null || fixed.content !== snapshot.content || !sameInode(snapshot.identity, fixed.identity)) {
      throw transactionPathError('journal temporary hard-link prefix is unverifiable');
    }
  }
  return { ...snapshot, journal };
}

function parseValidatedJournal(
  transaction: ServiceTransaction,
  content: string,
  expectedTransactionId?: string,
): TransactionJournal {
  let journal: TransactionJournal;
  try { journal = JSON.parse(content) as TransactionJournal; }
  catch (error) { throw transactionPathError('transaction journal is invalid', error); }
  if (expectedTransactionId !== undefined && journal.transactionId !== expectedTransactionId) {
    throw transactionPathError('journal temporary owner mismatch');
  }
  validateJournal({ ...transaction, id: journal.transactionId }, journal);
  return journal;
}

function journalTemporaryPath(transaction: ServiceTransaction, transactionId: string): string {
  if (!validTransactionId(transactionId)) throw transactionPathError('journal temporary transaction ID is invalid');
  const path = `${transaction.journalPath}.tmp-${transactionId}`;
  assertContained(transaction.paths.serviceDirectory, path);
  return path;
}

async function recoverInterruptedTransaction(
  transaction: ServiceTransaction,
  predecessorTransactionIds: readonly string[],
): Promise<void> {
  let snapshot = await readOwnedFile(
    transaction.journalPath,
    transaction.uid,
    [1],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (snapshot === null) return;
  let journal: TransactionJournal;
  try { journal = JSON.parse(snapshot.content) as TransactionJournal; }
  catch (error) { throw transactionPathError('transaction journal is invalid', error); }
  if (!predecessorTransactionIds.includes(journal.transactionId)) {
    throw transactionPathError('transaction journal owner mismatch');
  }
  validateJournal({ ...transaction, id: journal.transactionId }, journal);
  const target = transaction.paths.definitionPath;
  const temporary = journal.temporary === null ? null : join(transaction.paths.serviceDirectory, journal.temporary);
  const quarantine = journal.quarantine === null ? null : join(transaction.paths.serviceDirectory, journal.quarantine);
  let targetIdentity = await readOwnedIdentity(target, transaction.uid, [1, 2]);
  let temporaryIdentity = temporary === null ? null : await readOwnedIdentity(temporary, transaction.uid, [1, 2]);
  const quarantineIdentity = quarantine === null ? null : await readOwnedIdentity(quarantine, transaction.uid, [1, 2]);
  /**
   * A crash-left quarantine is the one object in this file whose identity arrives from disk rather
   * than from an inspection this process made, so the window across the crash is nobody's to
   * close and the journal's `original` stays a hint there. The window from here to the restore
   * link is this process's own, and it is the one a contender can use: without the pin, deleting
   * the quarantine and writing its own file at that path produces something the tuple accepts, and
   * the recovery links a stranger back into place as the user's launchd definition.
   */
  const quarantinePin = quarantine === null || quarantineIdentity === null ? null : await pinInode(quarantine);
  try {
    if (journal.operation === 'publish') {
      if (journal.phase === 'preparing') {
        if (temporary === null || journal.expected === null || journal.expected === undefined) {
          throw transactionPathError('publish pre-intent is incomplete');
        }
        if (quarantineIdentity !== null) throw transactionPathError('publish pre-intent has an impossible quarantine');
        const preIntentTargetIdentity = await readOwnedIdentity(target, transaction.uid, [1]);
        if ((journal.original === null && preIntentTargetIdentity !== null)
          || (journal.original !== null
            && (preIntentTargetIdentity === null || !sameInode(journal.original, preIntentTargetIdentity)))) {
          throw transactionPathError('publish pre-intent source identity changed');
        }
        const temporarySnapshot = await readOwnedFile(
          temporary,
          transaction.uid,
          [1],
          maxManagedDefinitionBytes,
          transaction.metadataReadHook,
        );
        if (temporarySnapshot === null) {
          await transaction.assertOwned();
          await removeExactFile(transaction.journalPath, snapshot.identity, transaction.uid, [1]);
          return;
        }
        if (!sameExpectedContent(journal.expected, temporarySnapshot.content)) {
          throw transactionPathError('publish pre-intent temporary content mismatch');
        }
        journal = { ...journal, phase: 'prepared', replacement: temporarySnapshot.identity };
        await writeRecoveredTransactionJournal(transaction, journal);
        await runTransactionHook(transaction, 'temporary-adopted');
        await transaction.assertOwned();
        const adoptedSnapshot = await readOwnedFile(
          transaction.journalPath,
          transaction.uid,
          [1],
          maxTransactionMetadataBytes,
          transaction.metadataReadHook,
        );
        if (adoptedSnapshot === null) throw transactionPathError('adopted transaction journal disappeared');
        snapshot = adoptedSnapshot;
        targetIdentity = await readOwnedIdentity(target, transaction.uid, [1, 2]);
        temporaryIdentity = temporarySnapshot.identity;
      }
      if (journal.replacement === null) throw transactionPathError('publish journal lacks replacement identity');
      if (temporaryIdentity !== null && !sameInode(journal.replacement, temporaryIdentity)) {
        throw transactionPathError('publish temporary identity mismatch');
      }
      if (targetIdentity !== null && sameInode(journal.replacement, targetIdentity)) {
        if (temporaryIdentity !== null) {
          if (!sameInode(targetIdentity, temporaryIdentity)) throw transactionPathError('published temp identity mismatch');
          await transaction.assertOwned();
          await removeExactFile(temporary as string, temporaryIdentity, transaction.uid, [2]);
        }
        const stable = await readOwnedIdentity(target, transaction.uid, [1]);
        if (stable === null || !sameInode(journal.replacement, stable)) throw transactionPathError('published target did not stabilize');
        if (quarantineIdentity !== null) {
          if (journal.original === null || !sameInode(journal.original, quarantineIdentity)) {
            throw transactionPathError('replacement quarantine identity mismatch');
          }
          await transaction.assertOwned();
          await removeExactFile(quarantine as string, quarantineIdentity, transaction.uid, [1]);
        }
      } else if (targetIdentity === null) {
        if (quarantineIdentity !== null) {
          if (journal.original === null || !sameInode(journal.original, quarantineIdentity)) {
            throw transactionPathError('restore quarantine identity mismatch');
          }
          await runTransactionHook(transaction, 'before-restore-link');
          await transaction.assertOwned();
          const exactQuarantine = await readOwnedIdentity(quarantine as string, transaction.uid, [1]);
          // The pin was taken on the same object `journal.original` was just matched against, so
          // `sameInode(journal.original, exactQuarantine)` used to stand here as well. It is gone on
          // purpose: it is the weaker half of this exact question, it answers wrongly wherever inode
          // numbers are reissued, and leaving it beside the pin would have kept this boundary green
          // on macOS no matter what the pin did -- which is how a check stops being load-bearing
          // without anyone noticing.
          if (exactQuarantine === null || !await pinStillHolds(quarantinePin, exactQuarantine)) {
            throw transactionPathError('restore quarantine was replaced at link boundary');
          }
          await link(quarantine as string, target);
          const linkedQuarantine = await readOwnedIdentity(quarantine as string, transaction.uid, [2]);
          const linkedTarget = await readOwnedIdentity(target, transaction.uid, [2]);
          if (linkedQuarantine === null || linkedTarget === null
            || !sameInode(journal.original, linkedQuarantine)
            || !sameInode(journal.original, linkedTarget)
            || !sameInode(linkedQuarantine, linkedTarget)) {
            if (linkedQuarantine !== null && linkedTarget !== null && sameInode(linkedQuarantine, linkedTarget)) {
              await removeExactFile(target, linkedTarget, transaction.uid, [2]);
            }
            throw transactionPathError('restore quarantine changed during link');
          }
          await runTransactionHook(transaction, 'restore-linked');
          await transaction.assertOwned();
          await removeExactFile(quarantine as string, journal.original, transaction.uid, [2]);
          const restored = await readOwnedIdentity(target, transaction.uid, [1]);
          if (restored === null || !sameInode(journal.original, restored)) throw transactionPathError('old definition restore failed');
        } else if (journal.original !== null) {
          throw transactionPathError('old definition disappeared during interrupted publication');
        }
        if (temporaryIdentity !== null) {
          await transaction.assertOwned();
          await removeExactFile(temporary as string, temporaryIdentity, transaction.uid, [1]);
        }
      } else if (quarantineIdentity !== null && journal.original !== null
        && sameInode(journal.original, targetIdentity) && sameInode(targetIdentity, quarantineIdentity)
        && targetIdentity.nlink === 2 && quarantineIdentity.nlink === 2) {
        await transaction.assertOwned();
        await removeExactFile(quarantine as string, quarantineIdentity, transaction.uid, [2]);
        const stable = await readOwnedIdentity(target, transaction.uid, [1]);
        if (stable === null || !sameInode(journal.original, stable)) throw transactionPathError('restored target did not stabilize');
        if (temporaryIdentity !== null) {
          await transaction.assertOwned();
          await removeExactFile(temporary as string, temporaryIdentity, transaction.uid, [1]);
        }
      } else {
        if (temporaryIdentity !== null) {
          await transaction.assertOwned();
          await removeExactFile(temporary as string, temporaryIdentity, transaction.uid, [1]);
        }
        if (quarantineIdentity !== null) {
          if (journal.original === null || !sameInode(journal.original, quarantineIdentity)) {
            throw transactionPathError('concurrent-winner quarantine mismatch');
          }
          await transaction.assertOwned();
          await removeExactFile(quarantine as string, quarantineIdentity, transaction.uid, [1]);
        }
      }
    } else {
      if (journal.original === null) throw transactionPathError('removal journal lacks original identity');
      if (quarantineIdentity !== null) {
        if (!sameInode(journal.original, quarantineIdentity)) throw transactionPathError('removal quarantine identity mismatch');
        await transaction.assertOwned();
        await removeExactFile(quarantine as string, quarantineIdentity, transaction.uid, [1]);
      } else if (targetIdentity !== null && !sameInode(journal.original, targetIdentity)) {
        // A concurrent winner is preserved; the exact removal object is already absent.
      }
    }
    await transaction.assertOwned();
    await removeExactFile(transaction.journalPath, snapshot.identity, transaction.uid, [1]);
  } finally {
    await quarantinePin?.close();
  }
}

async function removeJournalIfOwned(transaction: ServiceTransaction): Promise<void> {
  const snapshot = await readOwnedFile(
    transaction.journalPath,
    transaction.uid,
    [1],
    maxTransactionMetadataBytes,
    transaction.metadataReadHook,
  );
  if (snapshot === null) return;
  let journal: TransactionJournal;
  try { journal = JSON.parse(snapshot.content) as TransactionJournal; }
  catch (error) { throw transactionPathError('transaction journal is invalid', error); }
  if (journal.transactionId !== transaction.id) throw transactionPathError('transaction journal changed owners');
  validateJournal(transaction, journal);
  await removeExactFile(transaction.journalPath, snapshot.identity, transaction.uid, [1]);
}

function validateJournal(transaction: ServiceTransaction, journal: TransactionJournal): void {
  if (journal.version !== 1 || journal.transactionId !== transaction.id || !['publish', 'remove'].includes(journal.operation)
    || !['preparing', 'prepared', 'old-quarantined', 'new-linked', 'temporary-unlinked', 'removal-quarantined', 'removal-cleaned'].includes(journal.phase)) {
    throw transactionPathError('transaction journal schema is invalid');
  }
  const phaseAllowed = journal.operation === 'publish'
    ? ['preparing', 'prepared', 'old-quarantined', 'new-linked', 'temporary-unlinked'].includes(journal.phase)
    : ['prepared', 'removal-quarantined', 'removal-cleaned'].includes(journal.phase);
  if (!phaseAllowed) throw transactionPathError('transaction journal phase is invalid');
  const targetName = transaction.paths.definitionPath.split(sep).at(-1) as string;
  const expectedTemporary = `${targetName}.tmp-${transaction.id}`;
  const expectedQuarantine = `${targetName}.${journal.operation === 'publish' ? 'replaced' : 'removed'}-${transaction.id}`;
  if ((journal.temporary !== null && journal.temporary !== expectedTemporary)
    || (journal.quarantine !== null && journal.quarantine !== expectedQuarantine)) {
    throw transactionPathError('transaction journal contains an unsafe path');
  }
  if ((journal.original !== null && !validJournalIdentity(journal.original, transaction.uid))
    || (journal.replacement !== null && !validJournalIdentity(journal.replacement, transaction.uid))) {
    throw transactionPathError('transaction journal identity is invalid');
  }
  if (journal.operation === 'publish') {
    if (journal.temporary === null || journal.quarantine === null
      || (journal.phase === 'preparing' && journal.replacement !== null)
      || (journal.phase !== 'preparing' && journal.replacement === null)
      || (journal.expected !== undefined && journal.expected !== null && !validExpectedContent(journal.expected))
      || (journal.phase === 'preparing' && !validExpectedContent(journal.expected))) {
      throw transactionPathError('transaction journal publish intent is invalid');
    }
  } else if (journal.temporary !== null || journal.quarantine === null || journal.replacement !== null
    || (journal.expected !== undefined && journal.expected !== null)) {
    throw transactionPathError('transaction journal removal intent is invalid');
  }
  if (journal.failure !== undefined && journal.failure !== null && (
    typeof journal.failure !== 'object'
    || Object.values(journal.failure).some((value) => !['string', 'number', 'boolean'].includes(typeof value) && value !== null)
  )) throw transactionPathError('transaction journal failure evidence is invalid');
}

function validExpectedContent(value: unknown): value is ExpectedContentIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExpectedContentIdentity>;
  return Number.isSafeInteger(candidate.byteLength)
    && (candidate.byteLength as number) >= 0
    && (candidate.byteLength as number) <= maxManagedDefinitionBytes
    && typeof candidate.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(candidate.sha256);
}

function validJournalIdentity(value: FileIdentity, uid: number): boolean {
  return typeof value === 'object' && value !== null
    && Number.isSafeInteger(value.dev) && Number.isSafeInteger(value.ino)
    && value.uid === uid && Number.isSafeInteger(value.mode)
    && (value.mode & 0o077) === 0 && (value.nlink === 1 || value.nlink === 2);
}

function expectedContentIdentity(content: string): ExpectedContentIdentity {
  return {
    byteLength: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

function sameExpectedContent(expected: ExpectedContentIdentity, content: string): boolean {
  const actual = expectedContentIdentity(content);
  return actual.byteLength === expected.byteLength && actual.sha256 === expected.sha256;
}

async function runTransactionHook(transaction: ServiceTransaction, phase: ServiceTransactionPhase): Promise<void> {
  if (await transaction.hook?.(phase) === 'interrupt') {
    throw new ServiceLifecycleError(
      'LAUNCHD_TRANSACTION_INTERRUPTED',
      'Injected launchd transaction interruption.',
      { phase },
    );
  }
}

function isTransactionInterruption(error: unknown): boolean {
  return error instanceof ServiceLifecycleError && error.code === 'LAUNCHD_TRANSACTION_INTERRUPTED';
}

async function readOwnedIdentity(path: string, uid: number, allowedLinks: readonly number[]): Promise<FileIdentity | null> {
  try { return assertOwnedFileStat(await lstat(path), uid, allowedLinks); }
  catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw error; }
}

async function assertExactLockOwner(
  path: string,
  expected: FileIdentity,
  expectedContent: string,
  uid: number,
  readHook?: ServiceLifecycleOptions['metadataReadHook'],
  claimPath?: string,
): Promise<void> {
  const current = await readOwnedFile(path, uid, claimPath === undefined ? [1] : [2], maxTransactionMetadataBytes, readHook);
  if (current === null || !sameInode(expected, current.identity) || current.content !== expectedContent) {
    throw transactionPathError('lock identity changed');
  }
  if (claimPath !== undefined) {
    const claim = await readOwnedFile(claimPath, uid, [2], maxTransactionMetadataBytes, readHook);
    if (claim === null || !sameInode(expected, claim.identity) || claim.content !== expectedContent) {
      throw transactionPathError('lock successor claim changed');
    }
  }
}

async function readOwnedFile(
  path: string,
  uid: number,
  allowedLinks: readonly number[],
  maxBytes = maxTransactionMetadataBytes,
  readHook?: ServiceLifecycleOptions['metadataReadHook'],
): Promise<{ content: string; identity: FileIdentity } | null> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw transactionPathError('transaction metadata is unsafe', error);
  }
  try {
    const initialStat = await handle.stat();
    const identity = assertMetadataFileStat(initialStat, uid, allowedLinks);
    if (initialStat.size > maxBytes) throw oversizedTransactionMetadata();
    await readHook?.(path);
    const content = await readBoundedHandle(handle, maxBytes, () => { throw oversizedTransactionMetadata(); });
    const finalStat = await handle.stat();
    assertMetadataFileStat(finalStat, uid, allowedLinks);
    if (finalStat.size > maxBytes) throw oversizedTransactionMetadata();
    if (!sameMetadataSnapshot(initialStat, finalStat)) {
      throw transactionPathError('transaction metadata changed while reading');
    }
    let pathStat: Awaited<ReturnType<typeof lstat>>;
    try { pathStat = await lstat(path); }
    catch (error) { throw transactionPathError('transaction metadata identity changed', error); }
    assertMetadataFileStat(pathStat, uid, allowedLinks);
    if (!sameMetadataSnapshot(initialStat, pathStat)) {
      throw transactionPathError('transaction metadata identity changed');
    }
    return { content, identity };
  } finally { await handle.close(); }
}

async function readBoundedHandle(
  handle: FileHandle,
  maxBytes: number,
  tooLarge: () => never,
): Promise<string> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset <= maxBytes) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) return tooLarge();
  return buffer.subarray(0, offset).toString('utf8');
}

function oversizedTransactionMetadata(): ServiceLifecycleError {
  return new ServiceLifecycleError(
    'UNSAFE_LAUNCHD_PATH',
    'launchd transaction metadata is unexpectedly large',
    { artifact: 'transaction-metadata', reason: 'too-large' },
  );
}

function assertMetadataFileStat(
  stat: Awaited<ReturnType<typeof lstat>> | Awaited<ReturnType<FileHandle['stat']>>,
  uid: number,
  allowedLinks: readonly number[],
): FileIdentity {
  const identity = assertOwnedFileStat(stat, uid, allowedLinks);
  if ((identity.mode & 0o777) !== 0o600) throw transactionPathError('transaction metadata mode is unsafe');
  return identity;
}

function sameMetadataSnapshot(
  left: Awaited<ReturnType<typeof lstat>> | Awaited<ReturnType<FileHandle['stat']>>,
  right: Awaited<ReturnType<typeof lstat>> | Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && left.uid === right.uid
    && Number(left.mode) === Number(right.mode)
    && Number(left.nlink) === Number(right.nlink)
    && Number(left.size) === Number(right.size)
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertOwnedFileStat(
  stat: Awaited<ReturnType<typeof lstat>> | Awaited<ReturnType<FileHandle['stat']>>,
  uid: number,
  allowedLinks: readonly number[],
): FileIdentity {
  const mode = Number(stat.mode);
  const nlink = Number(stat.nlink);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || !allowedLinks.includes(nlink) || (mode & 0o077) !== 0) {
    throw transactionPathError('transaction artifact is unsafe');
  }
  return { dev: Number(stat.dev), ino: Number(stat.ino), uid: stat.uid, mode, nlink };
}

async function removeExactFile(path: string, expected: FileIdentity, uid: number, links: readonly number[]): Promise<void> {
  const current = await readOwnedIdentity(path, uid, links);
  if (current === null || !sameInode(expected, current)) throw transactionPathError('transaction artifact identity changed');
  await rm(path);
  await syncDirectory(resolve(path, '..'));
}

async function removeExactFileIfPresent(
  path: string,
  expected: FileIdentity,
  uid: number,
  links: readonly number[],
): Promise<void> {
  const current = await readOwnedIdentity(path, uid, links);
  if (current === null) return;
  if (!sameInode(expected, current)) throw transactionPathError('transaction artifact identity changed');
  await removeExactFile(path, expected, uid, links);
}

function sameInode(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function parseOwnerMetadata(content: string): LockOwnerMetadata {
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { throw transactionPathError('lock metadata is invalid', error); }
  return normalizeOwnerMetadata(value);
}

function normalizeOwnerMetadata(value: unknown): LockOwnerMetadata {
  if (typeof value !== 'object' || value === null) throw transactionPathError('lock metadata is invalid');
  const candidate = value as Partial<LockOwnerMetadata>;
  if (candidate.version !== 1 || !Number.isSafeInteger(candidate.pid) || (candidate.pid as number) < 1
    || typeof candidate.startIdentity !== 'string' || candidate.startIdentity.length < 1 || candidate.startIdentity.length > 256
    || candidate.startIdentity.includes('\0') || candidate.startIdentity.includes('\n') || candidate.startIdentity.includes('\r')
    || typeof candidate.transactionId !== 'string'
    || !validTransactionId(candidate.transactionId)) {
    throw transactionPathError('lock metadata is invalid');
  }
  const predecessors = candidate.predecessorTransactionIds === undefined
    ? []
    : candidate.predecessorTransactionIds;
  if (!Array.isArray(predecessors)
    || predecessors.length > maxOwnerPredecessors
    || predecessors.some((transactionId) => typeof transactionId !== 'string' || !validTransactionId(transactionId))
    || predecessors.includes(candidate.transactionId)
    || new Set(predecessors).size !== predecessors.length) {
    throw transactionPathError('lock predecessor metadata is invalid');
  }
  return {
    version: 1,
    pid: candidate.pid as number,
    startIdentity: candidate.startIdentity,
    transactionId: candidate.transactionId,
    predecessorTransactionIds: [...predecessors],
  };
}

function validateOwnerMetadata(value: LockOwnerMetadata): void {
  normalizeOwnerMetadata(value);
}

function validTransactionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}


async function assertSafeExistingDirectoryChain(
  scope: ServiceScope,
  directory: string,
  uid: number,
): Promise<DirectoryIdentity | null> {
  assertContained(scope.root, directory);
  try { await assertSafeDirectory(scope.root, uid); }
  catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw error; }
  const child = relative(scope.root, directory);
  let current = resolve(scope.root);
  if (child !== '') {
    for (const part of child.split(sep)) {
      current = join(current, part);
      try { await assertSafeDirectory(current, uid); }
      catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw error; }
    }
  }
  // The definition directory is the one link in the chain whose mode requirement the backend gets
  // to state. This was spelled `directory.endsWith('/LaunchAgents')`; naming the directory by
  // identity rather than by suffix is what lets a systemd unit directory reach the same check
  // without it learning a second filename -- and lets that backend answer `false`, because a
  // directory shared with `systemctl enable` is 0755 everywhere and is not WTM's to tighten.
  const definitionDirectory = resolve(directory) === resolve(scope.serviceDirectory);
  return await assertSafeDirectory(directory, uid, definitionDirectory && scope.serviceDirectoryOwnerOnly);
}

async function assertSafeDirectory(path: string, uid: number, ownerOnly = false): Promise<DirectoryIdentity> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try { stat = await lstat(path); }
  catch (error) { if (isNodeError(error, 'ENOENT')) throw error; throw pathError('Unsafe launchd directory', error); }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || (stat.mode & 0o022) !== 0
    || (ownerOnly && (stat.mode & 0o077) !== 0)
  ) throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'Unsafe launchd directory');
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  uid: number,
  ownerOnly = false,
): Promise<void> {
  const current = await assertSafeDirectory(path, uid, ownerOnly);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.uid !== expected.uid) {
    throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd directory identity changed');
  }
}

function assertSafeFileStat(
  stat: Awaited<ReturnType<FileHandle['stat']>> | Awaited<ReturnType<typeof lstat>>,
  uid: number,
): FileIdentity {
  const mode = Number(stat.mode);
  const nlink = Number(stat.nlink);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || nlink !== 1 || (mode & 0o077) !== 0) {
    throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'Unsafe launchd plist target');
  }
  return { dev: Number(stat.dev), ino: Number(stat.ino), uid: stat.uid, mode, nlink };
}

function assertSameFileIdentity(left: FileIdentity, right: FileIdentity): void {
  if (!sameFileIdentity(left, right)) {
    throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist identity changed');
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && right.nlink === 1;
}

function sameOptionalIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && right.nlink === 1;
}

function assertContained(root: string, target: string): void {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const child = relative(absoluteRoot, absoluteTarget);
  if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) return;
  throw new ServiceLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd path escapes the configured home');
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw configurationError(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw configurationError(`${label} must be a non-negative integer`);
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

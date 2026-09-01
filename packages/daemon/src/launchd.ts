import { execFile, type ExecException } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { daemonDataRoot } from '@wtm/core';

/**
 * The bare label every WTM installation published under before the label was derived. A launchd
 * service name is `gui/<uid>/<label>`, so under one uid this one name is one service: two HOMEs
 * could not both bootstrap it, and `daemon status` answered from whichever agent got there first
 * while naming this HOME's plist. It survives only so an installation that used it can be taken
 * over, and so the artifacts it named can be swept.
 */
export const legacyLaunchdLabel = 'dev.wtm.daemon';

/**
 * The label this HOME's agent is published under. The digest is SHA-256 over the resolved
 * absolute HOME, truncated to 128 bits: derived from the path alone so it is identical on every
 * run, hex so it is legal in a launchd label and in every filename built from that label, and
 * wide enough that two distinct HOMEs colliding is not a case this design has to answer for.
 */
export function launchdLabelFor(home: string): string {
  assertAbsolute(home, 'launchd home');
  return `${legacyLaunchdLabel}.${createHash('sha256').update(resolve(home), 'utf8').digest('hex').slice(0, 32)}`;
}
const launchctlPath = '/bin/launchctl';
const maxCommandOutputBytes = 4 * 1024;
/**
 * `launchctl print gui/<uid>` lists every service in the domain, which is hundreds of
 * kilobytes on a working desktop session. Capping the child's own buffer at the reporting
 * limit made execFile kill it and report a domain that is in fact perfectly available, so
 * the command is allowed to speak freely and only what is retained stays truncated.
 */
const maxCommandBufferBytes = 8 * 1024 * 1024;
const maxManagedPlistBytes = 64 * 1024;
const maxTransactionMetadataBytes = 16 * 1024;
const maxOwnerPredecessors = 8;
const defaultPathEnvironment = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

export interface LaunchdPaths {
  home: string;
  /** The launchd label this HOME publishes under; every managed filename is built from it. */
  label: string;
  libraryDirectory: string;
  agentsDirectory: string;
  plistPath: string;
  /** Where an installation made before the label was derived left its definition. */
  legacyPlistPath: string;
  dataRoot: string;
  logRoot: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface LaunchdPlistOptions {
  label: string;
  programArguments: readonly string[];
  home: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Readonly<Record<string, string>>;
}

export interface LaunchdCommandSet {
  print: readonly string[];
  printDomain: readonly string[];
  enable: readonly string[];
  bootstrap: readonly string[];
  bootout: readonly string[];
  kickstart: readonly string[];
}

export interface LaunchdCommandResult {
  outcome: 'success' | 'not-found' | 'failure';
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type LaunchdCommandRunner = (argv: readonly string[]) => Promise<LaunchdCommandResult>;

export interface LaunchdProcessInspection {
  state: 'live' | 'dead' | 'unknown';
  startIdentity: string | null;
}

export interface LaunchdProcessInspector {
  current(): Promise<{ pid: number; startIdentity: string }>;
  inspect(pid: number): Promise<LaunchdProcessInspection>;
}

export type LaunchdTransactionPhase =
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

export type LaunchdInstallState = 'installed' | 'reinstalled' | 'restarted' | 'already-installed';
export type LaunchdUninstallState = 'uninstalled' | 'already-absent';
export type LaunchdStatusState = 'loaded' | 'installed-not-loaded' | 'absent';

export interface LaunchdStatusResult extends LaunchdLifecycleResult<LaunchdStatusState> {
  /**
   * launchd's own word for the job: `running` while a process is alive, `not running` when
   * the job is loaded but idle, and `null` when launchd does not know the job at all.
   */
  runState: string | null;
}

export interface LaunchdLifecycleResult<State extends string> {
  action: 'install' | 'uninstall' | 'status';
  state: State;
  label: string;
  plistPath: string;
}

export interface LaunchdLifecycle {
  install(): Promise<LaunchdLifecycleResult<LaunchdInstallState>>;
  uninstall(): Promise<LaunchdLifecycleResult<LaunchdUninstallState>>;
  status(): Promise<LaunchdStatusResult>;
}

export interface LaunchdLifecycleOptions {
  home?: string;
  uid?: number;
  fileOwnerUid?: number;
  platform?: NodeJS.Platform;
  programArguments: readonly string[];
  pathEnvironment?: string;
  commandRunner?: LaunchdCommandRunner;
  absencePollAttempts?: number;
  publicationHook?: (
    phase: 'before-publish' | 'before-replace-move' | 'before-link',
    plistPath: string,
  ) => void | Promise<void>;
  removalHook?: (phase: 'before-remove' | 'before-quarantine', plistPath: string) => void | Promise<void>;
  processInspector?: LaunchdProcessInspector;
  lockPollAttempts?: number;
  transactionHook?: (phase: LaunchdTransactionPhase) => 'continue' | 'interrupt' | Promise<'continue' | 'interrupt'>;
  metadataReadHook?: (path: string) => void | Promise<void>;
}

export type LaunchdLifecycleErrorCode =
  | 'LAUNCHD_UNSUPPORTED_PLATFORM'
  | 'LAUNCHD_DOMAIN_UNAVAILABLE'
  | 'LAUNCHD_COMMAND_FAILED'
  | 'INVALID_LAUNCHD_CONFIGURATION'
  | 'UNSAFE_LAUNCHD_PATH'
  | 'LAUNCHD_ROLLBACK_FAILED'
  | 'LAUNCHD_ROLLBACK_CONFLICT'
  | 'LAUNCHD_OPERATION_BUSY'
  | 'LAUNCHD_TRANSACTION_INTERRUPTED';

export class LaunchdLifecycleError extends Error {
  constructor(
    readonly code: LaunchdLifecycleErrorCode,
    message: string,
    readonly context: Readonly<Record<string, string | number | boolean | null>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LaunchdLifecycleError';
  }
}

export function launchdPaths(home = homedir()): LaunchdPaths {
  assertAbsolute(home, 'launchd home');
  const resolvedHome = resolve(home);
  const libraryDirectory = join(resolvedHome, 'Library');
  const agentsDirectory = join(libraryDirectory, 'LaunchAgents');
  // Not spelled out here: the socket, the database and the global config all live under this
  // root, and a copy in this file is the copy most likely to drift -- nothing in launchd's paths
  // would notice if it did. @wtm/core owns it.
  const dataRoot = daemonDataRoot(resolvedHome);
  const logRoot = join(libraryDirectory, 'Logs', 'WTM');
  const label = launchdLabelFor(resolvedHome);
  return {
    home: resolvedHome,
    label,
    libraryDirectory,
    agentsDirectory,
    plistPath: join(agentsDirectory, `${label}.plist`),
    legacyPlistPath: join(agentsDirectory, `${legacyLaunchdLabel}.plist`),
    dataRoot,
    logRoot,
    stdoutPath: join(logRoot, 'daemon.log'),
    stderrPath: join(logRoot, 'daemon.error.log'),
  };
}

export function launchdCommands(options: { uid: number; plistPath: string }): LaunchdCommandSet {
  const uid = nonNegativeInteger(options.uid, 'launchd uid');
  assertAbsolute(options.plistPath, 'launchd plist path');
  const domain = `gui/${uid}`;
  // The service name is read out of the plist path rather than fixed, so the commands always
  // address the definition they are given -- the derived label, or the legacy one being retired.
  const service = `${domain}/${labelFromPlistPath(options.plistPath)}`;
  return {
    print: [launchctlPath, 'print', service],
    printDomain: [launchctlPath, 'print', domain],
    enable: [launchctlPath, 'enable', service],
    bootstrap: [launchctlPath, 'bootstrap', domain, resolve(options.plistPath)],
    bootout: [launchctlPath, 'bootout', service],
    kickstart: [launchctlPath, 'kickstart', '-k', service],
  };
}

/**
 * A launchd label is the plist's own basename. Deriving the service name from the path keeps
 * `launchdCommands` honest: it cannot address one agent while bootstrapping another.
 */
function labelFromPlistPath(plistPath: string): string {
  const name = resolve(plistPath).split(sep).at(-1) as string;
  const label = name.endsWith('.plist') ? name.slice(0, -'.plist'.length) : '';
  if (label.length === 0 || !/^[A-Za-z0-9._-]+$/.test(label)) {
    throw configurationError('launchd plist path must name a launchd label');
  }
  return label;
}

export function sanitizeLaunchdPathEnvironment(value = defaultPathEnvironment): string {
  if (value.length === 0 || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw configurationError('launchd PATH is invalid');
  }
  const entries = value.split(':');
  if (entries.some((entry) => entry.length === 0 || !isAbsolute(entry))) {
    throw configurationError('launchd PATH entries must be absolute');
  }
  return [...new Set(entries.map((entry) => resolve(entry)))].join(':');
}

export function generateLaunchdPlist(options: LaunchdPlistOptions): string {
  assertXmlValue(options.label, 'launchd label');
  if (options.programArguments.length === 0) throw configurationError('launchd argv must not be empty');
  assertAbsolute(options.programArguments[0] as string, 'launchd executable');
  for (const argument of options.programArguments) assertXmlValue(argument, 'launchd argument');
  for (const [path, name] of [
    [options.home, 'launchd home'],
    [options.stdoutPath, 'launchd stdout path'],
    [options.stderrPath, 'launchd stderr path'],
  ] as const) assertAbsolute(path, name);
  const environment = Object.entries(options.environment ?? {}).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of environment) {
    assertXmlValue(key, 'launchd environment key');
    assertXmlValue(value, 'launchd environment value');
  }
  const argumentsXml = options.programArguments.map((argument) => `    <string>${escapeXml(argument)}</string>`).join('\n');
  const environmentXml = environment.length === 0 ? '' : `  <key>EnvironmentVariables</key>
  <dict>
${environment.map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
`;
  // ProcessType is Adaptive rather than Background. launchd throttles a Background job's CPU
  // and disk I/O, and everything it spawns inherits the throttle: the port prober — one
  // short-lived process per candidate port — took longer than its own two-second timeout, so
  // every port read as taken, and the developer's own dev server ran throttled too. Nothing
  // this daemon does is unattended work; it exists to serve commands a person just typed.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
${environmentXml}  <key>WorkingDirectory</key>
  <string>${escapeXml(resolve(options.home))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Adaptive</string>
  <key>ExitTimeOut</key>
  <integer>5</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(resolve(options.stdoutPath))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(resolve(options.stderrPath))}</string>
</dict>
</plist>
`;
}

export function createLaunchdLifecycle(options: LaunchdLifecycleOptions): LaunchdLifecycle {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const paths = launchdPaths(home);
  const uid = nonNegativeInteger(options.uid ?? process.getuid?.() ?? -1, 'launchd uid');
  const ownerUid = nonNegativeInteger(options.fileOwnerUid ?? process.getuid?.() ?? uid, 'launchd file owner uid');
  const commands = launchdCommands({ uid, plistPath: paths.plistPath });
  const legacyCommands = launchdCommands({ uid, plistPath: paths.legacyPlistPath });
  const runner = options.commandRunner ?? runLaunchctl;
  const pollAttempts = positiveInteger(options.absencePollAttempts ?? 20, 'launchd absence poll attempts');
  const lockPollAttempts = positiveInteger(options.lockPollAttempts ?? 100, 'launchd lock poll attempts');
  const processInspector = options.processInspector ?? defaultProcessInspector;
  const pathEnvironment = sanitizeLaunchdPathEnvironment(
    options.pathEnvironment ?? process.env.PATH ?? defaultPathEnvironment,
  );
  const plist = generateLaunchdPlist({
    label: paths.label,
    programArguments: options.programArguments,
    home: paths.home,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    environment: { HOME: paths.home, PATH: pathEnvironment },
  });

  const assertPlatform = () => {
    if (platform !== 'darwin') {
      throw new LaunchdLifecycleError('LAUNCHD_UNSUPPORTED_PLATFORM', 'launchd is only available on macOS');
    }
  };

  const describe = async (): Promise<{ loaded: boolean; runState: string | null }> => {
    const service = await runner(commands.print);
    if (service.outcome === 'success') return { loaded: true, runState: runState(service.stdout) };
    if (!isAbsentResult(service)) throw commandError('print', service);
    const domain = await runner(commands.printDomain);
    if (domain.outcome !== 'success') {
      throw new LaunchdLifecycleError(
        'LAUNCHD_DOMAIN_UNAVAILABLE',
        'The launchd GUI domain is unavailable.',
        commandContext('print-domain', domain),
      );
    }
    return { loaded: false, runState: null };
  };

  const loaded = async (): Promise<boolean> => (await describe()).loaded;

  const waitUntilAbsent = async (print: readonly string[] = commands.print): Promise<void> => {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const result = await runner(print);
      if (isAbsentResult(result)) return;
      if (result.outcome !== 'success') throw commandError('print', result);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(10 * (attempt + 1), 50)));
    }
    throw new LaunchdLifecycleError('LAUNCHD_COMMAND_FAILED', 'launchd service did not stop in time', {
      operation: 'bootout', attempts: pollAttempts,
    });
  };

  const legacyServiceLoaded = async (): Promise<boolean> => {
    const printed = await runner(legacyCommands.print);
    if (printed.outcome === 'success') return true;
    if (!isAbsentResult(printed)) throw commandError('legacy-print', printed);
    return false;
  };

  const bootOutLegacyService = async (transaction: LaunchdTransaction): Promise<void> => {
    if (!await legacyServiceLoaded()) return;
    await transaction.assertOwned();
    const bootout = await runner(legacyCommands.bootout);
    if (bootout.outcome !== 'success' && !isAbsentResult(bootout)) throw commandError('legacy-bootout', bootout);
    await waitUntilAbsent(legacyCommands.print);
  };

  /**
   * The only legacy service this HOME may touch is the one its own plist defines. A legacy
   * service loaded from another HOME's plist is that HOME's daemon: booting it out would turn a
   * reporting bug into a destructive one, so nothing here is done unless this HOME's own legacy
   * plist is present and names this HOME.
   *
   * The sweep is unconditional. The derived label is what makes an old-label journal, lock or
   * quarantine unreachable -- `validateJournal` rebuilds those names from the label and rejects
   * anything else as an unsafe path -- so this is the last code that can still recognise them.
   */
  const takeOverLegacyLabel = async (transaction: LaunchdTransaction): Promise<FileSnapshot | null> => {
    const legacy = await readAdoptableLegacyPlist(paths, ownerUid);
    if (legacy !== null) await bootOutLegacyService(transaction);
    await sweepLegacyLabelArtifacts(paths, ownerUid, processInspector, transaction);
    return legacy;
  };

  const removeLegacyPlist = async (legacy: FileSnapshot, transaction: LaunchdTransaction): Promise<void> => {
    const current = await readAdoptableLegacyPlist(paths, ownerUid);
    // Anything but the exact file the takeover examined is left alone: it is no longer the
    // definition this migration reasoned about.
    if (current === null || !sameFileIdentity(legacy.identity, current.identity)) return;
    await transaction.assertOwned();
    await removeSafeManagedFile(paths.home, paths.legacyPlistPath, ownerUid, current.identity);
  };

  /** Deletes the old definition only once this HOME's own is published in its place. */
  const retireLegacyPlist = async (legacy: FileSnapshot, transaction: LaunchdTransaction): Promise<void> => {
    if (await readSafeManagedFile(paths.home, paths.plistPath, ownerUid) === null) return;
    await removeLegacyPlist(legacy, transaction);
  };

  /**
   * `status` finishes a takeover; it never starts one it cannot finish. It has no definition to
   * publish, so it removes the legacy plist only when this HOME's own is already published, and
   * boots the legacy service out only when this HOME's own service is loaded to answer in its
   * place. Where those do not hold it reports the derived label's own truth and touches nothing:
   * a command that reads state must not stop the only daemon the user has.
   */
  const finishLegacyLabelMigration = async (): Promise<void> => {
    const legacy = await readAdoptableLegacyPlist(paths, ownerUid);
    if (legacy === null && (await legacyLabelArtifactNames(paths.agentsDirectory)).length === 0) return;
    const published = await readSafeManagedFile(paths.home, paths.plistPath, ownerUid);
    const handOver = legacy !== null && published !== null
      && (!await legacyServiceLoaded() || await loaded());
    await withLaunchdOperationLock(
      paths, ownerUid, processInspector, lockPollAttempts, options.transactionHook, options.metadataReadHook,
      async (transaction) => {
        if (handOver) await bootOutLegacyService(transaction);
        await sweepLegacyLabelArtifacts(paths, ownerUid, processInspector, transaction);
        if (handOver) await retireLegacyPlist(legacy as FileSnapshot, transaction);
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
    transaction: LaunchdTransaction,
  ): Promise<LaunchdLifecycleResult<LaunchdInstallState>> => {
    const existing = await readSafeManagedFile(paths.home, paths.plistPath, ownerUid);
    const wasLoaded = await loaded();
    if (wasLoaded && existing?.content === plist) {
      await transaction.assertOwned();
      const enable = await runner(commands.enable);
      if (enable.outcome !== 'success') throw commandError('enable', enable);
      // The definition names the executable by path, so installing a new build over the
      // old one leaves this plist byte-identical while launchd goes on running the
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

    const changed = existing?.content !== plist;
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
          paths.home,
          paths.plistPath,
          plist,
          ownerUid,
          options.publicationHook,
          transaction,
        );
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
      transaction.failureContext = installError instanceof LaunchdLifecycleError ? installError.context : {};
      try {
        await restorePreviousDefinition(paths, ownerUid, existing, publishedIdentity, transaction);
        if (bootoutAccepted) {
          if (existing === null) throw new Error('Previous loaded definition has no recoverable plist');
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
        if (rollbackError instanceof LaunchdLifecycleError && rollbackError.code === 'LAUNCHD_ROLLBACK_CONFLICT') {
          throw new LaunchdLifecycleError(
            'LAUNCHD_ROLLBACK_CONFLICT',
            'launchd installation failed and a concurrent definition prevented rollback.',
            {
              ...(installError instanceof LaunchdLifecycleError ? installError.context : {}),
              rollback: 'conflict',
            },
            { cause: rollbackError },
          );
        }
        throw new LaunchdLifecycleError(
          'LAUNCHD_ROLLBACK_FAILED',
          'launchd installation failed and the previous definition could not be restored.',
          installError instanceof LaunchdLifecycleError ? installError.context : {},
          { cause: rollbackError },
        );
      }
      throw installError;
    }
  };

  return {
    install: async () => {
      assertPlatform();
      await ensureInstallDirectories(paths, ownerUid);
      return await withLaunchdOperationLock(paths, ownerUid, processInspector, lockPollAttempts, options.transactionHook, options.metadataReadHook, async (transaction) => {
        const legacy = await takeOverLegacyLabel(transaction);
        const result = await publishDerivedInstall(transaction);
        if (legacy !== null) await retireLegacyPlist(legacy, transaction);
        return result;
      });
    },

    uninstall: async () => {
      assertPlatform();
      await ensureLaunchAgentsDirectory(paths, ownerUid);
      return await withLaunchdOperationLock(paths, ownerUid, processInspector, lockPollAttempts, options.transactionHook, options.metadataReadHook, async (transaction) => {
        // An agent published under the previous label is this HOME's agent under an older name.
        // Uninstall is exactly the request to remove it, so it is booted out and deleted rather
        // than left running under a name nothing addresses any more.
        const legacy = await readAdoptableLegacyPlist(paths, ownerUid);
        if (legacy !== null) await bootOutLegacyService(transaction);
        await sweepLegacyLabelArtifacts(paths, ownerUid, processInspector, transaction);
        const wasLoaded = await loaded();
        const existing = await readSafeManagedFile(paths.home, paths.plistPath, ownerUid);
        if (wasLoaded) {
          await transaction.assertOwned();
          const bootout = await runner(commands.bootout);
          if (bootout.outcome !== 'success' && !isAbsentResult(bootout)) throw commandError('bootout', bootout);
          await waitUntilAbsent();
        }
        if (existing !== null) {
          await removeSafeManagedFile(
            paths.home,
            paths.plistPath,
            ownerUid,
            existing.identity,
            options.removalHook,
            transaction,
          );
        }
        if (legacy !== null) await removeLegacyPlist(legacy, transaction);
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
      await finishLegacyLabelMigration();
      const service = await describe();
      const existing = await readSafeManagedFile(paths.home, paths.plistPath, ownerUid);
      const state = service.loaded ? 'loaded' : existing === null ? 'absent' : 'installed-not-loaded';
      // `loaded` only says launchd knows the job. Reporting whether a process is actually
      // alive is what separates "the daemon is down" from "the request itself failed", and
      // without it every failed command looks like a dead daemon.
      return { ...lifecycleResult('status', state, paths), runState: service.runState };
    },
  };
}

/**
 * Every filename an interrupted old-label operation could have left behind. The list is exact
 * rather than a prefix over the whole label, so the derived label -- which begins with the legacy
 * one -- can never be swept by the code that retires it.
 */
const legacyLabelArtifactPrefixes = [
  `${legacyLaunchdLabel}.plist.tmp-`,
  `${legacyLaunchdLabel}.plist.replaced-`,
  `${legacyLaunchdLabel}.plist.removed-`,
  `.${legacyLaunchdLabel}.transaction`,
  `.${legacyLaunchdLabel}.operation-lock`,
];

async function legacyLabelArtifactNames(agentsDirectory: string): Promise<string[]> {
  let names: string[];
  try { names = await readdir(agentsDirectory); }
  catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw pathError('Could not read the launchd agents directory', error);
  }
  return names
    .filter((name) => legacyLabelArtifactPrefixes.some((prefix) => name.startsWith(prefix)))
    .sort();
}

/**
 * This HOME's own legacy definition, or null. `readSafeManagedFile` checks containment,
 * ownership, mode and link count but never authorship, so the plist has to say for itself which
 * HOME it belongs to: a definition naming another HOME is another HOME's, wherever it is sitting,
 * and is neither adopted nor touched.
 */
async function readAdoptableLegacyPlist(paths: LaunchdPaths, uid: number): Promise<FileSnapshot | null> {
  let snapshot: FileSnapshot | null;
  try { snapshot = await readSafeManagedFile(paths.home, paths.legacyPlistPath, uid); }
  catch (error) {
    // A legacy plist this process cannot vouch for is left exactly where it is; the derived
    // label's own install is unaffected by it and reports any real problem on its own path.
    if (error instanceof LaunchdLifecycleError) return null;
    throw error;
  }
  if (snapshot === null) return null;
  return legacyPlistDeclaresHome(snapshot.content, paths) ? snapshot : null;
}

function legacyPlistDeclaresHome(content: string, paths: LaunchdPaths): boolean {
  if (plistStringValue(content, 'Label') !== legacyLaunchdLabel) return false;
  const workingDirectory = plistStringValue(content, 'WorkingDirectory');
  if (workingDirectory !== null) return workingDirectory === paths.home;
  return plistStringValue(content, 'StandardOutPath') === paths.stdoutPath;
}

function plistStringValue(content: string, key: 'Label' | 'WorkingDirectory' | 'StandardOutPath'): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(content);
  return match === null ? null : unescapeXml(match[1] as string);
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
  paths: LaunchdPaths,
  uid: number,
  inspector: LaunchdProcessInspector,
  transaction: LaunchdTransaction,
): Promise<void> {
  const names = await legacyLabelArtifactNames(paths.agentsDirectory);
  if (names.length === 0) return;
  const parent = await assertSafeDirectory(paths.agentsDirectory, uid, true);
  await assertLegacyLockAbandoned(paths, uid, inspector);
  for (const name of names) {
    const path = join(paths.agentsDirectory, name);
    assertContained(paths.agentsDirectory, path);
    await transaction.assertOwned();
    const identity = await readOwnedIdentity(path, uid, [1, 2]).catch(() => null);
    if (identity === null) continue;
    await removeExactFile(path, identity, uid, [1, 2]);
  }
  await assertDirectoryIdentity(paths.agentsDirectory, parent, uid, true);
}

/**
 * An old binary still using the constant label cannot know about the derived one, so its lock is
 * the only signal that it is mid-operation. Refuse rather than race it: sweeping a live owner's
 * lock would remove the only mutual exclusion the two processes still share.
 */
async function assertLegacyLockAbandoned(
  paths: LaunchdPaths,
  uid: number,
  inspector: LaunchdProcessInspector,
): Promise<void> {
  const lockPath = join(paths.agentsDirectory, `.${legacyLaunchdLabel}.operation-lock`);
  let snapshot: { content: string; identity: FileIdentity } | null;
  try { snapshot = await readOwnedFile(lockPath, uid, [1, 2]); }
  catch { return; }
  if (snapshot === null) return;
  let owner: LockOwnerMetadata;
  try { owner = parseOwnerMetadata(snapshot.content); }
  catch { return; }
  const observed = await inspector.inspect(owner.pid);
  if (observed.state === 'live' && observed.startIdentity === owner.startIdentity) {
    throw new LaunchdLifecycleError(
      'LAUNCHD_OPERATION_BUSY',
      'A launchd lifecycle operation under the previous label is still in progress.',
      { operation: 'legacy-migration', owner: 'live' },
    );
  }
}

async function ensureInstallDirectories(paths: LaunchdPaths, uid: number): Promise<void> {
  await ensureLaunchAgentsDirectory(paths, uid);
  const applicationSupport = dirname(paths.dataRoot);
  await ensureSafeChildDirectory(paths.libraryDirectory, applicationSupport, uid, false);
  await ensureSafeChildDirectory(applicationSupport, paths.dataRoot, uid, true);
  const logs = join(paths.libraryDirectory, 'Logs');
  await ensureSafeChildDirectory(paths.libraryDirectory, logs, uid, false);
  await ensureSafeChildDirectory(logs, paths.logRoot, uid, true);
}

async function ensureLaunchAgentsDirectory(paths: LaunchdPaths, uid: number): Promise<void> {
  await assertSafeDirectory(paths.home, uid);
  await ensureSafeChildDirectory(paths.home, paths.libraryDirectory, uid, false);
  await ensureSafeChildDirectory(paths.libraryDirectory, paths.agentsDirectory, uid, true);
}

async function withLaunchdOperationLock<T>(
  paths: LaunchdPaths,
  uid: number,
  inspector: LaunchdProcessInspector,
  pollAttempts: number,
  hook: LaunchdLifecycleOptions['transactionHook'],
  metadataReadHook: LaunchdLifecycleOptions['metadataReadHook'],
  operation: (transaction: LaunchdTransaction) => Promise<T>,
): Promise<T> {
  const lockPath = join(paths.agentsDirectory, `.${paths.label}.operation-lock`);
  const journalPath = join(paths.agentsDirectory, `.${paths.label}.transaction`);
  const parent = await assertSafeDirectory(paths.agentsDirectory, uid, true);
  const currentOwner = await inspector.current();
  const baseOwner: LockOwnerMetadata = {
    version: 1,
    ...currentOwner,
    transactionId: crypto.randomUUID(),
    predecessorTransactionIds: [],
  };
  validateOwnerMetadata(baseOwner);
  let owner = baseOwner;
  const transaction: LaunchdTransaction = {
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
      await syncDirectory(paths.agentsDirectory);
      await runTransactionHook(transaction, 'lock-linked');
      await removeExactFile(candidate, baseCandidateIdentity, uid, [2]);
      const lock = await readOwnedFile(lockPath, uid, [1], maxTransactionMetadataBytes, metadataReadHook);
      if (lock === null || lock.content !== baseContent) throw transactionPathError('lock publication changed');
      owner = baseOwner;
      lockIdentity = lock.identity;
      await assertDirectoryIdentity(paths.agentsDirectory, parent, uid, true);
      break;
    } catch (error) {
      if (isTransactionInterruption(error)) throw error;
      await removeExactFileIfPresent(candidate, baseCandidateIdentity, uid, [1, 2]);
      if (!isNodeError(error, 'EEXIST')) throw error;
      await assertDirectoryIdentity(paths.agentsDirectory, parent, uid, true);
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
        await syncDirectory(paths.agentsDirectory);
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
        await syncDirectory(paths.agentsDirectory);
        owner = successorOwner;
        lockIdentity = successorIdentity;
        lockClaimPath = claimPath;
        await runTransactionHook(transaction, 'stale-lock-moved');
        await assertExactLockOwner(lockPath, lockIdentity, successorContent, uid, metadataReadHook, lockClaimPath);
        await assertDirectoryIdentity(paths.agentsDirectory, parent, uid, true);
        break;
      }
      busyAttempts += 1;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  if (lockIdentity === undefined) {
    throw new LaunchdLifecycleError(
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
      await assertDirectoryIdentity(paths.agentsDirectory, parent, uid, true);
      await transaction.assertOwned();
      if (lockClaimPath !== undefined) {
        await removeExactFile(lockClaimPath, lockIdentity as FileIdentity, uid, [2]);
        lockClaimPath = undefined;
        await transaction.assertOwned();
      }
      await removeExactFile(lockPath, lockIdentity as FileIdentity, uid, [1]);
      await assertDirectoryIdentity(paths.agentsDirectory, parent, uid, true);
    }
  }
}

async function inheritedPredecessorTransactionIds(
  transaction: LaunchdTransaction,
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
  transaction: LaunchdTransaction,
  lockPath: string,
  claimPath: string,
  predecessorOwner: LockOwnerMetadata,
  predecessorIdentity: FileIdentity,
  predecessorContent: string,
  inheritedPredecessors: readonly string[],
  inspector: LaunchdProcessInspector,
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
    await syncDirectory(transaction.paths.agentsDirectory);
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
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'Managed launchd directories must be owner-only');
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
interface LaunchdTransaction {
  id: string;
  paths: LaunchdPaths;
  uid: number;
  journalPath: string;
  hook: LaunchdLifecycleOptions['transactionHook'];
  metadataReadHook: LaunchdLifecycleOptions['metadataReadHook'];
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

async function readSafeManagedFile(root: string, path: string, uid: number): Promise<FileSnapshot | null> {
  assertContained(root, path);
  const directory = resolve(path, '..');
  const chain = await assertSafeExistingDirectoryChain(root, directory, uid);
  if (chain === null) return null;
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw pathError('Unsafe launchd plist target', error); }
  try {
    const stat = await handle.stat();
    const identity = assertSafeFileStat(stat, uid);
    if (stat.size > maxManagedPlistBytes) throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist is unexpectedly large');
    const content = await readBoundedHandle(handle, maxManagedPlistBytes, () => {
      throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist is unexpectedly large');
    });
    await assertDirectoryIdentity(directory, chain, uid);
    return { content, identity };
  } finally {
    await handle.close();
  }
}

async function publishSafeManagedFile(
  root: string,
  path: string,
  content: string,
  uid: number,
  hook?: LaunchdLifecycleOptions['publicationHook'],
  transaction?: LaunchdTransaction,
): Promise<FileIdentity> {
  assertContained(root, path);
  const directory = resolve(path, '..');
  const parent = await assertSafeDirectory(directory, uid, true);
  const existing = await readSafeManagedFile(root, path, uid);
  const suffix = transaction?.id ?? crypto.randomUUID();
  const temporary = `${path}.tmp-${suffix}`;
  const quarantine = `${path}.replaced-${suffix}`;
  const expected = expectedContentIdentity(content);
  let handle: FileHandle | null = null;
  let ownedTemporary: FileIdentity | undefined;
  let quarantined: FileIdentity | undefined;
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
    if ((written.mode & 0o777) !== 0o600) throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'Unsafe launchd temporary mode');
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
    await assertDirectoryIdentity(directory, parent, uid, true);
    let current = await readSafeManagedFile(root, path, uid);
    if (!sameOptionalIdentity(existing?.identity, current?.identity)) {
      throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed during publication');
    }
    if (existing !== null) {
      await hook?.('before-replace-move', path);
      await assertDirectoryIdentity(directory, parent, uid, true);
      current = await readSafeManagedFile(root, path, uid);
      if (current === null || !sameFileIdentity(existing.identity, current.identity)) {
        throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed before replacement');
      }
      await transaction?.assertOwned();
      const exactReplacementSource = await readSafeManagedFile(root, path, uid);
      if (exactReplacementSource === null || !sameFileIdentity(existing.identity, exactReplacementSource.identity)) {
        throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed at replacement move');
      }
      await rename(path, quarantine);
      await assertDirectoryIdentity(directory, parent, uid, true);
      const moved = await readSafeManagedFile(root, quarantine, uid);
      if (moved === null || !sameFileIdentity(existing.identity, moved.identity)) {
        if (moved !== null) await restoreQuarantinedFile(root, path, quarantine, uid, parent, moved.identity);
        throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed during replacement');
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
    await assertDirectoryIdentity(directory, parent, uid, true);
    current = await readSafeManagedFile(root, path, uid);
    if (current !== null) {
      throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist target appeared before publication');
    }
    await transaction?.assertOwned();
    const exactTemporary = await readOwnedFile(
      temporary,
      uid,
      [1],
      maxManagedPlistBytes,
      transaction?.metadataReadHook,
    );
    if (exactTemporary === null || !sameFileIdentity(temporaryStat, exactTemporary.identity)
      || !sameExpectedContent(expected, exactTemporary.content)) {
      ownedTemporary = undefined;
      throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd temporary changed before publication');
    }
    try { await link(temporary, path); }
    catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist target won concurrent publication');
      }
      throw error;
    }
    await assertDirectoryIdentity(directory, parent, uid, true);
    const linkedTemporary = await readOwnedFile(
      temporary,
      uid,
      [2],
      maxManagedPlistBytes,
      transaction?.metadataReadHook,
    );
    const linkedTarget = await readOwnedFile(
      path,
      uid,
      [2],
      maxManagedPlistBytes,
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
      throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd linked temporary changed identity');
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
    const published = await readSafeManagedFile(root, path, uid);
    if (published === null) throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist publication disappeared');
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
      await removeOwnedSibling(root, quarantine, uid, parent, quarantined);
      quarantined = undefined;
    }
    return published.identity;
  } catch (error) {
    if (isTransactionInterruption(error)) throw error;
    await handle?.close().catch(() => {});
    let parentUnchanged = false;
    try { await assertDirectoryIdentity(directory, parent, uid, true); parentUnchanged = true; }
    catch { /* Never unlink through a replaced parent path. */ }
    if (parentUnchanged) {
      if (quarantined !== undefined) {
        const restored = await restoreQuarantinedFile(
          root,
          path,
          quarantine,
          uid,
          parent,
          quarantined,
        ).catch(() => false);
        if (!restored) {
          await removeOwnedSibling(root, quarantine, uid, parent, quarantined).catch(() => {});
        }
        quarantined = undefined;
      }
      if (ownedTemporary !== undefined) {
        try { await removeExactFile(temporary, ownedTemporary, uid, [1, 2]); }
        catch (cleanupError) {
          if (!isNodeError(cleanupError, 'ENOENT')) {
            throw new LaunchdLifecycleError(
              'UNSAFE_LAUNCHD_PATH',
              'Could not clean up the launchd temporary file.',
              {},
              { cause: cleanupError },
            );
          }
        }
      }
    }
    if (error instanceof LaunchdLifecycleError) throw error;
    throw pathError('Could not publish launchd plist safely', error);
  }
}

async function removeSafeManagedFile(
  root: string,
  path: string,
  uid: number,
  expected?: FileIdentity,
  hook?: LaunchdLifecycleOptions['removalHook'],
  transaction?: LaunchdTransaction,
): Promise<void> {
  const snapshot = await readSafeManagedFile(root, path, uid);
  if (snapshot === null) return;
  if (expected !== undefined) assertSameFileIdentity(expected, snapshot.identity);
  const directory = resolve(path, '..');
  const parent = await assertSafeDirectory(directory, uid, true);
  await hook?.('before-remove', path);
  let before = await readSafeManagedFile(root, path, uid);
  if (before === null || !sameFileIdentity(snapshot.identity, before.identity)) {
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed before removal');
  }
  await hook?.('before-quarantine', path);
  await assertDirectoryIdentity(directory, parent, uid, true);
  before = await readSafeManagedFile(root, path, uid);
  if (before === null || !sameFileIdentity(snapshot.identity, before.identity)) {
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed at removal boundary');
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
  const exactRemovalSource = await readSafeManagedFile(root, path, uid);
  if (exactRemovalSource === null || !sameFileIdentity(snapshot.identity, exactRemovalSource.identity)) {
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed at removal move');
  }
  await rename(path, quarantine);
  await assertDirectoryIdentity(directory, parent, uid, true);
  const moved = await readSafeManagedFile(root, quarantine, uid);
  if (moved === null || !sameFileIdentity(snapshot.identity, moved.identity)) {
    if (moved !== null) await restoreQuarantinedFile(root, path, quarantine, uid, parent, moved.identity);
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist changed during removal');
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
  await removeOwnedSibling(root, quarantine, uid, parent, moved.identity);
  if (transaction !== undefined) {
    await writeTransactionJournal(transaction, {
      version: 1, transactionId: transaction.id, operation: 'remove', phase: 'removal-cleaned',
      temporary: null, quarantine: quarantine.split(sep).at(-1) as string,
      original: moved.identity, replacement: null, expected: null,
    });
    await runTransactionHook(transaction, 'removal-cleaned');
  }
}

async function restorePreviousDefinition(
  paths: LaunchdPaths,
  uid: number,
  previous: FileSnapshot | null,
  published: FileIdentity | undefined,
  transaction?: LaunchdTransaction,
): Promise<void> {
  const current = await readSafeManagedFile(paths.home, paths.plistPath, uid);
  if (published === undefined) {
    if (!sameOptionalIdentity(previous?.identity, current?.identity)) throw rollbackConflict();
    return;
  }
  if (current === null || !sameFileIdentity(published, current.identity)) throw rollbackConflict();
  if (previous === null) await removeSafeManagedFile(paths.home, paths.plistPath, uid, published, undefined, transaction);
  else await publishSafeManagedFile(paths.home, paths.plistPath, previous.content, uid, undefined, transaction);
}

async function restoreQuarantinedFile(
  root: string,
  path: string,
  quarantine: string,
  uid: number,
  parent: DirectoryIdentity,
  expected: FileIdentity,
): Promise<boolean> {
  await assertDirectoryIdentity(resolve(path, '..'), parent, uid, true);
  const moved = await readSafeManagedFile(root, quarantine, uid);
  if (moved === null || !sameFileIdentity(expected, moved.identity)) return false;
  try { await link(quarantine, path); }
  catch (error) { if (isNodeError(error, 'EEXIST')) return false; throw error; }
  await rm(quarantine);
  await assertDirectoryIdentity(resolve(path, '..'), parent, uid, true);
  const restored = await readSafeManagedFile(root, path, uid);
  return restored !== null && sameFileIdentity(expected, restored.identity);
}

async function removeOwnedSibling(
  root: string,
  path: string,
  uid: number,
  parent: DirectoryIdentity,
  expected: FileIdentity,
): Promise<void> {
  await assertDirectoryIdentity(resolve(path, '..'), parent, uid, true);
  const current = await readSafeManagedFile(root, path, uid);
  if (current === null || !sameFileIdentity(expected, current.identity)) {
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd owned temporary identity changed');
  }
  await rm(path);
  await assertDirectoryIdentity(resolve(path, '..'), parent, uid, true);
}

function rollbackConflict(): LaunchdLifecycleError {
  return new LaunchdLifecycleError(
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

async function writeTransactionJournal(transaction: LaunchdTransaction, journal: TransactionJournal): Promise<void> {
  journal = { ...journal, failure: transaction.failureContext ?? journal.failure ?? null };
  validateJournal(transaction, journal);
  await writeJournalSnapshot(transaction, journal);
}

async function writeRecoveredTransactionJournal(
  transaction: LaunchdTransaction,
  journal: TransactionJournal,
): Promise<void> {
  journal = { ...journal, failure: transaction.failureContext ?? journal.failure ?? null };
  validateJournal({ ...transaction, id: journal.transactionId }, journal);
  await writeJournalSnapshot(transaction, journal);
}

async function writeJournalSnapshot(transaction: LaunchdTransaction, journal: TransactionJournal): Promise<void> {
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
  await syncDirectory(transaction.paths.agentsDirectory);
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
  transaction: LaunchdTransaction,
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
  transaction: LaunchdTransaction,
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
    await syncDirectory(transaction.paths.agentsDirectory);
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
  await syncDirectory(transaction.paths.agentsDirectory);
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
  transaction: LaunchdTransaction,
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
  transaction: LaunchdTransaction,
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
  transaction: LaunchdTransaction,
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

function journalTemporaryPath(transaction: LaunchdTransaction, transactionId: string): string {
  if (!validTransactionId(transactionId)) throw transactionPathError('journal temporary transaction ID is invalid');
  const path = `${transaction.journalPath}.tmp-${transactionId}`;
  assertContained(transaction.paths.agentsDirectory, path);
  return path;
}

async function recoverInterruptedTransaction(
  transaction: LaunchdTransaction,
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
  const target = transaction.paths.plistPath;
  const temporary = journal.temporary === null ? null : join(transaction.paths.agentsDirectory, journal.temporary);
  const quarantine = journal.quarantine === null ? null : join(transaction.paths.agentsDirectory, journal.quarantine);
  let targetIdentity = await readOwnedIdentity(target, transaction.uid, [1, 2]);
  let temporaryIdentity = temporary === null ? null : await readOwnedIdentity(temporary, transaction.uid, [1, 2]);
  const quarantineIdentity = quarantine === null ? null : await readOwnedIdentity(quarantine, transaction.uid, [1, 2]);

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
        maxManagedPlistBytes,
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
        if (exactQuarantine === null || !sameFileIdentity(quarantineIdentity, exactQuarantine)
          || !sameInode(journal.original, exactQuarantine)) {
          throw transactionPathError('restore quarantine changed at link boundary');
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
}

async function removeJournalIfOwned(transaction: LaunchdTransaction): Promise<void> {
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

function validateJournal(transaction: LaunchdTransaction, journal: TransactionJournal): void {
  if (journal.version !== 1 || journal.transactionId !== transaction.id || !['publish', 'remove'].includes(journal.operation)
    || !['preparing', 'prepared', 'old-quarantined', 'new-linked', 'temporary-unlinked', 'removal-quarantined', 'removal-cleaned'].includes(journal.phase)) {
    throw transactionPathError('transaction journal schema is invalid');
  }
  const phaseAllowed = journal.operation === 'publish'
    ? ['preparing', 'prepared', 'old-quarantined', 'new-linked', 'temporary-unlinked'].includes(journal.phase)
    : ['prepared', 'removal-quarantined', 'removal-cleaned'].includes(journal.phase);
  if (!phaseAllowed) throw transactionPathError('transaction journal phase is invalid');
  const targetName = `${transaction.paths.label}.plist`;
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
    && (candidate.byteLength as number) <= maxManagedPlistBytes
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

async function runTransactionHook(transaction: LaunchdTransaction, phase: LaunchdTransactionPhase): Promise<void> {
  if (await transaction.hook?.(phase) === 'interrupt') {
    throw new LaunchdLifecycleError(
      'LAUNCHD_TRANSACTION_INTERRUPTED',
      'Injected launchd transaction interruption.',
      { phase },
    );
  }
}

function isTransactionInterruption(error: unknown): boolean {
  return error instanceof LaunchdLifecycleError && error.code === 'LAUNCHD_TRANSACTION_INTERRUPTED';
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
  readHook?: LaunchdLifecycleOptions['metadataReadHook'],
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
  readHook?: LaunchdLifecycleOptions['metadataReadHook'],
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

function oversizedTransactionMetadata(): LaunchdLifecycleError {
  return new LaunchdLifecycleError(
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

function transactionPathError(message: string, cause?: unknown): LaunchdLifecycleError {
  return new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', message, {}, cause === undefined ? undefined : { cause });
}

async function assertSafeExistingDirectoryChain(
  root: string,
  directory: string,
  uid: number,
): Promise<DirectoryIdentity | null> {
  assertContained(root, directory);
  try { await assertSafeDirectory(root, uid); }
  catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw error; }
  const child = relative(root, directory);
  let current = resolve(root);
  if (child !== '') {
    for (const part of child.split(sep)) {
      current = join(current, part);
      try { await assertSafeDirectory(current, uid); }
      catch (error) { if (isNodeError(error, 'ENOENT')) return null; throw error; }
    }
  }
  return await assertSafeDirectory(directory, uid, directory.endsWith(`${sep}LaunchAgents`));
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
  ) throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'Unsafe launchd directory');
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
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd directory identity changed');
  }
}

function assertSafeFileStat(
  stat: Awaited<ReturnType<FileHandle['stat']>> | Awaited<ReturnType<typeof lstat>>,
  uid: number,
): FileIdentity {
  const mode = Number(stat.mode);
  const nlink = Number(stat.nlink);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || nlink !== 1 || (mode & 0o077) !== 0) {
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'Unsafe launchd plist target');
  }
  return { dev: Number(stat.dev), ino: Number(stat.ino), uid: stat.uid, mode, nlink };
}

function assertSameFileIdentity(left: FileIdentity, right: FileIdentity): void {
  if (!sameFileIdentity(left, right)) {
    throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd plist identity changed');
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && right.nlink === 1;
}

function sameOptionalIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && right.nlink === 1;
}

let currentProcessInspection: Promise<LaunchdProcessInspection> | undefined;

const defaultProcessInspector: LaunchdProcessInspector = {
  current: async () => {
    currentProcessInspection ??= inspectProcessWithPs(process.pid);
    const observed = await currentProcessInspection;
    if (observed.state !== 'live' || observed.startIdentity === null) {
      throw new LaunchdLifecycleError('LAUNCHD_OPERATION_BUSY', 'Could not establish the lifecycle owner identity.');
    }
    return { pid: process.pid, startIdentity: observed.startIdentity };
  },
  inspect: inspectProcessWithPs,
};

async function inspectProcessWithPs(pid: number): Promise<LaunchdProcessInspection> {
  return await new Promise((resolvePromise) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', maxBuffer: 1024, shell: false,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    }, (error: ExecException | null, stdout: string) => {
      const startIdentity = sanitizeCommandOutput(stdout).trim();
      if (error === null && startIdentity.length > 0) resolvePromise({ state: 'live', startIdentity });
      else if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
        resolvePromise({ state: 'dead', startIdentity: null });
      } else resolvePromise({ state: 'unknown', startIdentity: null });
    });
  });
}

async function runLaunchctl(argv: readonly string[]): Promise<LaunchdCommandResult> {
  const executable = argv[0];
  if (executable !== launchctlPath) throw configurationError('Invalid launchctl argv');
  return await new Promise((resolvePromise) => {
    execFile(executable, argv.slice(1), {
      encoding: 'utf8',
      maxBuffer: maxCommandBufferBytes,
      shell: false,
      env: { PATH: '/usr/bin:/bin', HOME: homedir(), LC_ALL: 'C', LANG: 'C' },
    }, (error: ExecException | null, stdout: string, stderr: string) => {
      const exitCode = error === null ? 0
        : typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : null;
      resolvePromise({
        outcome: exitCode === 0 ? 'success' : exitCode === 113 ? 'not-found' : 'failure',
        exitCode,
        stdout: sanitizeCommandOutput(stdout),
        stderr: sanitizeCommandOutput(stderr),
      });
    });
  });
}

function lifecycleResult<Action extends 'install' | 'uninstall' | 'status', State extends string>(
  action: Action,
  state: State,
  paths: LaunchdPaths,
): LaunchdLifecycleResult<State> & { action: Action } {
  // The label and the plist path are read off the same resolved HOME the state was read for, so
  // the answer cannot name one agent and report another's state.
  return { action, state, label: paths.label, plistPath: paths.plistPath };
}

/** Reads the `state = <word>` line that `launchctl print` puts near the top of its report. */
function runState(stdout: string): string | null {
  return /^\s*state = (.+?)\s*$/m.exec(stdout)?.[1] ?? null;
}

function commandError(operation: string, result: LaunchdCommandResult): LaunchdLifecycleError {
  return new LaunchdLifecycleError(
    'LAUNCHD_COMMAND_FAILED',
    `launchctl ${operation} failed.`,
    commandContext(operation, result),
  );
}

function commandContext(operation: string, result: LaunchdCommandResult): Record<string, string | number | null> {
  return {
    operation,
    exitCode: result.exitCode,
    stdout: sanitizeCommandOutput(result.stdout),
    stderr: sanitizeCommandOutput(result.stderr),
  };
}

function sanitizeCommandOutput(value: string): string {
  return Buffer.from(value)
    .subarray(0, maxCommandOutputBytes)
    .toString('utf8')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\uFFFD');
}

function isAbsentResult(result: LaunchdCommandResult): boolean {
  return result.outcome === 'not-found';
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function assertXmlValue(value: string, label: string): void {
  if (value.length === 0 || value.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw configurationError(`${label} is invalid`);
  }
}

function assertAbsolute(path: string, label: string): void {
  assertXmlValue(path, label);
  if (!isAbsolute(path)) throw configurationError(`${label} must be absolute`);
}

function assertContained(root: string, target: string): void {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const child = relative(absoluteRoot, absoluteTarget);
  if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) return;
  throw new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', 'launchd path escapes the configured home');
}

function configurationError(message: string): LaunchdLifecycleError {
  return new LaunchdLifecycleError('INVALID_LAUNCHD_CONFIGURATION', message);
}

function pathError(message: string, cause: unknown): LaunchdLifecycleError {
  return new LaunchdLifecycleError('UNSAFE_LAUNCHD_PATH', message, {}, { cause });
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

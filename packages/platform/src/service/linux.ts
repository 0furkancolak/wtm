/**
 * systemd, stated as the same descriptor launchd is.
 *
 * This is the half of the increment that no test here can prove. Everything below is exercised
 * against an injected fake `systemctl` exactly the way the launchd backend is exercised against a
 * fake `launchctl`, which is evidence about the argument vectors and the state machine and is no
 * evidence at all that systemd accepts this unit or that `systemctl --user` bootstraps it. C2
 * verifies that on a kernel; nothing here should be read as having done so.
 *
 * Where a decision had a macOS precedent it was copied rather than improved on, because the
 * increment's premise is that the two backends differ only where the platforms do.
 */
import { execFile, type ExecException } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { linuxPlatformPaths } from '../paths';
import { createLinuxProcessPlatform } from '../process';
import type { ServiceDefinitionOptions } from '../ports';
import { ServiceLifecycleError, configurationError } from './errors';
import { assertAbsolutePath, assertPrintableValue, sanitizeCommandOutput } from './text';
import { homeDigest } from './darwin';
import type {
  ObservedServiceState,
  ServiceBackend,
  ServiceCommandResult,
  ServiceCommandSet,
  ServiceDirectoryInput,
  ServiceDirectoryPlan,
  ManagedDirectory,
  ServiceProcessInspection,
  ServiceProcessInspector,
} from './types';

export const systemctlPath = '/usr/bin/systemctl';
const maxCommandBufferBytes = 8 * 1024 * 1024;
const defaultPathEnvironment = '/usr/local/bin:/usr/bin:/bin';
const unitPrefix = 'wtm-daemon-';
const unitSuffix = '.service';

/**
 * The unit this HOME's daemon is published under, hashed over HOME exactly the way the launchd
 * label is.
 *
 * Linux does not have the constraint that forced the derivation on macOS -- a launchd service name
 * is `gui/<uid>/<label>`, so one uid with two HOMEs had one service slot, while systemd's user
 * manager is already per-session. `HOME` can still be overridden here, and a rule that holds by
 * derivation on one platform and by coincidence on the other is two rules to keep true. The name
 * is uglier than `wtm-daemon.service`; `wtm daemon status` reports it exactly, which is what a
 * user needs in order to type `systemctl --user status <name>` themselves.
 */
export function systemdUnitLabelFor(home: string): string {
  assertAbsolutePath(home, 'systemd home');
  return `${unitPrefix}${homeDigest(home)}`;
}

/**
 * The unit name is read out of the unit path rather than fixed, for the same reason the launchd
 * label is read out of the plist path: the commands cannot address one unit while enabling
 * another.
 */
function unitFromDefinitionPath(definitionPath: string): string {
  const name = resolve(definitionPath).split(sep).at(-1) as string;
  const stem = name.endsWith(unitSuffix) ? name.slice(0, -unitSuffix.length) : '';
  if (stem.length === 0 || !/^[A-Za-z0-9._@-]+$/.test(stem)) {
    throw configurationError('systemd unit path must name a systemd unit');
  }
  return name;
}

export function systemctlCommands(options: { uid: number; definitionPath: string }): ServiceCommandSet {
  nonNegativeInteger(options.uid, 'systemd uid');
  assertAbsolutePath(options.definitionPath, 'systemd unit path');
  const unit = unitFromDefinitionPath(options.definitionPath);
  return {
    // Three properties, in a fixed order, because `show` prints exactly what it is asked for and
    // parsing a human `status` report is the mistake the launchd backend already refuses to make.
    print: [systemctlPath, '--user', 'show', '--property=LoadState', '--property=ActiveState', '--property=SubState', unit],
    // The user manager itself. `show` against the manager fails when there is no session bus to
    // talk to -- inside a container, over `su`, on a host with lingering disabled -- which is the
    // same distinction `launchctl print gui/<uid>` draws between "no service" and "no session".
    printDomain: [systemctlPath, '--user', 'show', '--property=Version'],
    // systemd caches unit files; a definition published without this is invisible until something
    // else reloads. launchd has no equivalent because it reads the plist at bootstrap time.
    reload: [systemctlPath, '--user', 'daemon-reload'],
    enable: [systemctlPath, '--user', 'enable', unit],
    // Without this an uninstall leaves the `default.target.wants` symlink `enable` created,
    // pointing at a unit file that is no longer there.
    disable: [systemctlPath, '--user', 'disable', unit],
    bootstrap: [systemctlPath, '--user', 'start', unit],
    bootout: [systemctlPath, '--user', 'stop', unit],
    kickstart: [systemctlPath, '--user', 'restart', unit],
  };
}

function showProperty(stdout: string, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(stdout);
  return match === null ? null : (match[1] as string).trim();
}

/**
 * What a successful `show` says about the manager's view of the unit.
 *
 * `LoadState=not-found` is systemd's way of saying it does not know this unit, and it says it
 * through a command that exits 0 -- which is the whole reason this hook exists, because launchd
 * says the same thing with exit 113 and the runner can classify that on its own.
 *
 * The active states are the ones where systemd is running the job or is about to. `inactive` and
 * `failed` mean it is not, which is the same condition a booted-out launchd job is in: the
 * definition is still on disk, so the lifecycle reports `installed-not-loaded` and the user sees
 * `failed` in `runState` rather than being told nothing is installed.
 */
function interpretSystemdStatus(result: ServiceCommandResult): ObservedServiceState {
  const loadState = showProperty(result.stdout, 'LoadState');
  if (loadState === null || loadState === 'not-found' || loadState === 'masked') return 'absent';
  const activeState = showProperty(result.stdout, 'ActiveState');
  return activeState !== null && ['active', 'activating', 'reloading', 'deactivating'].includes(activeState)
    ? 'loaded'
    : 'absent';
}

/**
 * systemd's own word for what the job is doing. `SubState` is the finer of the two and is the one
 * that reads like launchd's `running`; `ActiveState` answers when a manager too old to report a
 * substate is asked.
 */
function systemdRunState(result: ServiceCommandResult): string | null {
  const subState = showProperty(result.stdout, 'SubState');
  if (subState !== null && subState.length > 0) return subState;
  const activeState = showProperty(result.stdout, 'ActiveState');
  return activeState !== null && activeState.length > 0 ? activeState : null;
}

export interface SystemdUnitOptions {
  label: string;
  programArguments: readonly string[];
  home: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  pathEnvironment: string;
}

/**
 * The unit body, rendered from values this process chose and values it did not.
 *
 * Two escapes matter and neither is optional. `%` introduces a specifier that systemd expands
 * everywhere in a unit file, so a HOME containing one would silently become a different path.
 * `$` introduces variable expansion inside `ExecStart`, and a `"` or a `\` inside a quoted
 * argument would end it early -- an argument vector this process assembled is still not a value
 * a unit file may contain verbatim.
 *
 * A newline is rejected outright rather than escaped. In a plist it is ordinary text; here it
 * would start a new directive, and there is no value WTM passes that legitimately contains one.
 */
export function renderSystemdUnit(options: SystemdUnitOptions): string {
  assertUnitValue(options.label, 'systemd unit label');
  if (options.programArguments.length === 0) throw configurationError('systemd argv must not be empty');
  assertAbsoluteUnitPath(options.programArguments[0] as string, 'systemd executable');
  for (const argument of options.programArguments) assertUnitValue(argument, 'systemd argument');
  for (const [path, name] of [
    [options.home, 'systemd home'],
    [options.workingDirectory, 'systemd working directory'],
    [options.stdoutPath, 'systemd stdout path'],
    [options.stderrPath, 'systemd stderr path'],
  ] as const) assertAbsoluteUnitPath(path, name);
  assertUnitValue(options.pathEnvironment, 'systemd PATH');
  // Already specifier-escaped, argument by argument: escaping the assembled line again would
  // turn one `%` into four.
  const execStart = options.programArguments.map((argument) => `"${quoteUnitArgument(argument)}"`).join(' ');
  // Type=exec rather than simple: `systemctl start` then fails when the executable cannot be run
  // at all, instead of reporting success and leaving the failure to be discovered by the client
  // that cannot reach the socket. Both it and `append:` need systemd 240 (2018) or newer.
  //
  // Restart=on-failure is KeepAlive{SuccessfulExit:false}: a daemon that exited cleanly was asked
  // to. TimeoutStopSec is ExitTimeOut. UMask=0077 is Umask 63 written the way systemd writes it.
  // launchd's ProcessType has no systemd counterpart -- systemd does not throttle a user unit's
  // CPU or I/O by default, which is the state Adaptive exists to ask launchd for.
  return `[Unit]
Description=WTM daemon for ${unitText(options.home)}
Documentation=https://github.com/0furkancolak/wtm

[Service]
Type=exec
ExecStart=${execStart}
WorkingDirectory=${unitText(options.workingDirectory)}
Environment="HOME=${quoteUnitArgument(options.home)}" "PATH=${quoteUnitArgument(options.pathEnvironment)}"
StandardOutput=append:${unitText(options.stdoutPath)}
StandardError=append:${unitText(options.stderrPath)}
Restart=on-failure
RestartSec=1
TimeoutStopSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
}

/** Specifier expansion applies to the whole file, so every rendered value is escaped for it. */
function unitText(value: string): string {
  return value.replaceAll('%', '%%');
}

function quoteUnitArgument(value: string): string {
  return unitText(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '$$$$');
}

function assertUnitValue(value: string, label: string): void {
  assertPrintableValue(value, label);
  if (value.includes('\n') || value.includes('\r')) throw configurationError(`${label} is invalid`);
}

function assertAbsoluteUnitPath(path: string, label: string): void {
  assertUnitValue(path, label);
  if (!isAbsolute(path)) throw configurationError(`${label} must be absolute`);
}

/**
 * The chains this backend creates, each walked from the outermost directory it is allowed to
 * assume rather than from `home`.
 *
 * That distinction is the whole reason this is a descriptor and not a constant: an XDG variable
 * may point anywhere, so `$XDG_STATE_HOME=/var/lib/me` puts the database outside `home` entirely
 * and a chain rooted at `home` would either escape it or refuse it. Where the variables are unset
 * -- the overwhelmingly common case -- every base is inside `home` and the walk starts there, so
 * `~/.config` and `~/.local` are checked exactly the way `~/Library` is on macOS.
 *
 * The unit directory is deliberately **not** owner-only, and macOS's `LaunchAgents` deliberately
 * still is. That asymmetry is not a relaxation of the rule; it is the rule applied to a directory
 * WTM does not own:
 *
 * - The load-bearing check is `(mode & 0o022) === 0` -- no group or other *write* -- and it is
 *   applied to every managed directory whatever this flag says. That is what stops another user
 *   planting a definition this daemon would then execute as you. 0755 satisfies it.
 * - `ownerOnly` adds `(mode & 0o077) === 0`, which only forbids group and other *read and
 *   traverse*. macOS gets that for free -- it creates `~/Library` subdirectories at 0700 -- so
 *   requiring it there costs nothing. `~/.config` is 0755 on every machine with the standard
 *   umask, and `systemctl enable` creates `~/.config/systemd/user` the same way. Requiring 0700
 *   would mean refusing to install on essentially every Linux host, or tightening a directory that
 *   belongs to systemd's own tooling and to every other user unit in it.
 * - The unit *file* is still checked for `(mode & 0o077) === 0` on both platforms, so its contents
 *   stay unreadable by other users inside a 0755 directory. Relaxing the directory does not expose
 *   the definition.
 *
 * The state and log roots keep `ownerOnly`, because those WTM does own.
 */
function linuxDirectories(input: ServiceDirectoryInput): ServiceDirectoryPlan {
  const configHome = dirname(dirname(input.serviceRoot));
  const stateHome = dirname(input.dataRoot);
  const definition = chainFrom(input.home, configHome, input.serviceRoot, false);
  return {
    root: contains(input.home, input.serviceRoot) ? input.home : configHome,
    definition,
    install: dedupe([
      ...definition,
      ...chainFrom(input.home, stateHome, input.dataRoot, true),
      ...chainFrom(input.home, stateHome, input.logRoot, true),
    ]),
  };
}

/**
 * Every directory between the chain's root and its leaf. The intermediates are never owner-only --
 * `~/.config` belongs to every application the user has, exactly as `~/Library` does -- and the
 * leaf is owner-only only where WTM is the directory's owner, which the caller decides.
 */
function chainFrom(
  home: string,
  base: string,
  target: string,
  ownerOnlyLeaf: boolean,
): ManagedDirectory[] {
  const root = contains(home, base) ? home : base;
  const child = relative(resolve(root), resolve(target));
  if (child === '' || child.startsWith('..') || isAbsolute(child)) {
    throw configurationError('systemd managed directory escapes its root');
  }
  const parts = child.split(sep);
  let current = resolve(root);
  return parts.map((part, index) => {
    current = join(current, part);
    return { path: current, ownerOnly: ownerOnlyLeaf && index === parts.length - 1 };
  });
}

function dedupe(directories: readonly ManagedDirectory[]): ManagedDirectory[] {
  const seen = new Set<string>();
  return directories.filter((directory) => {
    if (seen.has(directory.path)) return false;
    seen.add(directory.path);
    return true;
  });
}

function contains(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

export async function runSystemctl(argv: readonly string[]): Promise<ServiceCommandResult> {
  const executable = argv[0];
  if (executable !== systemctlPath) throw configurationError('Invalid systemctl argv');
  return await new Promise((resolvePromise) => {
    execFile(executable, argv.slice(1), {
      encoding: 'utf8',
      maxBuffer: maxCommandBufferBytes,
      shell: false,
      // No pager, and no colour: this output is parsed and is also reported back inside a JSON
      // error context, where an escape sequence would be noise at best.
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '' },
    }, (error: ExecException | null, stdout: string, stderr: string) => {
      const exitCode = error === null ? 0
        : typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : null;
      resolvePromise({
        // 5 is systemd's EXIT_NOTINSTALLED: the unit does not exist. `stop` and `disable` answer
        // with it for a unit that is already gone, which is an absence and not a failure -- the
        // same classification `launchctl`'s 113 gets, made in the same place.
        outcome: exitCode === 0 ? 'success' : exitCode === 5 ? 'not-found' : 'failure',
        exitCode,
        stdout: sanitizeCommandOutput(stdout),
        stderr: sanitizeCommandOutput(stderr),
      });
    });
  });
}

let currentProcessInspection: Promise<ServiceProcessInspection> | undefined;

/**
 * The lock owner, read through the platform's own `/proc` port rather than through a second
 * parser written here. `readStartTime` resolves `null` for an absent process and throws for
 * anything else, which is exactly the three-way answer the lock needs: a process that cannot be
 * observed is `unknown`, and an unknown owner's lock is never stolen.
 */
export const linuxProcessInspector: ServiceProcessInspector = {
  current: async () => {
    currentProcessInspection ??= inspectProcessWithProc(process.pid);
    const observed = await currentProcessInspection;
    if (observed.state !== 'live' || observed.startIdentity === null) {
      throw new ServiceLifecycleError('LAUNCHD_OPERATION_BUSY', 'Could not establish the lifecycle owner identity.');
    }
    return { pid: process.pid, startIdentity: observed.startIdentity };
  },
  inspect: inspectProcessWithProc,
};

async function inspectProcessWithProc(pid: number): Promise<ServiceProcessInspection> {
  try {
    const startIdentity = await createLinuxProcessPlatform().readStartTime(pid);
    return startIdentity === null
      ? { state: 'dead', startIdentity: null }
      : { state: 'live', startIdentity };
  } catch {
    return { state: 'unknown', startIdentity: null };
  }
}

export const linuxServiceBackend: ServiceBackend = {
  id: 'linux',
  managerName: 'systemd',
  commandName: 'systemctl',
  domainUnavailableMessage: 'The systemd user manager is unavailable.',
  definitionSuffix: unitSuffix,
  defaultPathEnvironment,
  unsupportedPlatformMessage: 'systemd is only available on Linux',
  resolvePaths: linuxPlatformPaths,
  labelFor: systemdUnitLabelFor,
  definitionPath: ({ serviceRoot, label }) => join(serviceRoot, `${label}${unitSuffix}`),
  directories: linuxDirectories,
  renderDefinition: (options: ServiceDefinitionOptions) => renderSystemdUnit({
    label: options.label,
    programArguments: [options.executable, ...options.args],
    home: options.home,
    workingDirectory: options.workingDirectory,
    stdoutPath: options.standardOutPath,
    stderrPath: options.standardErrorPath,
    pathEnvironment: options.pathEnvironment,
  }),
  commands: ({ uid, definitionPath }) => systemctlCommands({ uid, definitionPath }),
  interpretStatus: interpretSystemdStatus,
  runState: systemdRunState,
  defaultCommandRunner: runSystemctl,
  defaultProcessInspector: linuxProcessInspector,
};

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw configurationError(`${label} must be a non-negative integer`);
  return value;
}

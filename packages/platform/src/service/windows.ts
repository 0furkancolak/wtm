/**
 * A per-user Windows Scheduled Task, stated as the same descriptor launchd and systemd are (spec
 * `2026-09-03-windows-trust-and-transport-seam.md`, D6).
 *
 * `todo.md`'s own Windows lifecycle decision names three options — a Scheduled Task, a per-user
 * background process started at login, or a native Windows Service — and states a preference: the
 * first choice should need no administrator rights. A per-user Scheduled Task registered with
 * `/RL LIMITED` and no `/RU`/`/RP` (it then runs as whichever account created it) is exactly that;
 * a native Windows Service requires registering into the machine-wide service database, which
 * needs administrator rights to do even once. `schtasks.exe` is the OS-default tool, matching every
 * other backend's choice of the platform's own tool over an installed dependency.
 *
 * **This is documented, fixture-tested behaviour, not a measurement**, for the same reason the
 * Windows `FileTrustPolicy` is (`trust/windows.ts`): nothing on this macOS host can run
 * `schtasks.exe`. `__tests__/windows.test.ts` proves the argument vectors and the state machine
 * against an injected fake runner, exactly as the systemd backend is proven against a fake
 * `systemctl` — evidence about the shape of the commands, no evidence that Task Scheduler accepts
 * them. D2 is where that is measured.
 *
 * One architectural mismatch this descriptor cannot paper over: a launchd plist and a systemd unit
 * *are* the manager's definition — the file the publisher writes is the file the manager reads,
 * continuously, as the source of truth. A Scheduled Task is not: `schtasks /Create /XML` reads an
 * XML file once, at creation, and imports it into Task Scheduler's own store — the file this
 * descriptor renders is a **staging** artifact, consumed once, not a live definition read back on
 * every `daemon status`. The transactional publisher's protections (owned by the current user, not
 * group/other-writable, not a stale hard link) still make sense applied to that staging file — they
 * stop another user planting a definition this process would then unknowingly register — but
 * `renderDefinition`'s output is not, after `enable` runs once, still "the" definition the way a
 * plist is for the rest of the service's life. This is stated rather than hidden: it is the reason
 * `directories()` below still secures the staging path, and the reason a future increment reading
 * this file should not assume `definitionPath` means for Windows what it means for the other two.
 */
import { execFile, type ExecException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path/win32';
import { windowsPlatformPaths } from '../paths';
import type { ServiceDefinitionOptions } from '../ports';
import { ServiceLifecycleError, configurationError } from './errors';
import { assertPrintableValue, sanitizeCommandOutput } from './text';
import type {
  ManagedDirectory,
  ObservedServiceState,
  ServiceBackend,
  ServiceCommandResult,
  ServiceCommandSet,
  ServiceDirectoryInput,
  ServiceDirectoryPlan,
  ServiceProcessInspection,
  ServiceProcessInspector,
} from './types';

/**
 * `text.ts`'s shared `assertAbsolutePath` now pins `node:path/posix` explicitly (D2, after a real
 * `windows-latest` leg proved the opposite direction of this file's own original concern: darwin
 * and linux's POSIX paths broken by running on an actual Windows host, not Windows paths broken by
 * running on a POSIX one). That makes it permanently wrong for this backend's own `C:\...` paths,
 * so this is the win32-aware equivalent, local to this file rather than added to the shared one.
 */
function assertAbsoluteWindowsPath(path: string, label: string): void {
  assertPrintableValue(path, label);
  if (!isAbsolute(path)) throw configurationError(`${label} must be absolute`);
}

export const schtasksPath = 'schtasks.exe';
const maxCommandBufferBytes = 8 * 1024 * 1024;
const defaultPathEnvironment = 'C:\\Windows\\System32;C:\\Windows';
const taskFolder = 'WTM';
const taskPrefix = 'wtm-daemon-';
const definitionSuffix = '.xml';

/**
 * Same construction `homeDigest` (`./darwin.ts`) uses — sha256, hex, the first 32 characters —
 * over `home` resolved with the win32 `path`, not the POSIX one `homeDigest` itself calls.
 *
 * `homeDigest` cannot be reused directly: its `resolve` comes from the default `node:path`, which
 * is `node:path/posix` on every host except an actual `win32` process. Handed a real Windows path
 * on this macOS development machine, POSIX `resolve` does not recognise `C:\...` as absolute at
 * all and silently prepends `process.cwd()` — a digest that depends on the directory the test
 * happened to run from, not on `home`. The hash *algorithm* stays the one rule stated once, the
 * way the module comment on `homeDigest` intends; only the path-normalisation step differs, for
 * the same reason `windowsPlatformPaths` needed `node:path/win32` instead of the default.
 */
function windowsHomeDigest(home: string): string {
  return createHash('sha256').update(resolve(home), 'utf8').digest('hex').slice(0, 32);
}

/** The Scheduled Task path this HOME's daemon is published under, hashed over HOME exactly the
 * way the launchd label and the systemd unit name are. */
export function scheduledTaskLabelFor(home: string): string {
  assertAbsoluteWindowsPath(home, 'scheduled task home');
  return `${taskPrefix}${windowsHomeDigest(home)}`;
}

/** `\WTM\wtm-daemon-<hash>`, the path `schtasks /TN` addresses this task by. */
function scheduledTaskPath(label: string): string {
  return `\\${taskFolder}\\${label}`;
}

/** Read out of the staged definition's own filename, for the same reason `systemctlCommands`
 * re-derives its unit name from `definitionPath`: the commands must not address one task while
 * staging another. */
function labelFromDefinitionPath(definitionPath: string): string {
  const name = resolve(definitionPath).split(sep).at(-1) as string;
  const stem = name.endsWith(definitionSuffix) ? name.slice(0, -definitionSuffix.length) : '';
  if (stem.length === 0 || !/^[A-Za-z0-9._-]+$/.test(stem)) {
    throw configurationError('scheduled task definition path must name a scheduled task');
  }
  return stem;
}

export function scheduledTaskCommands(options: { uid: number; definitionPath: string }): ServiceCommandSet {
  // `uid` has no meaning on Windows — accepted only so this function's signature matches
  // `systemctlCommands`'s, which accepts it for the same reason it goes unused there today: one
  // call shape across every backend, so `ServiceBackend.commands` need not branch by platform.
  void options.uid;
  assertAbsoluteWindowsPath(options.definitionPath, 'scheduled task definition path');
  const label = labelFromDefinitionPath(options.definitionPath);
  const task = scheduledTaskPath(label);
  return {
    print: [schtasksPath, '/Query', '/TN', task, '/FO', 'LIST', '/V'],
    // Task Scheduler is a Windows service (`Schedule`); querying it directly is this backend's
    // analogue of `launchctl print gui/<uid>` / `systemctl --user show`, which both answer whether
    // the *manager* — not this one job — can be reached at all.
    printDomain: ['sc.exe', 'query', 'Schedule'],
    // No `reload`: unlike systemd, Task Scheduler has nothing cached to invalidate — `/Create`
    // both writes and activates the registration in one step, the same reason launchd has none.
    // `enable` is therefore where creation happens, not a separate registration step: importing
    // the staged XML *is* how a Scheduled Task comes to exist at all.
    enable: [schtasksPath, '/Create', '/TN', task, '/XML', options.definitionPath, '/F'],
    disable: [schtasksPath, '/Change', '/TN', task, '/DISABLE'],
    bootstrap: [schtasksPath, '/Run', '/TN', task],
    bootout: [schtasksPath, '/End', '/TN', task],
    // Approximated, not verified: `schtasks` has no single atomic "restart" verb the way
    // `launchctl kickstart -k` or `systemctl restart` do. `/Run` against an already-running
    // instance is asked to start a second one, which is not the same operation. This is exactly
    // the kind of gap D2 (a real Windows host) is for — recorded here rather than hidden behind a
    // plausible-looking argv.
    kickstart: [schtasksPath, '/Run', '/TN', task],
  };
}

/** Reads a `Key:     Value` line out of `schtasks /FO LIST /V`'s report. */
function listField(stdout: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(stdout);
  return match === null ? null : (match[1] as string).trim();
}

/**
 * `Status: Running` is the closest analogue this backend has to systemd's active states: a
 * per-user Scheduled Task triggered `ONLOGON` sits at `Ready` between logon and any crash-restart,
 * which is the same "registered but not currently doing anything" state `interpretSystemdStatus`
 * also reports as `absent` from the descriptor's own point of view — the shared publisher is what
 * turns that, plus a staged definition still on disk, into `installed-not-loaded`.
 */
function interpretScheduledTaskStatus(result: ServiceCommandResult): ObservedServiceState {
  return listField(result.stdout, 'Status') === 'Running' ? 'loaded' : 'absent';
}

function scheduledTaskRunState(result: ServiceCommandResult): string | null {
  return listField(result.stdout, 'Status');
}

/**
 * Everything under `dataRoot` is exclusively WTM's, the way `~/Library/Application Support/WTM`
 * is on macOS — Windows has no XDG-style directory WTM shares with every other application the
 * way `~/.config` is shared on Linux, so this chain has one owner throughout and needs no split
 * between an owner-only leaf and a shared intermediate.
 */
function windowsDirectories(input: ServiceDirectoryInput): ServiceDirectoryPlan {
  const definition = chainFrom(input.home, input.serviceRoot, true);
  return {
    root: contains(input.home, input.serviceRoot) ? input.home : input.serviceRoot,
    definition,
    install: dedupe([
      ...definition,
      ...chainFrom(input.home, input.dataRoot, true),
      ...chainFrom(input.home, input.logRoot, true),
    ]),
  };
}

function chainFrom(home: string, target: string, ownerOnlyLeaf: boolean): ManagedDirectory[] {
  const root = home;
  const child = relative(resolve(root), resolve(target));
  if (child === '' || child.startsWith('..') || isAbsolute(child)) {
    throw configurationError('scheduled task managed directory escapes its root');
  }
  const parts = child.split(sep);
  let current = resolve(root);
  return parts.map((part, index) => {
    current = join(current, part);
    return { path: current, ownerOnly: ownerOnlyLeaf && index === parts.length - 1 };
  });
}

/**
 * Merges by OR-ing `ownerOnly`, not "first occurrence wins" — unlike systemd's disjoint
 * `~/.config`/`~/.local` roots, `serviceRoot` nests inside `dataRoot` here
 * (`AppData\Local\WTM\service`), so the same physical directory
 * (`AppData\Local\WTM`) appears in this list twice: once as the `definition` chain's shared
 * *intermediate* (not owner-only, because `service` is one level deeper and is the actual leaf
 * there), and once as the data-root chain's own *leaf* (owner-only, because that chain ends
 * there). Keeping whichever occurrence came first would silently pick the looser of the two for a
 * directory this daemon actually owns — exactly the kind of silently-wrong permission the trust
 * model this increment builds exists to catch, so the two are merged into the stricter answer
 * instead of one shadowing the other.
 */
function dedupe(directories: readonly ManagedDirectory[]): ManagedDirectory[] {
  const merged = new Map<string, ManagedDirectory>();
  for (const directory of directories) {
    const existing = merged.get(directory.path);
    merged.set(directory.path, existing === undefined
      ? directory
      : { path: directory.path, ownerOnly: existing.ownerOnly || directory.ownerOnly });
  }
  return [...merged.values()];
}

function contains(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

export interface ScheduledTaskDefinitionOptions {
  label: string;
  programArguments: readonly string[];
  home: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}

/**
 * The Task Scheduler XML schema. Only what WTM needs: one logon trigger, one exec action, no
 * password prompt (`RunLevel` is `LeastPrivilege`, and there is no `<Principal><LogonType>` other
 * than the interactive-token default, which is what lets this be created without admin rights or
 * stored credentials).
 *
 * `stdoutPath`/`stderrPath` have no XML analogue — a Scheduled Task action has no built-in
 * stdout/stderr redirection the way launchd's `StandardOutPath` or systemd's `StandardOutput=` do.
 * They are threaded through as `-daemon-log-path`-shaped *arguments* instead (appended to
 * `programArguments`, at the composition root, not here — this function only renders whatever
 * argv it is given), which is a real behavioural difference from the other two platforms, named
 * rather than silently dropped.
 */
export function renderScheduledTaskXml(options: ScheduledTaskDefinitionOptions): string {
  assertUnitValue(options.label, 'scheduled task label');
  if (options.programArguments.length === 0) throw configurationError('scheduled task argv must not be empty');
  assertAbsoluteUnitPath(options.programArguments[0] as string, 'scheduled task executable');
  for (const argument of options.programArguments) assertUnitValue(argument, 'scheduled task argument');
  assertAbsoluteUnitPath(options.workingDirectory, 'scheduled task working directory');
  const command = options.programArguments[0] as string;
  const commandArguments = options.programArguments.slice(1).map(quoteArgument).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(`WTM daemon for ${options.home}`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(commandArguments)}</Arguments>
      <WorkingDirectory>${escapeXml(options.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function quoteArgument(value: string): string {
  return value.includes(' ') ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
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
 * `schtasks` failure text, matched the way `isUnreachableManager` matches `systemctl`'s: neither
 * tool spends a dedicated exit code on "I could not even ask", so the distinction is read from
 * stderr. **Unverified against a real `schtasks.exe`** — the exact wording is this function's own
 * best citation, not a measurement, and D2 corrects it if it is wrong.
 */
export function isSchedulerUnreachable(stderr: string): boolean {
  return /Task Scheduler service is not running/i.test(stderr)
    || /RPC server is unavailable/i.test(stderr);
}

/** Same caveat as `isSchedulerUnreachable`: cited from documented `schtasks` behaviour, not
 * measured on a Windows host. */
function isTaskNotFound(stderr: string): boolean {
  return /cannot find the file specified/i.test(stderr)
    || /The system cannot find the (?:file|path) specified/i.test(stderr);
}

export async function runSchtasks(argv: readonly string[]): Promise<ServiceCommandResult> {
  const executable = argv[0];
  if (executable !== schtasksPath && executable !== 'sc.exe') throw configurationError('Invalid schtasks argv');
  return await new Promise((resolvePromise) => {
    execFile(executable as string, argv.slice(1), {
      encoding: 'utf8',
      maxBuffer: maxCommandBufferBytes,
      shell: false,
      env: {
        PATH: 'C:\\Windows\\System32;C:\\Windows',
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      },
    }, (error: ExecException | null, stdout: string, stderr: string) => {
      const exitCode = error === null ? 0
        : typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : null;
      resolvePromise({
        outcome: exitCode === 0 ? 'success'
          : isSchedulerUnreachable(stderr) ? 'manager-unreachable'
          : isTaskNotFound(stderr) ? 'not-found'
          : 'failure',
        exitCode,
        stdout: sanitizeCommandOutput(stdout),
        stderr: sanitizeCommandOutput(stderr),
      });
    });
  });
}

let currentProcessInspection: Promise<ServiceProcessInspection> | undefined;

/**
 * A stand-in, not a Windows implementation: `createWindowsProcessPlatform` (`process/windows.ts`)
 * is a D2 TODO (spec D8 — no fixture equivalent exists for a live process inspection the way one
 * exists for parsed text), so this inspector reports `unknown` for every PID rather than calling a
 * port that would throw. `unknown` is the safe answer the lock semantics already define for "this
 * cannot be observed": a lock whose owner cannot be observed is left alone, never stolen.
 */
export const windowsProcessInspector: ServiceProcessInspector = {
  current: async () => {
    currentProcessInspection ??= Promise.resolve({ state: 'unknown', startIdentity: null });
    await currentProcessInspection;
    throw new ServiceLifecycleError('LAUNCHD_OPERATION_BUSY', 'Could not establish the lifecycle owner identity.');
  },
  inspect: async () => ({ state: 'unknown', startIdentity: null }),
};

export const windowsServiceBackend: ServiceBackend = {
  id: 'win32',
  managerName: 'Task Scheduler',
  commandName: 'schtasks',
  domainUnavailableMessage: 'The Windows Task Scheduler service is unavailable.',
  definitionSuffix,
  defaultPathEnvironment,
  unsupportedPlatformMessage: 'Task Scheduler is only available on Windows',
  resolvePaths: windowsPlatformPaths,
  labelFor: scheduledTaskLabelFor,
  definitionPath: ({ serviceRoot, label }) => join(serviceRoot, `${label}${definitionSuffix}`),
  directories: windowsDirectories,
  renderDefinition: (options: ServiceDefinitionOptions) => renderScheduledTaskXml({
    label: options.label,
    programArguments: [options.executable, ...options.args],
    home: options.home,
    workingDirectory: options.workingDirectory,
    stdoutPath: options.standardOutPath,
    stderrPath: options.standardErrorPath,
  }),
  commands: ({ uid, definitionPath }) => scheduledTaskCommands({ uid, definitionPath }),
  interpretStatus: interpretScheduledTaskStatus,
  runState: scheduledTaskRunState,
  defaultCommandRunner: runSchtasks,
  defaultProcessInspector: windowsProcessInspector,
};

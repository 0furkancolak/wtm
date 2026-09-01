/**
 * launchd, stated as a descriptor.
 *
 * Everything here was `packages/daemon/src/launchd.ts` and is unchanged in behaviour: the same
 * label derivation, the same plist bytes, the same `launchctl` argument vectors, the same `ps`
 * reader for the lock owner, and the same legacy `dev.wtm.daemon` migration. It moved because the
 * publisher around it turned out not to be launchd knowledge at all, and the way to prove that was
 * to write a second backend against the same seam rather than to describe one.
 *
 * The macOS half of this module is a move, not a rewrite. Where a name changed it is because the
 * generalised publisher calls it by a platform-neutral name; where a comment survived it is
 * because what it explains is still true.
 */
import { execFile, type ExecException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { darwinPlatformPaths } from '../paths';
import type { ServiceDefinitionOptions } from '../ports';
import { ServiceLifecycleError, configurationError } from './errors';
import {
  assertAbsolutePath,
  assertPrintableValue,
  sanitizeCommandOutput,
  sanitizePathEnvironment,
} from './text';
import type {
  ObservedServiceState,
  ServiceBackend,
  ServiceCommandResult,
  ServiceDirectoryInput,
  ServiceDirectoryPlan,
  ServiceProcessInspection,
  ServiceProcessInspector,
} from './types';

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
  assertAbsolutePath(home, 'launchd home');
  return `${legacyLaunchdLabel}.${homeDigest(home)}`;
}

/**
 * Exported so the Linux backend derives its unit name the same way rather than by resemblance.
 * One rule stated once is one rule to keep true; two rules that agree today are two rules.
 */
export function homeDigest(home: string): string {
  return createHash('sha256').update(resolve(home), 'utf8').digest('hex').slice(0, 32);
}

export const launchctlPath = '/bin/launchctl';
/**
 * `launchctl print gui/<uid>` lists every service in the domain, which is hundreds of
 * kilobytes on a working desktop session. Capping the child's own buffer at the reporting
 * limit made execFile kill it and report a domain that is in fact perfectly available, so
 * the command is allowed to speak freely and only what is retained stays truncated.
 */
const maxCommandBufferBytes = 8 * 1024 * 1024;
const defaultPathEnvironment = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

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

export function launchdCommands(options: { uid: number; plistPath: string }): LaunchdCommandSet {
  const uid = nonNegativeInteger(options.uid, 'launchd uid');
  assertAbsolutePath(options.plistPath, 'launchd plist path');
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
  return sanitizePathEnvironment(value, 'launchd');
}

export function generateLaunchdPlist(options: LaunchdPlistOptions): string {
  assertPrintableValue(options.label, 'launchd label');
  if (options.programArguments.length === 0) throw configurationError('launchd argv must not be empty');
  assertAbsolutePath(options.programArguments[0] as string, 'launchd executable');
  for (const argument of options.programArguments) assertPrintableValue(argument, 'launchd argument');
  for (const [path, name] of [
    [options.home, 'launchd home'],
    [options.stdoutPath, 'launchd stdout path'],
    [options.stderrPath, 'launchd stderr path'],
  ] as const) assertAbsolutePath(path, name);
  const environment = Object.entries(options.environment ?? {}).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of environment) {
    assertPrintableValue(key, 'launchd environment key');
    assertPrintableValue(value, 'launchd environment value');
  }
  const argumentsXml = options.programArguments.map((argument) => `    <string>${escapeXml(argument)}</string>`).join('\n');
  const environmentXml = environment.length === 0 ? '' : `  <key>EnvironmentVariables</key>
  <dict>
${environment.map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
`;
  // ProcessType is Adaptive rather than Background. launchd throttles a Background job's CPU
  // and disk I/O, and everything it spawns inherits the throttle: the port prober -- one
  // short-lived process per candidate port -- took longer than its own two-second timeout, so
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

/** Reads the `state = <word>` line that `launchctl print` puts near the top of its report. */
function launchdRunState(result: ServiceCommandResult): string | null {
  return /^\s*state = (.+?)\s*$/m.exec(result.stdout)?.[1] ?? null;
}

/**
 * A `print` that succeeded means launchd has the job. There is no second reading of the output to
 * do: launchd answers "I do not know this service" with exit 113, which the runner has already
 * classified, and inferring absence from the human text of a successful report is exactly the
 * mistake `never infers service absence from human launchctl output` exists to prevent.
 */
function interpretLaunchdStatus(): ObservedServiceState {
  return 'loaded';
}

export async function runLaunchctl(argv: readonly string[]): Promise<ServiceCommandResult> {
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

let currentProcessInspection: Promise<ServiceProcessInspection> | undefined;

export const darwinProcessInspector: ServiceProcessInspector = {
  current: async () => {
    currentProcessInspection ??= inspectProcessWithPs(process.pid);
    const observed = await currentProcessInspection;
    if (observed.state !== 'live' || observed.startIdentity === null) {
      throw new ServiceLifecycleError('LAUNCHD_OPERATION_BUSY', 'Could not establish the lifecycle owner identity.');
    }
    return { pid: process.pid, startIdentity: observed.startIdentity };
  },
  inspect: inspectProcessWithPs,
};

async function inspectProcessWithPs(pid: number): Promise<ServiceProcessInspection> {
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

/**
 * This HOME's own legacy definition declares itself. `readSafeManagedFile` checks containment,
 * ownership, mode and link count but never authorship, so the plist has to say for itself which
 * HOME it belongs to: a definition naming another HOME is another HOME's, wherever it is sitting,
 * and is neither adopted nor touched.
 */
function legacyPlistDeclaresHome(content: string, paths: { home: string; stdoutPath: string }): boolean {
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
 * `~/Library` is not owner-only and must not be made so -- it is the user's own library, shared
 * with every application on the machine. The three leaves are, because they hold this daemon's
 * definition, its database and its logs, and nothing else has business reading them.
 */
function darwinDirectories(input: ServiceDirectoryInput): ServiceDirectoryPlan {
  const libraryDirectory = dirname(input.serviceRoot);
  const definition = [
    { path: libraryDirectory, ownerOnly: false },
    { path: input.serviceRoot, ownerOnly: true },
  ];
  return {
    root: input.home,
    definition,
    install: [
      ...definition,
      { path: dirname(input.dataRoot), ownerOnly: false },
      { path: input.dataRoot, ownerOnly: true },
      { path: dirname(input.logRoot), ownerOnly: false },
      { path: input.logRoot, ownerOnly: true },
    ],
  };
}

export const darwinServiceBackend: ServiceBackend = {
  id: 'darwin',
  managerName: 'launchd',
  commandName: 'launchctl',
  domainUnavailableMessage: 'The launchd GUI domain is unavailable.',
  definitionSuffix: '.plist',
  defaultPathEnvironment,
  unsupportedPlatformMessage: 'launchd is only available on macOS',
  resolvePaths: darwinPlatformPaths,
  labelFor: launchdLabelFor,
  definitionPath: ({ serviceRoot, label }) => join(serviceRoot, `${label}.plist`),
  directories: darwinDirectories,
  renderDefinition: (options: ServiceDefinitionOptions) => generateLaunchdPlist({
    label: options.label,
    programArguments: [options.executable, ...options.args],
    home: options.workingDirectory,
    stdoutPath: options.standardOutPath,
    stderrPath: options.standardErrorPath,
    // HOME and PATH are the only two variables the agent inherits, and it inherits nothing else:
    // a launchd agent starts with an environment that has no relation to any shell the user ever
    // configured, so anything the daemon needs has to be stated here.
    environment: { HOME: options.home, PATH: options.pathEnvironment },
  }),
  commands: ({ uid, definitionPath }) => launchdCommands({ uid, plistPath: definitionPath }),
  interpretStatus: interpretLaunchdStatus,
  runState: launchdRunState,
  defaultCommandRunner: runLaunchctl,
  defaultProcessInspector: darwinProcessInspector,
  legacyMigration: { label: legacyLaunchdLabel, declaresHome: legacyPlistDeclaresHome },
};

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

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw configurationError(`${label} must be a non-negative integer`);
  return value;
}

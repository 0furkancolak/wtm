/**
 * The test that keeps macOS out of `@wtm/core` and `@wtm/protocol` (spec D8).
 *
 * "Core is platform-independent" is an acceptance criterion, and an acceptance criterion nothing
 * checks is a sentence in a document. The independence was true for about an hour after the seam
 * was extracted; what makes it stay true is that re-entry is a failing test rather than a review
 * comment somebody has to notice. The two packages scanned here are the two the dependency graph
 * says know nothing about an operating system: `protocol` is a wire format, and `core` takes every
 * platform fact it needs as a port supplied by a composition root.
 *
 * **Comments are not exempt, deliberately.** A comment saying `~/Library/Application Support/WTM`
 * is a statement about where files go. When it survives a move it is wrong documentation sitting in
 * the one package that is supposed not to know where files go, and wrong documentation about paths
 * is how the next person puts the path back.
 *
 * The exception list is a literal array below with a reason on every entry, and each entry pins the
 * number of occurrences it reviewed. That shape is the point: widening the guard means editing an
 * array of prose in a diff a reviewer will read, rather than adding one character to a regular
 * expression nobody will.
 */
import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** The two packages that must not know what operating system they are running on. */
const scannedRoots = ['packages/core/src', 'packages/protocol/src'] as const;

interface StructuralRule {
  /** Named, because a violation report has to say which rule and the reason it exists. */
  name: string;
  why: string;
  pattern: RegExp;
}

const rules: readonly StructuralRule[] = [
  {
    name: 'macos-data-root',
    why: 'Where macOS keeps application data. It is `PlatformPaths.dataRoot` now, and core is handed the answer.',
    pattern: /Library\/Application Support/,
  },
  {
    name: 'macos-log-root',
    why: 'Where macOS keeps logs. It is `PlatformPaths.logRoot` now.',
    pattern: /Library\/Logs/,
  },
  {
    name: 'macos-service-root',
    why: 'Where launchd reads user agents from. It is `PlatformPaths.serviceRoot` now.',
    pattern: /LaunchAgents/,
  },
  {
    name: 'launchctl',
    why: 'The macOS service manager\'s command. It belongs to the service backend in @wtm/platform.',
    pattern: /launchctl/,
  },
  {
    name: 'launchd',
    why: 'The macOS service manager. Core does not know that WTM has a service, let alone which one.',
    pattern: /launchd/,
  },
  {
    name: 'systemctl',
    why: 'The Linux service manager\'s command. Independence is not "macOS moved out and Linux moved in".',
    pattern: /systemctl/,
  },
  {
    name: 'systemd',
    why: 'The Linux service manager. Same reason as systemctl.',
    pattern: /systemd/,
  },
  {
    name: 'procfs',
    why: 'Linux reads process state from /proc. That is `ProcessPlatform`\'s business, not core\'s.',
    pattern: /\/proc\//,
  },
  {
    name: 'spawns-ps',
    why:
      'BSD `ps` output format is a platform fact. Core asked it for a lease holder\'s start time '
      + 'until C1-5; it now takes a `ProcessStartTimeReader` instead. Matched only where `ps` is '
      + 'the command being run, so the `ps` *WTM command* stays sayable.',
    pattern: /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execFileAsync)\s*\(\s*\[?\s*['"]ps['"]/,
  },
  {
    name: 'process.platform',
    why: 'Branching on the host is choosing a platform, which is a composition root\'s job.',
    pattern: /process\.platform/,
  },
  {
    name: 'os.platform',
    why: 'The same question spelled the other way.',
    pattern: /\bos\.platform\s*\(/,
  },
  {
    name: 'imports-platform-package',
    why:
      'Spec D1: core declares port types and takes implementations as arguments. A core that '
      + 'imports @wtm/platform is platform-indirect, not platform-independent, and the dependency '
      + 'graph would gain the edge the seam exists to avoid.',
    pattern: /from\s+['"]@wtm\/platform/,
  },
];

interface ReviewedException {
  /** Repository-relative, so a violation report and an exception name the file the same way. */
  file: string;
  rule: string;
  /** How many occurrences were reviewed. A new one fails until somebody reviews it too. */
  occurrences: number;
  /** Every excepted line must contain this, so an exception cannot silently widen its own scope. */
  requires: string;
  reason: string;
}

/**
 * Every place a scanned package is allowed to know something about the host, and why.
 *
 * There is exactly one, and spec D7 argues it: the three branches choose POSIX process groups over
 * Windows semantics, they are already correct for Linux — the platform this increment adds — and
 * item 9 assigns Windows process semantics to the Windows increment, where they get decided
 * alongside Job Objects instead of piecemeal here. Changing them now would mean editing
 * untested-on-Windows code with no way to verify either branch.
 */
const reviewedExceptions: readonly ReviewedException[] = [
  {
    file: 'packages/core/src/plan/external-adapter.ts',
    rule: 'process.platform',
    occurrences: 3,
    requires: "'win32'",
    reason:
      'POSIX-versus-Windows process-group semantics, deferred to the Windows increment by spec D7. '
      + 'Pinned to lines mentioning win32 so a `darwin` branch could never hide behind this entry.',
  },
  {
    file: 'packages/core/src/plan/adapter-runner.ts',
    rule: 'procfs',
    occurrences: 1,
    requires: '/dev/fd',
    reason:
      'A comment, not a read. The adapter loader short-circuits module resolution because the '
      + 'default resolver calls realpath, which fails for a `/dev/fd` entry whose file is unlinked '
      + 'on a procfs-backed host -- the finding that cost 25 red tests in the first Linux CI run '
      + '(F12). The code stays platform-neutral; only the explanation names the filesystem, and '
      + 'stripping it would leave a short-circuit that reads as an optimisation and invites '
      + 'removal. Pinned to the single line that also mentions `/dev/fd`, which is the path the '
      + 'loader genuinely uses, so a real procfs read could not hide behind this entry.',
  },
];

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/**
 * A repository-relative file identifier is a logical name, not a filesystem path — it is
 * compared against the literal, forward-slash exception list below and printed in a violation
 * report, so it must read the same on every host. `path.relative`/`path.join` disagree: they use
 * the host separator, which is a backslash on an actual win32 host. Without this normalization
 * every already-reviewed exception below stops matching on Windows and reappears as "new".
 */
function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

/** This file names every forbidden literal in order to forbid it, so it cannot scan itself. */
const selfPath = toPosixPath(relative(repositoryRoot, fileURLToPath(import.meta.url)));

async function scannedFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const root of scannedRoots) await collect(join(repositoryRoot, root), found);
  return found
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => path !== selfPath)
    .sort();
}

async function collect(directory: string, found: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, found);
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
}

function exceptionFor(file: string, rule: string): ReviewedException | undefined {
  return reviewedExceptions.find((entry) => entry.file === file && entry.rule === rule);
}

async function findViolations(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await scannedFiles()) {
    const lines = (await readFile(join(repositoryRoot, file), 'utf8')).split('\n');
    for (const rule of rules) {
      const exception = exceptionFor(file, rule.name);
      let excused = 0;
      lines.forEach((text, index) => {
        if (!rule.pattern.test(text)) return;
        if (exception !== undefined && text.includes(exception.requires) && excused < exception.occurrences) {
          excused += 1;
          return;
        }
        violations.push({ file, line: index + 1, rule: rule.name, text: text.trim() });
      });
    }
  }
  return violations;
}

test('core and protocol contain no operating system', async () => {
  const violations = await findViolations();

  // The report names the file and the line, because a structural failure whose message is
  // `expected 1 to be 0` sends the reader looking for a needle in two packages.
  expect(violations.map(({ file, line, rule, text }) => `${file}:${String(line)} [${rule}] ${text}`))
    .toEqual([]);
});

test('the guard actually looks at the packages it claims to', async () => {
  const files = await scannedFiles();

  // A guard that silently scanned nothing — a renamed directory, a walk that threw and was
  // swallowed — would pass forever. So the sweep is asserted to have found real files under both
  // roots, and to have read comments rather than only code.
  expect(files.length).toBeGreaterThan(50);
  for (const root of scannedRoots) {
    // `scannedFiles()` always reports forward-slash identifiers (see `toPosixPath`), regardless
    // of the host's own separator, so the check here is against a literal, not `sep`.
    expect(files.some((file) => file.startsWith(`${root}/`))).toBe(true);
  }
  expect(files).toContain('packages/core/src/analysis/operation-lease.ts');
  expect(files).toContain('packages/protocol/src/errors.ts');
  expect(files).not.toContain(selfPath);
});

test('every rule matches the thing it was written to catch', async () => {
  // Proving the regexes fire at all, without having to dirty the repository to find out. The
  // sample for each rule is what the rule exists to reject.
  const samples: Record<string, string> = {
    'macos-data-root': "  const root = join(home, 'Library/Application Support', 'WTM');",
    'macos-log-root': ' * Logs are written under ~/Library/Logs/WTM.',
    'macos-service-root': "const agents = join(home, 'Library', 'LaunchAgents');",
    launchctl: "await run(['launchctl', 'print', domain]);",
    launchd: ' // The launchd label is derived per HOME.',
    systemctl: "await run(['systemctl', '--user', 'daemon-reload']);",
    systemd: ' // Rendered as a systemd user unit.',
    procfs: "const stat = await readFile(`/proc/${pid}/stat`, 'utf8');",
    'spawns-ps': "const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid)]);",
    'process.platform': "  detached: process.platform !== 'win32',",
    'os.platform': "if (os.platform() === 'darwin') return macos;",
    'imports-platform-package': "import { createDarwinProcessPlatform } from '@wtm/platform/process';",
  };

  expect(Object.keys(samples).sort()).toEqual(rules.map(({ name }) => name).sort());
  for (const rule of rules) {
    expect(`${rule.name}: ${String(rule.pattern.test(samples[rule.name] as string))}`)
      .toBe(`${rule.name}: true`);
  }

  // And the one thing the `ps` rule must not catch: `ps` is also a WTM command name, and the
  // protocol names it. A rule that forbade the word would forbid the product's own vocabulary.
  const psRule = rules.find(({ name }) => name === 'spawns-ps') as StructuralRule;
  expect(psRule.pattern.test("command: 'ps', arguments: {}")).toBe(false);
});

test('every reviewed exception still describes something that is really there', async () => {
  // A stale exception is worse than no exception: it reads as a reviewed decision about code that
  // no longer exists, and it silently excuses the next occurrence that lands in that file.
  for (const exception of reviewedExceptions) {
    const rule = rules.find(({ name }) => name === exception.rule);
    expect(`${exception.rule} is a known rule: ${String(rule !== undefined)}`)
      .toBe(`${exception.rule} is a known rule: true`);
    expect(exception.reason.length).toBeGreaterThan(40);

    const lines = (await readFile(join(repositoryRoot, exception.file), 'utf8')).split('\n');
    const matched = lines.filter((text) =>
      (rule as StructuralRule).pattern.test(text) && text.includes(exception.requires));
    expect(`${exception.file} [${exception.rule}]: ${String(matched.length)}`)
      .toBe(`${exception.file} [${exception.rule}]: ${String(exception.occurrences)}`);
  }
});

/**
 * Keeps a raw `spawnSync('node' | 'bun' | process.execPath, ...)` from coming back into a test or
 * scenario file (spec `2026-09-03-a-hang-that-cannot-hide.md`, D5).
 *
 * That call shape is how a test drives a scenario written as its own file, and it is also the
 * shape that hung a darwin arm64 CI leg for 29 minutes on a commit that changed no product code:
 * `spawnSync`'s `timeout` sends `SIGTERM` by default, a child can ignore `SIGTERM`, and nothing
 * else in the call was watching the clock. `runScenario` fixes that once, in one place — this test
 * is what keeps a new call site from writing the fix by hand and forgetting the one part
 * (`killSignal: 'SIGKILL'`) that makes it real.
 *
 * The exception list is a literal array with a reason on every entry, the same shape
 * `platform-independence.test.ts` uses and for the same reason: widening the guard means editing
 * prose a reviewer will read, not a regular expression nobody will.
 */
import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const scannedRoots = ['packages', 'scripts'] as const;
/** Imported by tests, so its children are the test process's children. */
const testkitSource = 'packages/testkit/src/';

/** Whether a scanned file's spawns block the thread bun's per-test timeout would fire on. */
function runsInTestProcess(file: string): boolean {
  if (file.endsWith('.scenario.ts') || file.endsWith('.child.ts')) return false;
  return file.endsWith('.test.ts') || file.startsWith(testkitSource);
}

/** The call shape this guard exists to catch: spawning another JS/TS runtime synchronously. */
const pattern = /spawnSync\(\s*(?:'node'|"node"|'bun'|"bun"|process\.execPath)(?=[,)])/;

/**
 * The second, wider rule: any synchronous child spawn that runs *in the test process* and carries
 * no real deadline.
 *
 * The rule above only ever named `node`, `bun` and `process.execPath`, which is how
 * `spawnSync('/usr/bin/ruby', ...)` walked past it and held a darwin x64 CI leg silent until its
 * 30 minute job cap. The command is not what makes such a call dangerous -- the synchrony is.
 * `spawnSync`, `execFileSync` and `execSync` all block the very thread bun's per-test `--timeout`
 * would have to fire on, so a child that waits (a macOS developer-tools shim waiting for a prompt
 * nobody can see, Gatekeeper holding an unsigned executable, `npm` sitting on a registry or auth
 * wait, `git` on an inherited credential prompt) does not fail its test. It stops the run, with no
 * output naming it, for as long as whatever is above it will wait.
 *
 * So the requirement is per call, not per command: a `timeout` AND `killSignal: 'SIGKILL'`, the
 * pair `runScenario` applies for everyone -- `timeout` alone sends `SIGTERM`, which is a request a
 * child can ignore, and one that does turns the deadline into nothing. Both have to be written
 * into the call itself rather than hidden behind a shared options constant, which is a limitation
 * worth keeping: this guard stays something a reader can evaluate by looking at one line.
 *
 * Scope is everything that runs *in the test process*: the `.test.ts` files themselves, and the
 * `@wtm/testkit` modules they import -- `runtime-invocation.ts` and `real-executable.ts` each
 * spawned a synchronous child on behalf of whichever test imported them, invisible to a rule that
 * only read `.test.ts`. A `.scenario.ts` or `.child.ts` file is a child, and its whole process is
 * already bounded transitively by the `runScenario` call that spawned it, which kills it with
 * `SIGKILL` at its deadline whatever it is doing (spec D7) -- the same reasoning
 * `idle-daemon.scenario.ts` is excepted under above.
 */
const synchronousSpawn = /\b(?:spawnSync|execFileSync|execSync)\s*\(/g;

/**
 * Blanks comments, string contents and regular-expression bodies while keeping every other byte in
 * place, so offsets still map to line numbers. Without it the guard reads its own prose -- and
 * every `// spawnSync(...)` in an explanation of why a call was bounded -- as an unbounded call.
 * String and regex contents go too: `spawnSync(` written inside either is not a call.
 *
 * Order matters, and every misparse here fails *open* -- a swallowed region is a call nobody
 * looks at -- which is why the three states are all handled rather than two of them documented:
 * - comment starts are tested before quote starts, so an apostrophe in prose ("don't") cannot open
 *   a string that swallows the code after it;
 * - a quote in code consumes its whole string, so a `//` inside one (`'https://example.invalid'`)
 *   is never read as a comment;
 * - a regex literal is consumed as a unit, so one ending in an escaped slash (`/https?:\/\//`)
 *   cannot be read as a comment start, and one holding an odd quote (`/['"]/`) cannot open a
 *   phantom string.
 *
 * Regex-versus-division is the one genuinely ambiguous call in JavaScript's grammar, and it is
 * settled here the way every lexer without a parser settles it: by what precedes the slash. A
 * regex may only begin where a value may begin, so the preceding significant token is checked
 * against the operators and keywords that can be followed by one. A division misread as a regex
 * would blank real code, so the test the fixture below pins is that ordinary arithmetic is not
 * taken for a literal.
 */
const regexPrecedingKeyword = /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/;

function startsRegularExpression(before: string): boolean {
  const trimmed = before.replace(/\s+$/, '');
  if (trimmed === '') return true;
  return '(,=:[!&|?{};+-*%~^<>'.includes(trimmed.at(-1) as string) || regexPrecedingKeyword.test(trimmed);
}

function withoutComments(source: string, blankBodies = false): string {
  const out = source.split('');
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at += 1) if (out[at] !== '\n') out[at] = ' ';
  };
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '/' && startsRegularExpression(source.slice(0, index))) {
      const opened = index;
      index += 1;
      let inClass = false;
      while (index < source.length && source[index] !== '\n') {
        const current = source[index];
        if (current === '\\') { index += 2; continue; }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        index += 1;
      }
      if (blankBodies) blank(opened + 1, Math.min(index, source.length));
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      const quote = character;
      const opened = index;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
      if (blankBodies) blank(opened + 1, Math.min(index, source.length));
      index += 1;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/**
 * Where call *sites* and call *spans* are found: strings and regex bodies blanked as well, so a
 * `spawnSync(` written inside either is not read as a call, and a parenthesis inside a string
 * argument cannot be counted as structure. The bound is then read from the same span of the
 * comments-only text, because `killSignal: 'SIGKILL'` is itself a string.
 */
function withoutCommentsOrStrings(source: string): string {
  return withoutComments(source, true);
}

/**
 * The call's own text, from its name to its matching close paren.
 *
 * The span is measured on `sites` (strings blanked) and sliced out of `code` (strings intact),
 * which are the same length byte for byte. Counting parentheses on `code` was wrong in both
 * directions: a `(` in a string argument ran the span past the real close paren and let the *next*
 * call's `timeout:` vouch for an unbounded one, and a `)` in a string truncated a bounded call's
 * text before its options and reported it unbounded.
 */
function callText(sites: string, code: string, start: number): string {
  let depth = 0;
  for (let index = sites.indexOf('(', start); index < sites.length; index += 1) {
    if (sites[index] === '(') depth += 1;
    else if (sites[index] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(start, index + 1);
    }
  }
  return code.slice(start);
}

function isBounded(call: string): boolean {
  return /\btimeout\s*:/.test(call) && /\bkillSignal\s*:\s*'SIGKILL'/.test(call);
}

interface ReviewedException {
  file: string;
  /** Every excepted line must contain this, so an exception cannot silently widen its own scope. */
  requires: string;
  reason: string;
}

/** One entry per excepted line, not per file: two different lines need two different reasons. */
const reviewedExceptions: readonly ReviewedException[] = [
  {
    file: 'packages/testkit/src/__tests__/scenario-child.test.ts',
    requires: "spawnSync('node', ['--import', 'tsx', childPath]",
    reason:
      'Measures runScenario from outside with a hand-written bound (F1\'s outer deadline), so it '
      + 'cannot go through the function it is checking.',
  },
  {
    file: 'packages/testkit/src/__tests__/scenario-bound.child.ts',
    requires: "killSignal: 'SIGTERM'",
    reason:
      'Deliberately raw and deliberately the default kill signal: reproduces the exact pre-fix '
      + 'shape to prove it never returns inside the deadline runScenario would have honoured.',
  },
  {
    file: 'packages/testkit/src/__tests__/scenario-bound.child.ts',
    requires: "'sigterm-attempt'",
    reason: 'The deaf child spawned for both halves of the measurement above.',
  },
  {
    file: 'packages/daemon/src/__tests__/idle-daemon.scenario.ts',
    requires: "spawnSync('bun', [",
    reason: 'A `bun build` bundling step, not a scenario that can hang on a refusal path.',
  },
  {
    file: 'packages/daemon/src/__tests__/idle-daemon.scenario.ts',
    requires: 'benchmarkSource, bundlePath',
    reason:
      'Runs a benchmark, not an assertion-bearing scenario. Wall-clock is bounded transitively: '
      + 'the outer `runScenario` call in idle-daemon.test.ts kills this whole process with SIGKILL '
      + 'at its deadline regardless of what this child is doing (spec D7).',
  },
  {
    file: 'scripts/__tests__/package-contents.test.ts',
    requires: "['run', 'build']",
    reason: 'A build step, not a scenario that can hang on a refusal path; already reviewed in C2.',
  },
];

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * `path.relative` follows the host separator, so a Windows run of this guard produced
 * `packages\...\foo.ts` -- neither matching `reviewedExceptions`' forward-slash `file` values nor
 * the `'__tests__/'` substring below, which silently dropped every `.test.ts` file (not ending in
 * `.scenario.ts`) from the scan on that host rather than merely failing to except it. `git` itself
 * settled on forward slashes as the one true separator for a repo-relative identifier regardless of
 * host (`1a2c4cf`); this guard's own identifiers follow the same rule.
 */
function repoRelative(path: string): string {
  return relative(repositoryRoot, path).split(sep).join('/');
}

const selfPath = repoRelative(fileURLToPath(import.meta.url));

async function scannedFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const root of scannedRoots) await collect(join(repositoryRoot, root), found);
  return found
    .map((path) => repoRelative(path))
    .filter((path) => path !== selfPath)
    .filter((path) => path.includes('__tests__/') || path.endsWith('.scenario.ts') || path.startsWith(testkitSource))
    .sort();
}

async function collect(directory: string, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, found);
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
}

async function findViolations(): Promise<{
  violations: Violation[];
  unbounded: Violation[];
  unmatchedExceptions: ReviewedException[];
}> {
  const violations: Violation[] = [];
  const unbounded: Violation[] = [];
  const unmatchedExceptions = [...reviewedExceptions];
  const except = (file: string, text: string): boolean => {
    const matchIndex = unmatchedExceptions.findIndex((entry) => entry.file === file && text.includes(entry.requires));
    if (matchIndex === -1) return false;
    unmatchedExceptions.splice(matchIndex, 1);
    return true;
  };
  for (const file of await scannedFiles()) {
    const source = await readFile(join(repositoryRoot, file), 'utf8');
    const lines = source.split('\n');
    lines.forEach((text, index) => {
      if (!pattern.test(text)) return;
      if (except(file, text)) return;
      violations.push({ file, line: index + 1, text: text.trim() });
    });
    if (!runsInTestProcess(file)) continue;
    const code = withoutComments(source);
    const sites = withoutCommentsOrStrings(source);
    for (const match of sites.matchAll(synchronousSpawn)) {
      const start = match.index;
      if (isBounded(callText(sites, code, start))) continue;
      const line = code.slice(0, start).split('\n').length;
      const text = lines[line - 1] ?? '';
      if (except(file, text)) continue;
      unbounded.push({ file, line, text: text.trim() });
    }
  }
  return { violations, unbounded, unmatchedExceptions };
}

test('no test or scenario file spawns node, bun, or itself synchronously outside runScenario', async () => {
  const { violations } = await findViolations();

  expect(violations.map(({ file, line, text }) => `${file}:${String(line)} ${text}`)).toEqual([]);
});

test('no test file spawns a child synchronously without a timeout and a SIGKILL', async () => {
  const { unbounded } = await findViolations();

  expect(unbounded.map(({ file, line, text }) => `${file}:${String(line)} ${text}`)).toEqual([]);
});

test('every reviewed exception still matches a line in its file', async () => {
  // An exception nothing matches any more is stale: the line it excused was fixed, renamed, or
  // moved, and the exception is now excusing nothing. A regex could hide that; this cannot.
  const { unmatchedExceptions } = await findViolations();

  expect(unmatchedExceptions.map((entry) => `${entry.file}: ${JSON.stringify(entry.requires)}`)).toEqual([]);
});

test('the wider rule reads calls, not lines: comments, strings, regexes and spans', () => {
  // Proves the mechanism on source this guard controls, so "no violations" above cannot quietly
  // mean "the detector stopped detecting". Every shape here has failed one direction or the other
  // in review: a call hidden in a comment or a string (false positive), a parenthesis inside a
  // string argument truncating a bounded call's span or running it into the next call's options
  // (both directions), and a regex literal whose trailing escaped slash or odd quote would open a
  // phantom comment or string and swallow the call after it (false negative, the bad one).
  const source = [
    "// spawnSync('ruby', ['-c', path]);",
    "/* execFileSync('git', ['status']); */",
    "const message = 'spawnSync(\\'git\\', args)';",
    "const bad = spawnSync('npm', ['pack'], { encoding: 'utf8' });",
    'const good = execFileSync(',
    "  'git',",
    "  ['status'],",
    "  { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },",
    ');',
    "const asked = spawnSync('git', ['status'], { timeout: 1000 });",
    "const closer = spawnSync('sh', ['-c', 'echo )'], { timeout: 1, killSignal: 'SIGKILL' });",
    "const opener = spawnSync('sh', ['-c', 'echo (']);",
    "const after = spawnSync('sh', ['-c', 'ok'], { timeout: 1, killSignal: 'SIGKILL' });",
    "const found = /https?:\\/\\//.test(url) && spawnSync('a', ['b']).status === 0;",
    "const quoted = /['\"]/.test(url) && spawnSync('c', ['d']).status === 0;",
    "const half = total / 2; const divided = spawnSync('e', ['f']);",
  ].join('\n');
  const code = withoutComments(source);
  const sites = withoutCommentsOrStrings(source);

  const found = [...sites.matchAll(synchronousSpawn)].map((match) => ({
    line: sites.slice(0, match.index).split('\n').length,
    bounded: isBounded(callText(sites, code, match.index)),
  }));

  expect(found).toEqual([
    { line: 4, bounded: false },
    { line: 5, bounded: true },
    { line: 10, bounded: false },
    // A `)` inside a string argument must not truncate the span before the options that bound it.
    { line: 11, bounded: true },
    // A `(` inside a string argument must not run the span into the next call's options, which
    // would let line 13's bound vouch for this unbounded call.
    { line: 12, bounded: false },
    { line: 13, bounded: true },
    // Each of these three calls is only reachable if the regex or the division before it was
    // lexed as what it is.
    { line: 14, bounded: false },
    { line: 15, bounded: false },
    { line: 16, bounded: false },
  ]);
});

test('the guard actually looks at test and scenario files', async () => {
  const files = await scannedFiles();
  expect(files.length).toBeGreaterThan(30);
});

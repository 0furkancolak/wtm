import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publishedReleaseTargets, requiredReleaseTargets } from '../artifact-targets';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tagGuard = "startsWith(github.ref, 'refs/tags/v')";
/** The jobs that build one published target each and upload it for `publish` to collect. */
const verifyJobs = ['verify', 'verify-linux', 'verify-windows'];
/** Verify jobs whose executable is not Apple's to sign, notarize or clear through Gatekeeper. */
const nonAppleVerifyJobs = ['verify-linux', 'verify-windows'];

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  shell?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  strategy?: { matrix?: { include?: { platform: string; arch: string; runner: string }[] } };
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  'continue-on-error'?: boolean | string;
}

interface Workflow {
  on?: unknown;
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

function workflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(`${root}.github/workflows/${name}`, 'utf8')) as Workflow;
}

/** Any job that can write to a repository, a registry or an attestation store must be tag-gated. */
function unguardedWritingJobs(parsed: Workflow): string[] {
  return Object.entries(parsed.jobs ?? {})
    .filter(([, job]) => Object.values(job.permissions ?? {}).includes('write'))
    .filter(([, job]) => !(job.if ?? '').includes(tagGuard))
    .map(([name]) => name);
}

/**
 * `jobs.<job_id>.if` only has `github`, `needs`, `vars` and `inputs` available -- not `matrix`, even
 * though the job uses a matrix strategy (GitHub's context-availability table; `matrix` only becomes
 * readable in fields evaluated per generated job, such as `env`, `runs-on`, `continue-on-error`,
 * `timeout-minutes` and every step field). A job-level `if` that reads `matrix.*` anyway makes the
 * whole workflow file invalid YAML-that-Actions-refuses, breaking every run, not just the intended
 * matrix leg.
 */
function jobIfsReferencingMatrix(parsed: Workflow): string[] {
  return Object.entries(parsed.jobs ?? {})
    .filter(([, job]) => (job.if ?? '').includes('matrix.'))
    .map(([name]) => name);
}

/**
 * The environment a step actually runs with: its own `env:`, plus anything an earlier step in the
 * same job exported through `$GITHUB_ENV`.
 */
function environmentAt(job: WorkflowJob, index: number): Set<string> {
  const names = new Set<string>();
  (job.steps ?? []).slice(0, index + 1).forEach((step, position) => {
    if (position === index) Object.keys(step.env ?? {}).forEach((name) => names.add(name));
    // Both `NAME=value >> $GITHUB_ENV` and the heredoc form `NAME<<DELIMITER` export NAME.
    for (const match of (step.run ?? '').matchAll(/^\s*(?:echo\s+["']?)?([A-Z][A-Z0-9_]*)(?:=|<<)/gmu)) {
      if ((step.run ?? '').includes('GITHUB_ENV')) names.add(match[1] as string);
    }
  });
  return names;
}

function commands(parsed: Workflow): string {
  return Object.values(parsed.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => `${step.uses ?? ''} ${step.run ?? ''}`)
    .join('\n');
}

describe('release workflow', () => {
  test('gives the gate the evidence it refuses to run without', () => {
    // The gate reads its evidence from the environment, and the workflow produces it under a name
    // chosen in a different file. A mismatch is silent: the combined gate saw no smoke results at
    // all and refused a release whose executables had both passed.
    const required = [
      'WTM_RELEASE_SIGNING', 'WTM_RELEASE_SMOKE', 'WTM_RELEASE_PERFORMANCE', 'WTM_RELEASE_NOTARIZATION',
    ];

    const gaps: string[] = [];
    for (const [name, job] of Object.entries(workflow('release.yml').jobs ?? {})) {
      (job.steps ?? []).forEach((step, index) => {
        if (!(step.run ?? '').includes('release:gate')) return;
        const available = environmentAt(job, index);
        for (const variable of required) {
          if (!available.has(variable)) gaps.push(`${name}: ${variable}`);
        }
      });
    }

    expect(gaps).toEqual([]);
  });

  test('builds every published release target, and only targets the catalog can build', () => {
    // The published target table and the workflow are one contract in two files. A target added to
    // `publishedReleaseTargets` with no leg to build it fails every tag at the gate -- which at
    // least is loud -- but a leg building an archive nothing publishes is silent, and that is how
    // a Linux tarball was built by CI for weeks without ever reaching a release.
    const jobs = workflow('release.yml').jobs ?? {};
    const legs = verifyJobs.flatMap((name) => jobs[name]?.strategy?.matrix?.include ?? [])
      .map(({ platform, arch }) => `${platform}/${arch}`);

    expect([...legs].sort()).toEqual(
      publishedReleaseTargets.map(({ platform, arch }) => `${platform}/${arch}`).sort(),
    );
    expect(new Set(legs).size, 'two legs building the same target').toBe(legs.length);
  });

  test('uploads one artifact per leg under a name the publishing job actually downloads', () => {
    // Renaming an upload without its download is the failure this pins: `pattern: wtm-darwin-*`
    // silently matched nothing for a Linux leg, and `publish` would have created a release missing
    // those assets rather than failing.
    const jobs = workflow('release.yml').jobs ?? {};
    const pattern = (jobs.publish?.steps ?? [])
      .find((step) => step.uses?.startsWith('actions/download-artifact'))?.with?.pattern ?? '';
    const glob = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`, 'u');

    for (const name of verifyJobs) {
      const job = jobs[name];
      const upload = (job?.steps ?? []).find((step) => step.uses?.startsWith('actions/upload-artifact'));
      expect(upload?.with?.['if-no-files-found'], name).toBe('error');
      for (const leg of job?.strategy?.matrix?.include ?? []) {
        const rendered = (upload?.with?.name ?? '')
          .replaceAll('${{ matrix.platform }}', leg.platform)
          .replaceAll('${{ matrix.arch }}', leg.arch);
        expect(rendered, name).toBe(`wtm-${leg.platform}-${leg.arch}`);
        expect(glob.test(rendered), `${rendered} is not downloaded by ${pattern}`).toBe(true);
      }
    }
  });

  test('attaches every required archive by name, and the optional Windows one when it exists', () => {
    const steps = workflow('release.yml').jobs?.publish?.steps ?? [];
    const create = steps.find((step) => (step.run ?? '').includes('gh release create'))?.run ?? '';

    for (const { archiveName } of requiredReleaseTargets) {
      expect(create, archiveName).toContain(`dist/release/${archiveName}`);
    }
    // The one target outside `requiredReleaseTargets` must not be a literal, always-attached path
    // -- that would fail the whole release the moment its optional archive does not exist -- so
    // it is attached through a glob expansion instead (`nullglob`'d to drop out cleanly when
    // there is nothing to attach).
    const optional = publishedReleaseTargets.filter(
      (target) => !requiredReleaseTargets.includes(target),
    );
    for (const { archiveName } of optional) {
      expect(create, archiveName).not.toContain(`dist/release/${archiveName}`);
    }
    expect(create).toContain('shopt -s nullglob');
    expect(create).toContain('dist/release/*.zip');
    expect(create).toContain('dist/release/SHA256SUMS');
    // Globbed rather than listed, so provenance covers a new archive the moment a leg produces one.
    const attest = steps.find((step) => (step.uses ?? '').startsWith('actions/attest-build-provenance'));
    expect((attest?.with?.['subject-path'] ?? '').trim().split('\n').map((line) => line.trim())).toEqual([
      'dist/release/*.tar.gz', 'dist/release/*.zip',
    ]);
  });

  test('keeps the Windows leg optional: continue-on-error, and outside requiredReleaseTargets', () => {
    // Both halves of the fix matter: `continue-on-error` (below) is what stops a failed win32 leg
    // from reading as a cancelled workflow; `requiredReleaseTargets` (verify-release.ts) is what
    // actually lets `publish`'s combined gate succeed without a Windows archive. Neither alone is
    // enough -- see the "Windows archive is optional" describe block in verify-release.test.ts.
    const windows = workflow('release.yml').jobs?.['verify-windows'];
    expect(windows?.['continue-on-error']).toBe(true);
    expect(requiredReleaseTargets.some((target) => target.platform === 'win32')).toBe(false);
    expect(publishedReleaseTargets.some((target) => target.platform === 'win32')).toBe(true);
  });

  test('keeps Apple signing, notarization and Gatekeeper on the legs that have them', () => {
    // Signing a Linux ELF or a Windows PE executable is not a step that could work; it is a step
    // that means the workflow no longer knows what it is building. The gate refuses the claim
    // (verify-release.ts), and this refuses the attempt.
    const jobs = workflow('release.yml').jobs ?? {};
    for (const name of nonAppleVerifyJobs) {
      const steps = (jobs[name]?.steps ?? [])
        .map((step) => `${step.run ?? ''} ${Object.values(step.env ?? {}).join(' ')}`).join('\n');

      for (const apple of ['codesign', 'notarytool', 'spctl', 'security ', 'MACOS_', 'xcrun']) {
        expect(steps, `${name} must not run ${apple}`).not.toContain(apple);
      }
      // And it says so to the gate rather than leaving the evidence absent, which is refused.
      const gate = (jobs[name]?.steps ?? []).find((step) => (step.run ?? '').includes('release:gate'));
      expect(gate?.env?.WTM_RELEASE_SIGNING, name).toBe('not-applicable');
      expect(gate?.env?.WTM_RELEASE_NOTARIZATION, name).toBe('not-applicable');
    }
    // The macOS legs still report a real status, which the stable-release rules then decide on.
    const darwinGate = (jobs.verify?.steps ?? []).find((step) => (step.run ?? '').includes('release:gate'));
    expect(darwinGate?.env?.WTM_RELEASE_SIGNING).toBe('${{ steps.sign.outputs.signing }}');
    expect(darwinGate?.env?.WTM_RELEASE_NOTARIZATION).toBe('${{ steps.notarize.outputs.notarization }}');
  });

  test('gates each leg against its own archive by platform and architecture', () => {
    // Two published targets share each architecture, so an arch-only `WTM_RELEASE_ARCH` would
    // resolve a Linux leg to the darwin archive name and fail a build that did nothing wrong.
    const jobs = workflow('release.yml').jobs ?? {};
    for (const name of verifyJobs) {
      const gate = (jobs[name]?.steps ?? []).find((step) => (step.run ?? '').includes('release:gate'));
      expect(gate?.env?.WTM_RELEASE_PLATFORM, name).toBe('${{ matrix.platform }}');
      expect(gate?.env?.WTM_RELEASE_ARCH, name).toBe('${{ matrix.arch }}');
    }
    // The combined gate names neither, which is how it asks for the whole release.
    const combined = (jobs.publish?.steps ?? []).find((step) => (step.run ?? '').includes('release:gate'));
    expect(combined?.env?.WTM_RELEASE_PLATFORM).toBeUndefined();
    expect(combined?.env?.WTM_RELEASE_ARCH).toBeUndefined();
  });

  test('waits for every verify job before publishing', () => {
    const jobs = workflow('release.yml').jobs ?? {};
    const needs = jobs.publish?.needs ?? [];

    expect([...(typeof needs === 'string' ? [needs] : needs)].sort()).toEqual([...verifyJobs].sort());
  });

  test('publishes only for version tags', () => {
    const release = workflow('release.yml');

    expect(release.on).toEqual({ push: { tags: ['v*'] } });
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(unguardedWritingJobs(release)).toEqual([]);
    for (const job of Object.values(release.jobs ?? {})) {
      expect(job.if).toContain(tagGuard);
    }
  });

  test('rejects a writing job that is not tag-gated', () => {
    const unguarded: Workflow = {
      jobs: {
        safe: { if: `\${{ ${tagGuard} }}`, permissions: { contents: 'write' } },
        leaky: { permissions: { contents: 'write' } },
      },
    };

    expect(unguardedWritingJobs(unguarded)).toEqual(['leaky']);
  });

  test('grants each publication capability to exactly the job that needs it', () => {
    const jobs = workflow('release.yml').jobs ?? {};

    expect(jobs.verify?.permissions).toEqual({ contents: 'read' });
    expect(jobs.publish?.permissions)
      .toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' });
    expect(jobs.formula?.permissions).toEqual({ contents: 'read' });
  });

  test('does not retract a published release when the npm channel fails', () => {
    const steps = workflow('release.yml').jobs?.publish?.steps ?? [];
    const releaseIndex = steps.findIndex((step) => (step.run ?? '').includes('gh release create'));
    const npmIndex = steps.findIndex((step) => (step.run ?? '').includes('npm publish'));

    // The archives go out first, so by the time npm runs the release already stands on its own.
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(npmIndex).toBeGreaterThan(releaseIndex);

    // Neither a missing credential nor a rejected one may fail the job behind that release: the
    // token expires, and an expired token must not read as a broken build.
    const publishStep = (steps[npmIndex]?.run ?? '').replace(/\\\n\s*/gu, ' ');
    expect(publishStep).toContain('exit 0');
    expect(publishStep).toMatch(/npm publish .*\|\| echo/u);
  });

  test('keeps every publishing command out of the untagged workflows', () => {
    const published = ['npm publish', 'gh release create', 'actions/attest', 'git -C tap push'];

    // performance.yml no longer exists: its release-budgets job folded into release.yml's verify
    // job (todo item 4), so the numbers it measures can actually gate a release instead of running
    // in a workflow nothing downstream ever looked at.
    for (const name of ['ci.yml']) {
      const untagged = commands(workflow(name));
      for (const command of published) expect(untagged).not.toContain(command);
    }
    const release = commands(workflow('release.yml'));
    for (const command of published) expect(release).toContain(command);
  });

  test('proves the standalone executable in ordinary CI without releasing it', () => {
    expect(commands(workflow('ci.yml'))).toContain('bun run binary:verify');
  });

  test('Linux ARM64 runs the full native gate and both Linux architectures inspect the produced SEA archive', () => {
    const job = workflow('ci.yml').jobs?.validate;
    expect(job?.strategy?.matrix?.include).toContainEqual({ platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm' });
    const steps = job?.steps ?? [];
    // Set-up steps and lint/typecheck are skipped only on a non-win32 leg during a win32_test_filter
    // run (they'd otherwise waste runner time on a leg the run doesn't care about); on Linux, on
    // every other trigger, and on win32 itself they still run.
    const nonWin32DuringFilter = "!(env.CI_WIN32_FILTER_RUN == 'true' && matrix.platform != 'win32')";
    for (const command of ['bun install --frozen-lockfile', 'bun run lint', 'bun run typecheck']) {
      const step = steps.find((item) => item.name === command || item.run?.startsWith(command));
      expect(step, command).toBeDefined();
      expect(step?.if, command).toBe(nonWin32DuringFilter);
    }
    // The full-suite-only steps are skipped on every leg (not just win32) for a targeted
    // win32_test_filter run: the non-win32 legs never installed bun above to run them, and win32's
    // own targeted `bun test` step already covers the evidence being asked for.
    const filterActive = "env.CI_WIN32_FILTER_RUN != 'true'";
    for (const command of ['bun run test --timeout', 'bun run test:e2e', 'bun run build',
      'bun run package:verify', 'bun run binary:verify']) {
      const step = steps.find((item) => item.run?.startsWith(command));
      expect(step, command).toBeDefined();
      expect(step?.if, command).toBe(filterActive);
    }
    const archive = steps.findIndex((item) => item.run === 'bun scripts/__tests__/release-artifacts-native.scenario.ts dist/sea/wtm');
    expect(archive).toBeGreaterThan(steps.findIndex((item) => item.run?.startsWith('bun run binary:verify')));
    expect(steps[archive]?.if).toBe("matrix.platform == 'linux' && env.CI_WIN32_FILTER_RUN != 'true'");
  });

  test('validates each commit once and keeps win32 from deciding the run until item 9', () => {
    const ci = workflow('ci.yml') as Workflow & { concurrency?: { group?: string; 'cancel-in-progress'?: string } };
    // Pinned exactly, not partially: a later `pull_request_target:` or `schedule:` trigger would
    // change who can run this workflow and with what token, and must not slip in unnoticed.
    expect(ci.on).toEqual({
      push: { branches: ['main'] },
      pull_request: null,
      workflow_dispatch: { inputs: { win32_test_filter: {
        description: expect.stringContaining('bun test') as unknown as string,
        required: false, default: '', type: 'string',
      } } },
    });
    expect(ci.concurrency?.group).toContain('github.event.pull_request.number');
    expect(ci.concurrency?.['cancel-in-progress']).toBe("${{ github.ref != 'refs/heads/main' }}");

    const job = workflow('ci.yml').jobs?.validate as WorkflowJob & { 'continue-on-error'?: string; 'timeout-minutes'?: string };
    // win32 stays informational until todo item 9 -- except on a filter run, which exists precisely
    // to make a targeted group of Windows test files decide the result.
    expect(job['continue-on-error']?.replace(/\s+/gu, ' ')).toBe(
      "${{ matrix.platform == 'win32' && !(github.event_name == 'workflow_dispatch' && inputs.win32_test_filter != '') }}",
    );
    expect(job['timeout-minutes']).toBe("${{ matrix.platform == 'win32' && 25 || 30 }}");
    expect(job.strategy?.matrix?.include).toContainEqual({ platform: 'win32', arch: 'x64', runner: 'windows-latest' });

    // `continue-on-error` is only half of "informational". It absorbs a job that failed; a job that
    // reaches `timeout-minutes` is cancelled, and a cancelled job reported every run on this
    // repository as `cancelled` however green the four deciding legs were. The whole-run budget is
    // the other half: the leg has to end itself, inside the cap, so its failure is one
    // `continue-on-error` can absorb. Pinned as an inequality rather than a literal so the two
    // numbers cannot drift apart silently -- raising the cap is fine, a budget at or above it is
    // the bug coming back.
    const testStep = (job.steps ?? []).find((step) => step.run?.startsWith('bun run test --timeout'));
    const budgetMs = Number(/--budget (\d+)/u.exec(testStep?.run ?? '')?.[1]);
    expect(testStep?.run, 'the budget must apply to win32 only').toContain("matrix.platform == 'win32' && ' --budget");
    expect(budgetMs).toBeGreaterThan(0);
    expect(budgetMs).toBeLessThan(25 * 60 * 1000);
  });

  test('accepts an optional win32_test_filter input, defaulting to the full suite on every leg', () => {
    type DispatchOn = { on?: { workflow_dispatch?: { inputs?: Record<string, { description?: string; required?: boolean; default?: string; type?: string }> } } };
    const ci = workflow('ci.yml') as DispatchOn;
    const input = ci.on?.workflow_dispatch?.inputs?.win32_test_filter;

    expect(input).toBeDefined();
    expect(input?.type).toBe('string');
    expect(input?.required).toBe(false);
    expect(input?.default).toBe('');
    expect(input?.description ?? '').toContain('bun test');
  });

  test('never gates the validate job on matrix.* in jobs.<job_id>.if (GitHub Actions does not expose matrix there)', () => {
    // Regression test: an earlier version of this workflow used a job-level
    // `if: ... || matrix.platform == 'win32'` to narrow a win32_test_filter run to the win32 leg.
    // `jobs.<job_id>.if` only has github/needs/vars/inputs available, not matrix, so that expression
    // made the whole workflow file invalid and would have broken CI on every push and pull_request.
    // release.yml has a matrix job carrying a job-level `if` too, so it can hit the same footgun.
    for (const name of ['ci.yml', 'release.yml']) expect(jobIfsReferencingMatrix(workflow(name))).toEqual([]);
    expect(workflow('ci.yml').jobs?.validate?.if).toBeUndefined();
  });

  test('rejects a job whose if references matrix', () => {
    const invalid: Workflow = {
      jobs: {
        safe: { if: "github.event_name == 'workflow_dispatch'" },
        broken: { if: "matrix.platform == 'win32'" },
      },
    };

    expect(jobIfsReferencingMatrix(invalid)).toEqual(['broken']);
  });

  test('computes a job-wide env flag for a win32_test_filter run from github/inputs only', () => {
    // `env:` (unlike job-level `if:`) does have `matrix` available, but this flag deliberately does
    // not read it: it is the same for every leg, and each step below combines it with its own
    // `matrix.platform` check instead, keeping the matrix-dependent part at step level where GitHub
    // Actions actually allows it.
    const job = workflow('ci.yml').jobs?.validate;
    expect(job?.env?.CI_WIN32_FILTER_RUN).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.win32_test_filter != '' }}");
  });

  test('narrows a workflow_dispatch run with a win32_test_filter to the win32 leg alone', () => {
    const steps = workflow('ci.yml').jobs?.validate?.steps ?? [];

    // The non-win32 legs skip every step after checkout (an explicit skip-announcement step, then
    // setup and the full gate) instead of the whole job being skipped, since job-level `if` cannot
    // read `matrix`; they still succeed, just with those steps reported as skipped.
    const checkout = steps.findIndex((step) => step.uses === 'actions/checkout@v4');
    expect(checkout).toBe(0);
    const skipStep = steps.find((step) => step.name === 'Skip (win32_test_filter run only exercises the win32 leg)');
    expect(skipStep?.if).toBe("env.CI_WIN32_FILTER_RUN == 'true' && matrix.platform != 'win32'");
    expect(steps.indexOf(skipStep as WorkflowStep)).toBe(checkout + 1);
  });

  test('runs the win32 filter through env, never by interpolating inputs. directly into a run: script', () => {
    const steps = workflow('ci.yml').jobs?.validate?.steps ?? [];
    const filterStep = steps.find((step) => step.name === 'win32 targeted test filter');

    expect(filterStep).toBeDefined();
    expect(filterStep?.if).toBe("env.CI_WIN32_FILTER_RUN == 'true' && matrix.platform == 'win32'");
    expect(filterStep?.shell).toBe('bash');
    expect(filterStep?.env?.WIN32_TEST_FILTER).toBe('${{ inputs.win32_test_filter }}');

    // Every `run:` script in the workflow (not just this step) must read the filter from the
    // environment rather than splicing `${{ inputs.win32_test_filter }}` straight into shell text --
    // an attacker-controlled workflow_dispatch input landing directly in a script is a classic
    // script-injection vector.
    for (const step of steps) {
      expect(step.run ?? '').not.toContain('inputs.win32_test_filter');
    }

    expect(filterStep?.run ?? '').toContain('$WIN32_TEST_FILTER');
    expect(filterStep?.run ?? '').toContain('bun test --max-concurrency=1 --parallel=1 --timeout 300000');
    // Validated in shell before use: only path-ish characters and spaces are allowed through.
    expect(filterStep?.run ?? '').toMatch(/\[\[ ! "\$WIN32_TEST_FILTER" =~ .*\]\]/u);
  });
});

/**
 * The keys defined twice within one mapping. `Bun.YAML.parse` keeps the last value and says
 * nothing, but GitHub refuses the whole file: a doubled `if-no-files-found` in `release.yml` made
 * every push report "workflow file issue", and no tag could publish anything.
 */
function duplicateKeys(source: string): string[] {
  const duplicates: string[] = [];
  const scopes: Array<{ indent: number; keys: Set<string> }> = [];
  let scalarIndent: number | null = null;
  source.split('\n').forEach((line, index) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const indent = line.length - line.trimStart().length;
    if (scalarIndent !== null) {
      if (indent > scalarIndent) return;
      scalarIndent = null;
    }
    const match = /^(\s*)(- )?([A-Za-z0-9_.-]+):(?:\s|$)(.*)$/u.exec(line);
    if (match === null) return;
    // A sequence item opens a new mapping whose keys sit two columns further in.
    const keyIndent = indent + (match[2] === undefined ? 0 : 2);
    while (scopes.length > 0 && (scopes.at(-1)!.indent > keyIndent
      || (match[2] !== undefined && scopes.at(-1)!.indent === keyIndent))) scopes.pop();
    if (scopes.at(-1)?.indent !== keyIndent) scopes.push({ indent: keyIndent, keys: new Set() });
    const scope = scopes.at(-1)!;
    if (scope.keys.has(match[3]!)) duplicates.push(`line ${index + 1}: ${match[3]}`);
    scope.keys.add(match[3]!);
    if (/^[|>][-+]?\s*$/u.test(match[4] ?? '')) scalarIndent = keyIndent;
  });
  return duplicates;
}

describe('workflow files', () => {
  test('define no key twice in one mapping', () => {
    for (const name of ['ci.yml', 'release.yml']) {
      expect({ name, duplicates: duplicateKeys(readFileSync(`${root}.github/workflows/${name}`, 'utf8')) })
        .toEqual({ name, duplicates: [] });
    }
  });

  test('the duplicate-key check finds a doubled key and passes distinct siblings', () => {
    const doubled = 'jobs:\n  a:\n    steps:\n      - uses: x\n        with:\n          name: n\n          name: m\n';
    const siblings = 'jobs:\n  a:\n    steps:\n      - run: |\n          name: n\n          name: n\n      - name: one\n      - name: two\n';
    expect(duplicateKeys(doubled)).toEqual(['line 7: name']);
    expect(duplicateKeys(siblings)).toEqual([]);
  });
});

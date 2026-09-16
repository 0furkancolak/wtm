import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tagGuard = "startsWith(github.ref, 'refs/tags/v')";

interface WorkflowStep {
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  shell?: string;
}

interface WorkflowJob {
  strategy?: { matrix?: { include?: { platform: string; arch: string; runner: string }[] } };
  if?: string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
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
    // Only the win32 leg's own workflow_dispatch filter can skip these, so an unconditional find on
    // any other command still proves the Linux legs (and everything but a filtered win32 run) get
    // the full gate.
    for (const command of ['bun run lint', 'bun run typecheck']) {
      const step = steps.find((item) => item.run?.startsWith(command));
      expect(step, command).toBeDefined();
      expect(step?.if, command).toBeUndefined();
    }
    // The full-suite-only steps are skipped for a targeted win32_test_filter run, so on every other
    // leg and every non-dispatch trigger they still carry that guard, not no condition at all.
    const filterGuard = "!(github.event_name == 'workflow_dispatch' && matrix.platform == 'win32' && inputs.win32_test_filter != '')";
    for (const command of ['bun run test --timeout', 'bun run test:e2e', 'bun run build',
      'bun run package:verify', 'bun run binary:verify']) {
      const step = steps.find((item) => item.run?.startsWith(command));
      expect(step, command).toBeDefined();
      expect(step?.if, command).toBe(filterGuard);
    }
    const archive = steps.findIndex((item) => item.run === 'bun scripts/__tests__/release-artifacts-native.scenario.ts dist/sea/wtm');
    expect(archive).toBeGreaterThan(steps.findIndex((item) => item.run?.startsWith('bun run binary:verify')));
    expect(steps[archive]?.if).toBe("matrix.platform == 'linux'");
  });

  test('validates each commit once and keeps win32 from deciding the run until item 9', () => {
    const ci = workflow('ci.yml') as Workflow & { concurrency?: { group?: string; 'cancel-in-progress'?: string } };
    expect(ci.on).toMatchObject({ push: { branches: ['main'] }, pull_request: null });
    expect(ci.concurrency?.group).toContain('github.event.pull_request.number');
    expect(ci.concurrency?.['cancel-in-progress']).toBe("${{ github.ref != 'refs/heads/main' }}");

    const job = workflow('ci.yml').jobs?.validate as WorkflowJob & { 'continue-on-error'?: string; 'timeout-minutes'?: string };
    expect(job['continue-on-error']).toBe("${{ matrix.platform == 'win32' }}");
    expect(job['timeout-minutes']).toBe("${{ matrix.platform == 'win32' && 25 || 30 }}");
    expect(job.strategy?.matrix?.include).toContainEqual({ platform: 'win32', arch: 'x64', runner: 'windows-latest' });
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

  test('narrows a workflow_dispatch run with a win32_test_filter to the win32 leg alone', () => {
    const job = workflow('ci.yml').jobs?.validate;

    // A job-level `if` is evaluated per matrix combination, so this single condition both keeps the
    // four non-win32 legs (and every push/pull_request run) unaffected and skips them outright when
    // someone dispatches a filtered win32-only run.
    expect(job?.if).toBe("github.event_name != 'workflow_dispatch' || inputs.win32_test_filter == '' || matrix.platform == 'win32'");
  });

  test('runs the win32 filter through env, never by interpolating inputs. directly into a run: script', () => {
    const steps = workflow('ci.yml').jobs?.validate?.steps ?? [];
    const filterStep = steps.find((step) => step.name === 'win32 targeted test filter');

    expect(filterStep).toBeDefined();
    expect(filterStep?.if).toBe("github.event_name == 'workflow_dispatch' && matrix.platform == 'win32' && inputs.win32_test_filter != ''");
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

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tagGuard = "startsWith(github.ref, 'refs/tags/v')";

interface WorkflowStep {
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
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
    const required = ['WTM_RELEASE_SIGNING', 'WTM_RELEASE_SMOKE'];

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

  test('keeps every publishing command out of the untagged workflows', () => {
    const published = ['npm publish', 'gh release create', 'actions/attest', 'git -C tap push'];

    for (const name of ['ci.yml', 'performance.yml']) {
      const untagged = commands(workflow(name));
      for (const command of published) expect(untagged).not.toContain(command);
    }
    const release = commands(workflow('release.yml'));
    for (const command of published) expect(release).toContain(command);
  });

  test('proves the standalone executable in ordinary CI without releasing it', () => {
    expect(commands(workflow('ci.yml'))).toContain('bun run binary:verify');
  });
});

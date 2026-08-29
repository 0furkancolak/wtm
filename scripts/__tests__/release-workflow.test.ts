import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tagGuard = "startsWith(github.ref, 'refs/tags/v')";

interface WorkflowJob {
  if?: string;
  permissions?: Record<string, string>;
  steps?: Array<{ run?: string; uses?: string }>;
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

function commands(parsed: Workflow): string {
  return Object.values(parsed.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => `${step.uses ?? ''} ${step.run ?? ''}`)
    .join('\n');
}

describe('release workflow', () => {
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

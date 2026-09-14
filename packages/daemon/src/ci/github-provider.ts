import { z } from 'zod';
import type { CiProvider, CiProviderFailure, CiProviderResult, CiRepository } from '@wtm/core';
import type { CiJob, CiRun } from '@wtm/protocol';
import type { GhCommandResult, GhCommandRunner } from './gh-runner';

const runListSchema = z.array(z.object({
  databaseId: z.number().int().nonnegative(),
  workflowName: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string(),
}).passthrough());

const jobListSchema = z.object({
  jobs: z.array(z.object({
    databaseId: z.number().int().nonnegative(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    url: z.string(),
  }).passthrough()),
}).passthrough();

const firstLine = (text: string) => text.trim().split('\n')[0]?.slice(0, 300) ?? '';

/** `output` is what gets classified: stderr by default; `checkAvailable` passes stdout too. */
function classify(result: GhCommandResult, output: string = result.stderr): CiProviderFailure {
  const stderr = output;
  const detail = firstLine(stderr) || `gh exited with ${result.exitCode ?? result.outcome}`;
  if (result.outcome === 'not-found') return { kind: 'unavailable', reason: 'missing', detail: 'The GitHub CLI (gh) was not found.' };
  if (result.outcome === 'timeout') return { kind: 'transient', detail: 'gh did not answer within 30 seconds.' };
  if (/rate limit|HTTP 429/i.test(stderr)) return { kind: 'throttled', detail };
  if (/HTTP 5\d\d|timeout|timed out|connection|EOF|TLS|network/i.test(stderr)) return { kind: 'transient', detail };
  if (/HTTP 401|not logged in|auth login|authentication|Bad credentials|token .*invalid|invalid token|not logged into/i.test(stderr)) return { kind: 'unavailable', reason: 'unauthenticated', detail };
  if (/HTTP 404|Could not resolve to a Repository|not found/i.test(stderr)) return { kind: 'unavailable', reason: 'not-found', detail };
  return { kind: 'transient', detail };
}

function parsed<T>(result: GhCommandResult, parse: (stdout: string) => T | null): CiProviderResult<T> {
  if (result.outcome !== 'success') return { ok: false, failure: classify(result) };
  try {
    const value = parse(result.stdout);
    if (value !== null) return { ok: true, value };
  } catch {
    // Fall through: output that is not what this version of gh is expected to print.
  }
  return { ok: false, failure: { kind: 'transient', detail: 'gh printed unexpected output.' } };
}

export function createGitHubProvider(run: GhCommandRunner): CiProvider {
  return {
    name: 'github',

    async checkAvailable(repository: CiRepository) {
      const result = await run(['auth', 'status', '--hostname', repository.host]);
      if (result.outcome === 'success') return { ok: true, value: null };
      // gh >= 2.40 prints its per-account report, including "The token in keyring is invalid.",
      // on stdout with exit 1 and nothing on stderr, so both streams are classified here.
      return { ok: false, failure: classify(result, `${result.stderr}\n${result.stdout}`) };
    },

    async listRuns(repository, headSha) {
      const result = await run(['run', 'list', '--repo', repository.slug, '--commit', headSha, '--limit', '50', '--json', 'databaseId,workflowName,event,status,conclusion,url']);
      return parsed(result, (stdout): CiRun[] | null => {
        const runs = runListSchema.safeParse(JSON.parse(stdout));
        return runs.success ? runs.data.map((entry) => ({
          runId: entry.databaseId, workflow: entry.workflowName, event: entry.event, status: entry.status,
          conclusion: entry.conclusion === '' ? null : entry.conclusion, url: entry.url, jobs: [],
        })) : null;
      });
    },

    async listJobs(repository, runId) {
      const result = await run(['run', 'view', String(runId), '--repo', repository.slug, '--json', 'jobs']);
      return parsed(result, (stdout): CiJob[] | null => {
        const jobs = jobListSchema.safeParse(JSON.parse(stdout));
        return jobs.success ? jobs.data.jobs.map((job) => ({
          jobId: job.databaseId, name: job.name, status: job.status,
          conclusion: job.conclusion === '' ? null : job.conclusion, url: job.url,
        })) : null;
      });
    },

    async failedJobLog(repository, runId, jobId) {
      const result = await run(['run', 'view', String(runId), '--repo', repository.slug, '--job', String(jobId), '--log-failed']);
      return parsed(result, (stdout) => stdout);
    },
  };
}

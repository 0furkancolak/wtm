import type { CiJob, CiRun, PrSummary } from '@wtm/protocol';
import type { CiRepository } from './remote';

/** The facts a provider itself knows about a PR. `checks` is left to the caller, which already
 * has to call `listRuns` separately for its own display and would otherwise duplicate that call. */
export type PrLookup = Omit<PrSummary, 'checks'>;

/**
 * Why a provider call did not answer. `unavailable` counts toward the watch's failure streak;
 * `throttled` and `transient` only delay the next poll.
 */
export type CiProviderFailure =
  | { kind: 'unavailable'; reason: 'missing' | 'unauthenticated' | 'not-found' | 'forbidden'; detail: string }
  | { kind: 'throttled'; detail: string }
  | { kind: 'transient'; detail: string };

export type CiProviderResult<T> = { ok: true; value: T } | { ok: false; failure: CiProviderFailure };

/** A CI source. Core defines it; a provider that talks to a real service lives outside core. */
export interface CiProvider {
  readonly name: string;
  checkAvailable(repository: CiRepository): Promise<CiProviderResult<null>>;
  /** Every run of `headSha`, whatever its event, with `jobs: []`. */
  listRuns(repository: CiRepository, headSha: string): Promise<CiProviderResult<CiRun[]>>;
  listJobs(repository: CiRepository, runId: number): Promise<CiProviderResult<CiJob[]>>;
  /** The raw failed-step log of one job. */
  failedJobLog(repository: CiRepository, runId: number, jobId: number): Promise<CiProviderResult<string>>;
  /** The open/closed/merged PR for `branch`, or `null` when it has none. */
  findPr(repository: CiRepository, branch: string): Promise<CiProviderResult<PrLookup | null>>;
}

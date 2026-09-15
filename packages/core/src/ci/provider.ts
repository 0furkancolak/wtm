import type { CiJob, CiRun } from '@wtm/protocol';
import type { CiRepository } from './remote';

/**
 * Why a provider call did not answer. `unavailable` counts toward the watch's failure streak;
 * `throttled` and `transient` only delay the next poll.
 */
export type CiProviderFailure =
  | { kind: 'unavailable'; reason: 'missing' | 'unauthenticated' | 'not-found'; detail: string }
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
}

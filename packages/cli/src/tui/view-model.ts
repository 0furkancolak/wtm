import type { WtmError } from '@wtm/protocol';
import type { DiagnosticCommandEnvelope, DoctorDiagnostic, StatusDiagnostic } from '../diagnostics';
import type { TuiResourcesView } from './resources-view';

/**
 * The pure data-aggregation step of `wtm tui`.
 *
 * `wtm status --json` and `wtm doctor --json` already produce everything the dashboard shows —
 * identity, endpoints, processes, resources and deterministic health findings — through the same
 * stable envelope every other reader of `--json` gets. This module only reshapes those two
 * envelopes into the flat, TUI-shaped view a renderer can draw without knowing anything about the
 * envelope contract, `DiagnosticCommandInput` scoping or how many workspaces were asked for.
 *
 * It takes zero worktrees, not one, out of scope: both commands answer for the single worktree
 * containing the directory `wtm tui` was started in (or the one a `[selector]` names), which is
 * the same default-scoping rule every other WTM command already follows (`docs/04`, "General
 * scoping rule"). See `packages/cli/src/tui/loop.ts` for why a live dashboard does not attempt to
 * enumerate every worktree of a workspace in one shot.
 */

export interface TuiWorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly scope: 'local' | 'global-only';
}

export interface TuiWorktreeView {
  readonly branch: string | null;
  readonly path: string;
  readonly state: string;
  readonly isMain: boolean;
  readonly headOid: string | null;
  readonly worktreeId: string | null;
  readonly numericId: number | null;
}

export interface TuiProcessView {
  readonly task: string;
  readonly pid: number | null;
  readonly state: string;
  readonly startedAt: string | null;
}

export interface TuiPortView {
  readonly name: string;
  readonly protocol: string;
  readonly host: string;
  readonly port: number;
  readonly state: string;
}

export interface TuiHealthView {
  readonly check: string;
  readonly status: string;
  readonly message: string;
}

/**
 * Everything one frame of the dashboard needs, and nothing it would have to reach back into an
 * envelope or a data source to find. Adding a panel (disk usage, cleanup candidates, a log tail —
 * the two later TUI units) means adding a field here and a reader of it in `render.ts`, never
 * touching how this is built or how often it refreshes.
 */
export interface TuiViewModel {
  readonly fetchedAt: string;
  readonly workspace: TuiWorkspaceView | null;
  readonly worktree: TuiWorktreeView | null;
  readonly processes: readonly TuiProcessView[];
  readonly ports: readonly TuiPortView[];
  readonly health: readonly TuiHealthView[];
  /** Envelope-level errors from `status`, surfaced verbatim rather than swallowed. */
  readonly statusErrors: readonly WtmError[];
  /** Envelope-level errors from `doctor`, surfaced verbatim rather than swallowed. */
  readonly doctorErrors: readonly WtmError[];
  /**
   * The disk-usage / cleanup-candidate panel's own data (unit 2). `null` until the first resource
   * fetch completes, or when one has not been wired in at all (e.g. a test exercising only
   * status/doctor). Unlike every field above, this is not rebuilt on every poll — see `loop.ts` for
   * why disk/GC-plan assembly refreshes on a slower cadence than `status`/`doctor`'s SQLite reads.
   */
  readonly resources: TuiResourcesView | null;
}

export interface TuiSnapshot {
  readonly statusEnvelope: DiagnosticCommandEnvelope<StatusDiagnostic>;
  readonly doctorEnvelope: DiagnosticCommandEnvelope<DoctorDiagnostic>;
  /** ISO timestamp of this poll, supplied by the caller so the view model stays deterministic. */
  readonly fetchedAt: string;
  /** The last resources view built by `buildTuiResourcesView`, carried over between polls. */
  readonly resources?: TuiResourcesView | null;
}

export function buildTuiViewModel(snapshot: TuiSnapshot): TuiViewModel {
  const status = snapshot.statusEnvelope.data.workspaces[0];
  const doctor = snapshot.doctorEnvelope.data.workspaces[0];
  const workspaceRecord = status?.workspace ?? doctor?.workspace;

  return {
    fetchedAt: snapshot.fetchedAt,
    workspace: workspaceRecord === undefined ? null : { ...workspaceRecord },
    worktree: status === undefined ? null : {
      branch: status.identity.branch,
      path: status.identity.path,
      state: status.state,
      isMain: status.identity.isMain,
      headOid: status.identity.headOid,
      worktreeId: status.identity.worktreeId,
      numericId: status.identity.numericId,
    },
    processes: status === undefined ? [] : status.processes.map((process) => ({
      task: process.task,
      pid: process.pid,
      state: process.state,
      startedAt: process.startedAt,
    })),
    ports: status === undefined ? [] : status.endpoints.map((endpoint) => ({
      name: endpoint.name,
      protocol: endpoint.protocol,
      host: endpoint.host,
      port: endpoint.port,
      state: endpoint.state,
    })),
    health: doctor === undefined ? [] : doctor.findings.map((finding) => ({
      check: finding.check,
      status: finding.status,
      message: finding.message,
    })),
    statusErrors: snapshot.statusEnvelope.errors,
    doctorErrors: snapshot.doctorEnvelope.errors,
    resources: snapshot.resources ?? null,
  };
}
